// slicer.js - exact weight/time by running OrcaSlicer headless on a template .3mf project.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { readStl, prepare } = require('./stl');

const ORCA = process.env.ORCA_PATH || '/opt/orca/AppRun';
const USE_XVFB = process.env.USE_XVFB === '1';          // Orca needs a (virtual) display on Linux
const TIMEOUT_MS = Number(process.env.SLICE_TIMEOUT_MS) || 180000;
const OBJ_ENTRY = '3D/Objects/test.stl_1.model';

const slicerAvailable = () => fs.existsSync(ORCA);

function meshBlock(verts, idx) {
  const v = verts.map(p => `<vertex x="${p[0].toFixed(5)}" y="${p[1].toFixed(5)}" z="${p[2].toFixed(5)}"/>`).join('\n');
  const t = idx.map(i => `<triangle v1="${i[0]}" v2="${i[1]}" v3="${i[2]}"/>`).join('\n');
  return `<mesh>\n<vertices>\n${v}\n</vertices>\n<triangles>\n${t}\n</triangles>\n</mesh>`;
}

function runOrca(args) {
  return new Promise((resolve, reject) => {
    const cmd = USE_XVFB ? 'xvfb-run' : ORCA;
    const full = USE_XVFB ? ['-a', ORCA, ...args] : args;
    const p = spawn(cmd, full, { env: { ...process.env, HOME: process.env.ORCA_HOME || '/tmp/orca-home' } });
    let log = '';
    p.stdout.on('data', d => (log += d));
    p.stderr.on('data', d => (log += d));
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Slice timed out')); }, TIMEOUT_MS);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); resolve({ code, log }); });
  });
}

function parseDuration(text) {
  const unit = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, n, u] of text.matchAll(/(\d+)\s*([dhms])/g)) total += Number(n) * unit[u];
  return total;
}

// A few vendor presets contain values Orca's own validator rejects (out of range, or
// firmware retraction together with wipe). Orca's message says exactly which; fix those and retry.
function repairSettings(cfg, log) {
  let changed = false;
  for (const line of String(log).split(/\r?\n/)) {
    const r = line.match(/^\s*(\w+):\s*(-?[\d.]+)\s+not in range\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/);
    if (r && r[1] in cfg) {
      const clamp = x => String(Math.min(Math.max(Number(x), Number(r[3])), Number(r[4])));
      cfg[r[1]] = Array.isArray(cfg[r[1]]) ? cfg[r[1]].map(clamp) : clamp(cfg[r[1]]);
      changed = true;
    } else if (/use_firmware_retraction.*not compatible with --wipe/i.test(line) && cfg.use_firmware_retraction !== '0') {
      cfg.use_firmware_retraction = '0';
      changed = true;
    }
  }
  // custom G-code that uses a variable Orca does not know ("... does not exist" followed by the offending line):
  // drop that [variable] from the G-code, it is only used in messages and has no effect on weight or time
  const lines = String(log).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/does not exist\s*$/.test(line) || i + 1 >= lines.length) return;
    for (const [, token] of lines[i + 1].matchAll(/\[(\w+)\]/g)) {
      for (const k of Object.keys(cfg)) {
        if (/gcode/i.test(k) && typeof cfg[k] === 'string' && cfg[k].includes('[' + token + ']')) {
          cfg[k] = cfg[k].split('[' + token + ']').join('');
          changed = true;
        }
      }
    }
  });
  return changed;
}

async function sliceStl(stlPath, opts = {}) {
  const { template, scale = 1, infill, rot = [0, 0, 0], layerHeight, supports, walls, returnGcode = false, settings, bed } = opts;
  if (!template) throw new Error('template is required');
  const m = prepare(readStl(stlPath), scale, rot);
  const halfZ = (m.size[2] / 2).toFixed(5);
  if (bed && (m.size[0] > bed.sizeX || m.size[1] > bed.sizeY || m.size[2] > bed.height)) {
    throw Object.assign(new Error(`Model (${m.size.map(x => x.toFixed(1)).join(' x ')} mm) does not fit this printer (${bed.sizeX} x ${bed.sizeY} x ${bed.height} mm)`), { status: 422 });
  }

  const zip = new AdmZip(template);
  let projectCfg = null;
  if (settings) {
    // printer + process + filament presets replace the template's settings; the template only supplies the project shell
    const cfg = projectCfg = { ...JSON.parse(zip.readAsText('Metadata/project_settings.config')), ...settings };
    // some start G-code refers to [output_filename_format]; it must not be empty
    if (!String(cfg.output_filename_format || '').trim()) cfg.output_filename_format = '{input_filename_base}_{filament_type[0]}_{print_time}.gcode';
    // Orca refuses to slice if relative extruder moves are used without "G92 E0" at each layer change
    // (a few vendor presets are missing it); adding it does not change filament use or print time
    if (String(cfg.use_relative_e_distances) === '1' && !/G92\s+E0/i.test(String(cfg.layer_change_gcode || ''))) {
      cfg.layer_change_gcode = (String(cfg.layer_change_gcode || '') + '\nG92 E0').trim();
    }
  }
  const px = bed ? bed.cx.toFixed(5) : null, py = bed ? bed.cy.toFixed(5) : null;
  const objXml = zip.readAsText(OBJ_ENTRY).replace(/<mesh>[\s\S]*<\/mesh>/, () => meshBlock(m.verts, m.idx));
  zip.updateFile(OBJ_ENTRY, Buffer.from(objXml, 'utf8'));

  const model = zip.readAsText('3D/3dmodel.model')
    .replace(/(<item [^>]*transform="(?:\S+ ){9})(\S+) (\S+) (\S+)"/, (all, pre, x, y) => `${pre}${px || x} ${py || y} ${halfZ}"`);
  zip.updateFile('3D/3dmodel.model', Buffer.from(model, 'utf8'));

  const modelCfg = zip.readAsText('Metadata/model_settings.config')
    .replace(/(<assemble_item [^>]*transform="(?:\S+ ){9})(\S+) (\S+) \S+"/, (all, pre, x, y) => `${pre}${px || x} ${py || y} ${halfZ}"`);
  zip.updateFile('Metadata/model_settings.config', Buffer.from(modelCfg, 'utf8'));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-'));
  try {
    const job = path.join(work, 'job.3mf');
    const args = ['--slice', '1', '--outputdir', work, '--export-3mf', 'out.gcode.3mf'];
    // Template mode: overrides only when they differ from the template (0.2 mm, 3 walls, no supports).
    // Printer-profile mode: only the values that were sent are passed; everything else comes from the printer profile.
    const always = !!settings;
    if (infill) args.push(`--sparse-infill-density=${infill}%`);
    if (layerHeight && (always || layerHeight !== 0.2)) args.push(`--layer-height=${layerHeight}`);
    if (walls && (always || walls !== 3)) args.push(`--wall-loops=${walls}`);
    if (supports === true || (always && supports !== undefined)) args.push(`--enable-support=${supports ? 1 : 0}`);
    args.push(job);
    const gfile = path.join(work, 'plate_1.gcode');
    let code, log;
    for (let attempt = 0; ; attempt++) {
      if (projectCfg) zip.updateFile('Metadata/project_settings.config', Buffer.from(JSON.stringify(projectCfg, null, 4), 'utf8'));
      zip.writeZip(job);
      ({ code, log } = await runOrca(args));
      if (fs.existsSync(gfile) || !projectCfg || attempt >= 3 || !repairSettings(projectCfg, log)) break;
    }
    if (!fs.existsSync(gfile)) {
      let why = '';
      try { why = JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8')).error_string || ''; } catch (e) { /* no result file */ }
      throw Object.assign(new Error(`Slicer failed${why ? ': ' + why : ''} (exit ${code}). ${log.slice(-200)}`), { status: 422 });
    }
    const g = fs.readFileSync(gfile, 'utf8');
    // most printers write "total filament used [g] = x"; Bambu-style G-code writes "filament used [g] = x"
    const w = g.match(/filament used \[g\]\s*=\s*([\d.]+)/i);
    // time: "estimated printing time (normal mode) = ..." or, Bambu-style, "model printing time: ...;"
    const t = g.match(/estimated printing time \(normal mode\)\s*=\s*(.+)/i) || g.match(/model printing time:\s*([^;\n]+)/i);
    if (!w || !t) throw new Error('Could not find weight/time in G-code');
    return {
      ...(returnGcode ? { gcode: g } : {}),
      weightG: parseFloat(w[1]),
      seconds: parseDuration(t[1]),
      sizeMm: m.size.map(x => Number(x.toFixed(2))),
      volumeCm3: Number((m.volumeMm3 / 1000).toFixed(3)),
      watertight: m.watertight,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { sliceStl, slicerAvailable };