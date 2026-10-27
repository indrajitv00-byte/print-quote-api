// profiles.js - index OrcaSlicer's own system profiles (printers, process presets, filaments)
// so any printer / material in Orca can be chosen through the API.
const fs = require('fs');
const path = require('path');

const DIR = process.env.ORCA_PROFILES || '/opt/orca/resources/profiles';
const KINDS = ['machine', 'process', 'filament'];
// only these keys are kept in the index (the full preset is re-read from disk when needed)
const LIGHT = ['compatible_printers', 'compatible_printers_condition', 'filament_type', 'printer_model', 'printer_variant',
  'default_print_profile', 'nozzle_diameter', 'printer_notes', 'printable_area', 'printable_height', 'layer_height'];
// keys that identify a preset or its compatibility; they must not be copied into a project
const STRIP = ['type', 'name', 'from', 'inherits', 'setting_id', 'instantiation', 'version', 'compatible_printers',
  'compatible_printers_condition', 'renamed_from', 'printer_settings_id', 'print_settings_id', 'filament_settings_id'];

let idx = null;

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else if (e.name.endsWith('.json')) fn(p);
  }
}

function init() {
  const byKind = { machine: new Map(), process: new Map(), filament: new Map() };
  if (!fs.existsSync(DIR)) { idx = byKind; return; }
  for (const v of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!v.isDirectory()) continue;
    walk(path.join(DIR, v.name), file => {
      let d;
      try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
      if (!d || !KINDS.includes(d.type) || !d.name) return;
      const e = { vendor: v.name, kind: d.type, name: d.name, file, inherits: d.inherits || '', inst: String(d.instantiation) === 'true', own: {} };
      for (const k of LIGHT) if (k in d) e.own[k] = d[k];
      const m = byKind[d.type];
      if (!m.has(d.name)) m.set(d.name, []);
      m.get(d.name).push(e);
    });
  }
  idx = byKind;
}

const available = () => { if (!idx) init(); return idx.machine.size > 0; };

// find a preset by name; a parent is looked up in the same vendor first, then the shared filament library
function lookup(kind, name, vendor) {
  const list = idx[kind].get(name);
  if (!list) return null;
  return list.find(e => e.vendor === vendor) || list.find(e => e.vendor === 'OrcaFilamentLibrary') || list[0];
}

function resolved(e, depth = 0) {
  if (e._res) return e._res;
  if (depth > 20) throw new Error('Preset inheritance loop at ' + e.name);
  const parent = e.inherits ? lookup(e.kind, e.inherits, e.vendor) : null;
  e._res = { ...(parent ? resolved(parent, depth + 1) : {}), ...e.own };
  return e._res;
}

function flatten(e, depth = 0) {
  if (depth > 20) throw new Error('Preset inheritance loop at ' + e.name);
  const parent = e.inherits ? lookup(e.kind, e.inherits, e.vendor) : null;
  const own = JSON.parse(fs.readFileSync(e.file, 'utf8'));
  return { ...(parent ? flatten(parent, depth + 1) : {}), ...own };
}

// ---- compatibility (list of printer names, or the simple conditions Orca's presets use) ----
function evalCondition(cond, machine) {
  const r = resolved(machine);
  const notes = String(r.printer_notes || '');
  const nd = Number(Array.isArray(r.nozzle_diameter) ? r.nozzle_diameter[0] : r.nozzle_diameter);
  const rx = (s, re) => re.test(s);
  try {
    const js = cond
      .replace(/printer_notes\s*=~\s*(\/(?:\\\/|[^\/])*\/)/g, 'rx(notes,$1)')
      .replace(/printer_notes\s*!~\s*(\/(?:\\\/|[^\/])*\/)/g, '!rx(notes,$1)')
      .replace(/nozzle_diameter\[0\]\s*==\s*([\d.]+)/g, '(nd===$1)')
      .replace(/\band\b/g, '&&').replace(/\bor\b/g, '||');
    if (/[a-zA-Z_]\w*\s*\(/.test(js.replace(/rx\(/g, ''))) return false; // anything we do not understand = not compatible
    return !!new Function('rx', 'notes', 'nd', 'return (' + js + ');')(rx, notes, nd);
  } catch (e) { return false; }
}

function compatible(preset, machine) {
  const r = resolved(preset);
  const list = r.compatible_printers;
  if (Array.isArray(list) && list.length) return list.includes(machine.name);
  const cond = r.compatible_printers_condition;
  if (cond && String(cond).trim()) return evalCondition(String(cond), machine);
  return true;
}

// ---- public API ----
function singleNozzle(m) {
  const nd = resolved(m).nozzle_diameter;
  return Array.isArray(nd) ? nd.length === 1 : true;
}

function listPrinters({ vendor, q } = {}) {
  available();
  const out = [];
  for (const list of idx.machine.values()) for (const e of list) {
    if (!e.inst || !singleNozzle(e)) continue;
    if (vendor && e.vendor.toLowerCase() !== String(vendor).toLowerCase()) continue;
    if (q && !e.name.toLowerCase().includes(String(q).toLowerCase())) continue;
    const r = resolved(e);
    out.push({ name: e.name, vendor: e.vendor, model: r.printer_model || '', nozzleMm: Number(Array.isArray(r.nozzle_diameter) ? r.nozzle_diameter[0] : r.nozzle_diameter) || null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function getMachine(name) {
  available();
  const list = idx.machine.get(String(name));
  const e = list && list.find(x => x.inst && singleNozzle(x));
  return e || null;
}

function listProcesses(machine) {
  const out = [];
  for (const list of idx.process.values()) for (const e of list) {
    if (e.inst && e.vendor === machine.vendor && compatible(e, machine)) out.push(e);
  }
  return out;
}

function listFilaments(machine, material) {
  const out = [];
  for (const list of idx.filament.values()) for (const e of list) {
    if (!e.inst || !compatible(e, machine)) continue;
    if (material && String(resolved(e).filament_type || '').toUpperCase() !== String(material).toUpperCase()) continue;
    out.push(e);
  }
  return out;
}

function pickProcess(machine, requested) {
  const all = listProcesses(machine);
  if (requested) return all.find(e => e.name === requested) || null;
  const def = resolved(machine).default_print_profile;
  return all.find(e => e.name === def)
    || all.find(e => /0\.20mm/.test(e.name) && /standard/i.test(e.name))
    || all.find(e => /0\.20mm/.test(e.name)) || all[0] || null;
}

const SPECIAL = /(CF|GF|GK|Silk|Matte|High ?Speed|HS|Rapid|Glow|Marble|Wood|Metal|Carbon|Galaxy|Sparkle|Tough|Pro\b|Plus|\+|Support|Flex|Translucent|Fast|Dual|Lite|Basic|Fiber|Fibre|Sparkling)/i;
function pickFilament(machine, material, requested) {
  if (requested) {
    const e = listFilaments(machine).find(x => x.name === requested);
    return e || null;
  }
  const cands = listFilaments(machine, material);
  if (!cands.length) {
    // fall back to the shared "Generic <material>" preset from Orca's filament library
    const g = lookup('filament', 'Generic ' + String(material).toUpperCase(), 'OrcaFilamentLibrary');
    return g && g.inst ? g : null;
  }
  const score = e => {
    const base = e.name.split(' @')[0];
    let s = 0;
    if (/generic/i.test(base)) s += 100;
    if (SPECIAL.test(base.replace(/generic/i, ''))) s -= 50;
    if (e.vendor === machine.vendor) s += 10;
    if (/@.*\bnozzle\b/i.test(e.name) || /\d\.\d+ nozzle/i.test(e.name)) s -= 5; // prefer the plain preset
    return s - base.length / 100;
  };
  return cands.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
}

function materials(machine) {
  const set = new Set();
  for (const e of listFilaments(machine)) { const t = resolved(e).filament_type; if (t) set.add(String(t).toUpperCase()); }
  return [...set].sort();
}

// One settings object for the project file: printer + process + filament, ids and compatibility fields removed
function buildSettings(machine, process, filament) {
  const out = {};
  for (const e of [machine, process, filament]) {
    const f = flatten(e);
    for (const k of STRIP) delete f[k];
    Object.assign(out, f);
  }
  return out;
}

// centre and height of the printer's bed
function bedInfo(settings) {
  const area = Array.isArray(settings.printable_area) ? settings.printable_area : String(settings.printable_area || '').split(',');
  const pts = area.map(s => String(s).trim().split('x').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
  if (!pts.length) return { cx: 125, cy: 125, sizeX: 250, sizeY: 250, height: Number(settings.printable_height) || 250 };
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, sizeX: x1 - x0, sizeY: y1 - y0, height: Number(settings.printable_height) || 250 };
}

module.exports = { init, available, listPrinters, getMachine, listProcesses, listFilaments, pickProcess, pickFilament, materials, buildSettings, bedInfo, resolved };