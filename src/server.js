// server.js - JSON-only API: upload an STL + slicing settings, get weight, print time, size and volume back.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readStl, prepare } = require('./stl');
const { sliceStl, slicerAvailable } = require('./slicer');
const { estimate, rawEstimate, recordSample } = require('./estimator');
const profiles = require('./profiles');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || '';           // optional: if set, clients must send header x-api-key
const MAX_TRIANGLES = 500000;
// One OrcaSlicer template per material (printer, process and that material's filament profile)
const tpl = name => path.join(__dirname, '..', 'templates', name + '_standard.3mf');
const MATERIALS = {
  PLA:  { tpl: tpl('PLA') },
  PETG: { tpl: tpl('PETG') },
  ABS:  { tpl: tpl('ABS') },
};
const INFILLS = [10, 15, 20, 30, 40, 50, 60, 70, 80, 90];
const QUALITY = { standard: 0.2, medium: 0.15, high: 0.1 }; // layer height in mm
const STRENGTH = { light: 2, standard: 3, strong: 5 };
const ROTS = [0, 90, 180, 270];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-'));
const upload = multer({ dest: tmpDir, limits: { fileSize: 50 * 1024 * 1024 } });
const app = express();

const given = v => v !== undefined && v !== '';

function parseOptions(body) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const scale = num(body.scale, 1);
  if (!(scale >= 0.01 && scale <= 100)) return { error: 'scale must be between 0.01 and 100' };
  const infill = num(body.infill, 15);
  if (!INFILLS.includes(infill)) return { error: 'infill must be one of ' + INFILLS.join(', ') };
  const material = String(body.material || 'PLA').toUpperCase();
  const printer = String(body.printer || '').trim();
  if (!printer && !MATERIALS[material]) return { error: 'material must be one of ' + Object.keys(MATERIALS).join(', ') + ' (or choose a printer to use other materials)' };
  const q = String(body.quality || 'standard').toLowerCase();
  const quality = QUALITY[q] ? q : Object.keys(QUALITY).find(k => QUALITY[k] === Number(q));
  if (!quality) return { error: 'quality must be standard (0.2 mm), medium (0.15 mm) or high (0.1 mm)' };
  const layerHeight = QUALITY[quality];
  const strength = body.strength || 'standard';
  if (!STRENGTH[strength]) return { error: 'strength must be light, standard or strong' };
  const rot = ['rotX', 'rotY', 'rotZ'].map(k => num(body[k], 0));
  if (rot.some(v => !ROTS.includes(v))) return { error: 'rotX/rotY/rotZ must be 0, 90, 180 or 270' };
  const mode = String(body.mode || 'auto');
  if (!['auto', 'exact', 'estimate'].includes(mode)) return { error: 'mode must be auto, exact or estimate' };
  const bool = v => v === true || v === 'true' || v === '1' || v === 1;
  return { scale, infill, material, printer, process: String(body.process || '').trim(), filament: String(body.filament || '').trim(), quality, layerHeight, strength, walls: STRENGTH[strength], rot, mode, supports: bool(body.supports), gcode: bool(body.gcode), qualityGiven: given(body.quality),
    infillGiven: given(body.infill), strengthGiven: given(body.strength), supportsGiven: given(body.supports) };
}

// one slice at a time: OrcaSlicer is heavy, extra requests simply wait their turn
let chain = Promise.resolve();
const enqueue = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
const cache = new Map(); // file hash + options -> slicer stats 

app.use((req, res, next) => {
  if (API_KEY && req.path !== '/health' && req.get('x-api-key') !== API_KEY) return res.status(401).json({ error: 'Missing or wrong x-api-key' });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, slicer: slicerAvailable() }));

// Orca's own printers, and what each one supports
app.get('/api/printers', (req, res) => {
  if (!profiles.available()) return res.status(503).json({ error: 'OrcaSlicer profiles are not installed in this environment' });
  const list = profiles.listPrinters({ vendor: req.query.vendor, q: req.query.q });
  res.json({ count: list.length, printers: list });
});
app.get('/api/options', (req, res) => {
  if (!profiles.available()) return res.status(503).json({ error: 'OrcaSlicer profiles are not installed in this environment' });
  const m = profiles.getMachine(req.query.printer);
  if (!m) return res.status(404).json({ error: 'Unknown printer. List them with GET /api/printers?q=...' });
  const mat = req.query.material;
  res.json({
    printer: m.name,
    defaultProcess: (profiles.pickProcess(m) || {}).name || null,
    materials: profiles.materials(m),
    processes: profiles.listProcesses(m).map(e => e.name).sort(),
    filaments: profiles.listFilaments(m, mat).map(e => ({ name: e.name, material: String(profiles.resolved(e).filament_type || '') })).sort((a, b) => a.name.localeCompare(b.name)),
  });
});

// POST /api/quote   multipart/form-data: model=<file.stl> + optional slicing settings (see README)
app.post('/api/quote', upload.single('model'), async (req, res) => {
  const file = req.file && req.file.path;
  const cleanup = () => file && fs.rm(file, { force: true }, () => {});
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (form field name must be "model")' });
    if (!/\.stl$/i.test(req.file.originalname)) return res.status(400).json({ error: 'Only .stl files are supported' });
    const opts = parseOptions(req.body);
    if (opts.error) return res.status(400).json({ error: opts.error });

    let m, hash;
    try {
      hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const tris = readStl(file);
      if (tris.length > MAX_TRIANGLES) throw new Error('model has too many triangles');
      m = prepare(tris, opts.scale, opts.rot);
    } catch (e) { return res.status(400).json({ error: 'Could not read STL: ' + e.message }); }

    // optional: slice with any printer / process / filament from OrcaSlicer's own profile library
    let profile = null, used;
    if (opts.printer) {
      if (!profiles.available()) return res.status(503).json({ error: 'OrcaSlicer profiles are not installed in this environment' });
      const machine = profiles.getMachine(opts.printer);
      if (!machine) return res.status(400).json({ error: `Unknown printer "${opts.printer}". List them with GET /api/printers?q=...` });
      const proc = profiles.pickProcess(machine, opts.process);
      if (!proc) return res.status(400).json({ error: `Process "${opts.process}" is not available for this printer. See GET /api/options?printer=...` });
      const fil = profiles.pickFilament(machine, opts.material, opts.filament);
      if (!fil) return res.status(400).json({ error: `No ${opts.filament ? 'filament "' + opts.filament + '"' : opts.material + ' filament'} for this printer. See GET /api/options?printer=...` });
      const settings = profiles.buildSettings(machine, proc, fil);
      profile = { settings, bed: profiles.bedInfo(settings) };
      used = { printer: machine.name, process: proc.name, filament: fil.name };
    }

    const wantExact = opts.mode === 'exact' || (opts.mode === 'auto' && slicerAvailable());
    if (opts.mode === 'exact' && !slicerAvailable()) return res.status(503).json({ error: 'OrcaSlicer is not installed in this environment; use mode=estimate' });

    if (profile && !wantExact) return res.status(400).json({ error: 'Choosing a printer needs the real slicer (mode exact, or auto with OrcaSlicer installed)' });
    if (opts.gcode && !wantExact) return res.status(400).json({ error: 'gcode=true needs the real slicer (mode exact or auto with OrcaSlicer installed)' });

    // With a printer chosen, the printer's own process settings apply unless a value was sent;
    // without one (your own templates), the defaults below are used
    const eff = profile
      ? { infill: opts.infillGiven ? opts.infill : undefined, walls: opts.strengthGiven ? opts.walls : undefined,
          layerHeight: opts.qualityGiven ? opts.layerHeight : undefined, supports: opts.supportsGiven ? opts.supports : undefined }
      : { infill: opts.infill, walls: opts.walls, layerHeight: opts.layerHeight, supports: opts.supports };
    let stats, gcode;
    if (wantExact) {
      const key = crypto.createHash('sha256').update(hash + JSON.stringify([used || opts.material, opts.scale, eff, opts.rot])).digest('hex');
      if (!opts.gcode && cache.has(key)) stats = cache.get(key); // G-code is not cached, so a gcode request always slices
      else {
        const raw = rawEstimate(m, { ...opts, material: MATERIALS[opts.material] ? opts.material : 'PLA' });
        stats = await enqueue(() => sliceStl(file, {
          template: profile ? MATERIALS.PLA.tpl : MATERIALS[opts.material].tpl, settings: profile && profile.settings, bed: profile && profile.bed,
          scale: opts.scale, rot: opts.rot, infill: eff.infill, layerHeight: eff.layerHeight, walls: eff.walls, supports: eff.supports,
          returnGcode: opts.gcode,
        }));
        if (opts.gcode) { gcode = stats.gcode; delete stats.gcode; }
        cache.set(key, stats);
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        if (!profile) recordSample(raw, stats, opts, key); // teaches the instant estimate from real slices
      }
    } else {
      stats = estimate(m, opts).stats;
    }

    const { weightG, seconds, sizeMm, volumeCm3, watertight } = stats;
    if (String(req.query.download) === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.stl$/i, '').replace(/[^\w.-]/g, '_')}-result.json"`);
    }
    const out = { stats: { weightG, seconds, sizeMm, volumeCm3, watertight } };
    if (used) out.used = used;
    if (opts.gcode) out.gcode = gcode; // the full G-code as one text string
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    cleanup();
  }
});

// uploads over the size limit and other upload errors come back as JSON too
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Send exactly one file, in the form field named "model"' });
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 50 MB' });
  res.status(500).json({ error: err && err.message ? err.message : 'Server error' });
});

if (profiles.available()) console.log('OrcaSlicer profiles loaded:', profiles.listPrinters().length, 'printers');
app.listen(PORT, () => console.log(`print-quote-api on :${PORT} (slicer ${slicerAvailable() ? 'available' : 'NOT found - estimate mode only'})`));