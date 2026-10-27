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

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || '';           // optional: if set, clients must send header x-api-key
const MAX_TRIANGLES = 500000;
// All materials are sliced with the PLA template (density 1.24 g/cm3); the weight is then
// corrected by each material's density. To use a real PETG/ABS profile later, give it its own
// template here and set tpl to that file.
const PLA_TEMPLATE = path.join(__dirname, '..', 'templates', 'PLA_standard.3mf');
const TEMPLATE_DENSITY = 1.24;
const MATERIALS = {
  PLA:  { density: 1.24, tpl: PLA_TEMPLATE },
  PETG: { density: 1.27, tpl: PLA_TEMPLATE },
  ABS:  { density: 1.04, tpl: PLA_TEMPLATE },
};
const INFILLS = [10, 15, 20, 30, 40, 50, 60, 70, 80, 90];
const QUALITY = { standard: 0.2, medium: 0.15, high: 0.1 }; // layer height in mm
const STRENGTH = { light: 2, standard: 3, strong: 5 };
const ROTS = [0, 90, 180, 270];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-'));
const upload = multer({ dest: tmpDir, limits: { fileSize: 50 * 1024 * 1024 } });
const app = express();

function parseOptions(body) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const scale = num(body.scale, 1);
  if (!(scale >= 0.01 && scale <= 100)) return { error: 'scale must be between 0.01 and 100' };
  const infill = num(body.infill, 15);
  if (!INFILLS.includes(infill)) return { error: 'infill must be one of ' + INFILLS.join(', ') };
  const material = String(body.material || 'PLA').toUpperCase();
  if (!MATERIALS[material]) return { error: 'material must be one of ' + Object.keys(MATERIALS).join(', ') };
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
  return { scale, infill, material, quality, layerHeight, strength, walls: STRENGTH[strength], rot, mode, supports: bool(body.supports) };
}

// one slice at a time: OrcaSlicer is heavy, extra requests simply wait their turn
let chain = Promise.resolve();
const enqueue = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
const cache = new Map(); // file hash + options -> slicer stats (PLA settings)

app.use((req, res, next) => {
  if (API_KEY && req.path !== '/health' && req.get('x-api-key') !== API_KEY) return res.status(401).json({ error: 'Missing or wrong x-api-key' });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, slicer: slicerAvailable() }));

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

    const wantExact = opts.mode === 'exact' || (opts.mode === 'auto' && slicerAvailable());
    if (opts.mode === 'exact' && !slicerAvailable()) return res.status(503).json({ error: 'OrcaSlicer is not installed in this environment; use mode=estimate' });

    let stats;
    if (wantExact) {
      const key = crypto.createHash('sha256').update(hash + JSON.stringify([opts.scale, opts.infill, opts.layerHeight, opts.walls, opts.supports, opts.rot])).digest('hex');
      if (cache.has(key)) stats = cache.get(key);
      else {
        const raw = rawEstimate(m, { ...opts, material: 'PLA' });
        stats = await enqueue(() => sliceStl(file, {
          template: PLA_TEMPLATE, scale: opts.scale, infill: opts.infill, rot: opts.rot,
          layerHeight: opts.layerHeight, walls: opts.walls, supports: opts.supports,
        }));
        cache.set(key, stats);
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        recordSample(raw, stats, { ...opts, material: 'PLA' }, key); // teaches the instant estimate from real slices
      }
    } else {
      stats = estimate(m, opts).stats;
    }

    let { weightG, seconds, sizeMm, volumeCm3, watertight } = stats;
    // exact slices were made with PLA settings: correct the weight for the chosen material's density
    if (wantExact) weightG = Number((weightG * MATERIALS[opts.material].density / TEMPLATE_DENSITY).toFixed(2));
    if (String(req.query.download) === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.stl$/i, '').replace(/[^\w.-]/g, '_')}-result.json"`);
    }
    res.json({ stats: { weightG, seconds, sizeMm, volumeCm3, watertight } });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

app.listen(PORT, () => console.log(`print-quote-api on :${PORT} (slicer ${slicerAvailable() ? 'available' : 'NOT found - estimate mode only'})`));