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

async function sliceStl(stlPath, opts = {}) {
  const { template, scale = 1, infill, rot = [0, 0, 0], layerHeight, supports, walls } = opts;
  if (!template) throw new Error('template is required');
  const m = prepare(readStl(stlPath), scale, rot);
  const halfZ = (m.size[2] / 2).toFixed(5);

  const zip = new AdmZip(template);
  const objXml = zip.readAsText(OBJ_ENTRY).replace(/<mesh>[\s\S]*<\/mesh>/, () => meshBlock(m.verts, m.idx));
  zip.updateFile(OBJ_ENTRY, Buffer.from(objXml, 'utf8'));

  const model = zip.readAsText('3D/3dmodel.model')
    .replace(/(<item [^>]*transform="(?:\S+ ){9})(\S+) (\S+) (\S+)"/, (all, pre, x, y) => `${pre}${x} ${y} ${halfZ}"`);
  zip.updateFile('3D/3dmodel.model', Buffer.from(model, 'utf8'));

  const cfg = zip.readAsText('Metadata/model_settings.config')
    .replace(/(<assemble_item [^>]*transform="(?:\S+ ){9}\S+ \S+ )\S+"/, (all, pre) => `${pre}${halfZ}"`);
  zip.updateFile('Metadata/model_settings.config', Buffer.from(cfg, 'utf8'));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-'));
  try {
    const job = path.join(work, 'job.3mf');
    zip.writeZip(job);
    const args = ['--slice', '1', '--outputdir', work, '--export-3mf', 'out.gcode.3mf'];
    // Overrides are only passed when they differ from the template (0.2 mm, 3 walls, no supports)
    if (infill) args.push(`--sparse-infill-density=${infill}%`);
    if (layerHeight && layerHeight !== 0.2) args.push(`--layer-height=${layerHeight}`);
    if (walls && walls !== 3) args.push(`--wall-loops=${walls}`);
    if (supports) args.push('--enable-support=1');
    args.push(job);
    const { code, log } = await runOrca(args);

    const gfile = path.join(work, 'plate_1.gcode');
    if (!fs.existsSync(gfile)) throw new Error(`Slicer failed (exit ${code}). ${log.slice(-300)}`);
    const g = fs.readFileSync(gfile, 'utf8');
    const w = g.match(/total filament used \[g\]\s*=\s*([\d.]+)/i);
    const t = g.match(/estimated printing time \(normal mode\)\s*=\s*(.+)/i);
    if (!w || !t) throw new Error('Could not find weight/time in G-code');
    return {
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
