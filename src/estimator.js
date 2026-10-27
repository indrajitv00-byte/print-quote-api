// estimator.js - instant weight/time estimate from the mesh, no slicer needed.
// The base model is fitted to one real OrcaSlicer result (20 mm cube, 0.2 mm, 3 walls, 15% infill: 4.00 g, 9m51s).
// Every real Orca slice then calls recordSample(), so the estimate learns from your own printer profile.
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'calibration.json');
const DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.04 };              // g/cm3
const LINE = 0.44;                          // average extrusion width, mm
const K_SHELL = 0.9;                        // walls overlap a little, so the shell is a bit less than area x thickness
const TOP = 4, BOTTOM = 3;                  // top and bottom shell layers in the template
const SEC_PER_MM3 = 0.105, SEC_PER_LAYER = 2.5;
const SUPPORT_W = 1.15, SUPPORT_T = 1.12;   // rough extra when supports are on; corrected by learning
const MAX_SAMPLES = 200;

function areas(verts, idx) {
  let Ah = 0, Av = 0;
  for (const [i, j, k] of idx) {
    const a = verts[i], b = verts[j], c = verts[k];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (!len) continue;
    const area = len / 2, nz = Math.abs(cz) / len;
    Ah += area * nz;                                 // faces seen from above or below (top/bottom skins)
    Av += area * Math.sqrt(Math.max(0, 1 - nz * nz)); // side faces (walls)
  }
  return { Ah, Av };
}

// uncalibrated estimate from a prepared mesh (see prepare() in stl.js)
function rawEstimate(m, opts = {}) {
  const lh = opts.layerHeight || 0.2, walls = opts.walls || 3, infill = (opts.infill || 15) / 100;
  const density = DENSITY[opts.material] || 1.24;
  const { Ah, Av } = areas(m.verts, m.idx);
  const V = m.volumeMm3;
  const shell = Math.min(V, (Av * walls * LINE + Ah * ((TOP + BOTTOM) / 2) * lh) * K_SHELL);
  const extruded = shell + Math.max(0, V - shell) * infill;
  const layers = Math.max(1, Math.ceil(m.size[2] / lh));
  let weightG = (extruded / 1000) * density;
  let seconds = extruded * SEC_PER_MM3 + layers * SEC_PER_LAYER;
  if (opts.supports) { weightG *= SUPPORT_W; seconds *= SUPPORT_T; }
  return { weightG, seconds };
}

// ---------- learning from real slices ----------
function load() {
  try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

function recordSample(raw, actual, opts = {}, key = '') {
  if (!raw || !(actual.weightG > 0) || !(actual.seconds > 0) || !(raw.weightG > 0) || !(raw.seconds > 0)) return;
  const s = load();
  if (key && s.some(x => x.key === key)) return; // the same file and settings is one sample only
  const clamp = v => Math.min(4, Math.max(0.25, v));
  s.push({ key, at: Date.now(), lh: opts.layerHeight || 0.2, sup: !!opts.supports, w: clamp(actual.weightG / raw.weightG), t: clamp(actual.seconds / raw.seconds) });
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(s.slice(-MAX_SAMPLES)));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { /* learning is optional */ }
}

function factors(opts = {}) {
  const s = load();
  const group = (f, test) => { const a = s.filter(test).map(f); return a.length >= 2 ? median(a) : null; };
  const wAll = s.length ? median(s.map(x => x.w)) : 1, tAll = s.length ? median(s.map(x => x.t)) : 1;
  const w = group(x => x.w, x => x.sup === !!opts.supports);
  const t = group(x => x.t, x => x.lh === (opts.layerHeight || 0.2));
  const wf = w === null ? wAll : w, tf = t === null ? tAll : t;
  // how far real results have strayed from the corrected estimate: a wide spread means a wider price range
  let spread = 0.35;
  if (s.length >= 3) {
    const dev = s.map(x => Math.abs(x.t / tf - 1));
    spread = Math.min(0.5, Math.max(0.15, median(dev) * 1.5 + 0.1));
  }
  return { weight: wf, time: tf, spread, samples: s.length };
}

function estimate(m, opts = {}) {
  const raw = rawEstimate(m, opts), f = factors(opts);
  return {
    raw, spread: f.spread, samples: f.samples,
    stats: {
      weightG: Number((raw.weightG * f.weight).toFixed(2)),
      seconds: Math.round(raw.seconds * f.time),
      sizeMm: m.size.map(x => Number(x.toFixed(2))),
      volumeCm3: Number((m.volumeMm3 / 1000).toFixed(3)),
      watertight: m.watertight,
      estimated: true,
    },
  };
}

module.exports = { rawEstimate, estimate, recordSample, factors };