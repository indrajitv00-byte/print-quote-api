// stl.js - read an STL (ASCII or binary), scale/rotate it, measure size and volume.
const fs = require('fs');

function readStl(file) {
  const buf = fs.readFileSync(file);
  const tris = [];
  const binary = buf.length >= 84 && buf.length === 84 + 50 * buf.readUInt32LE(80);
  if (binary) {
    const n = buf.readUInt32LE(80);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      const t = [];
      for (let v = 0; v < 3; v++) {
        const p = o + v * 12;
        t.push([buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)]);
      }
      tris.push(t);
    }
  } else {
    const pts = [...buf.toString('utf8').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)]
      .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    for (let i = 0; i + 2 < pts.length; i += 3) tris.push([pts[i], pts[i + 1], pts[i + 2]]);
  }
  if (!tris.length) throw new Error('No triangles found in STL');
  return tris;
}

function rotateTris(tris, rot) {
  const [rx, ry, rz] = rot.map(d => (d * Math.PI) / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const f = ([x, y, z]) => {
    let t = y * cx - z * sx; z = y * sx + z * cx; y = t;
    t = x * cy + z * sy; z = -x * sy + z * cy; x = t;
    t = x * cz - y * sz; y = x * sz + y * cz; x = t;
    return [x, y, z];
  };
  return tris.map(t => t.map(f));
}

function prepare(tris, scale, rot = [0, 0, 0]) {
  if (rot.some(Boolean)) tris = rotateTris(tris, rot);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const v of t) for (let k = 0; k < 3; k++) {
    v[k] *= scale;
    min[k] = Math.min(min[k], v[k]);
    max[k] = Math.max(max[k], v[k]);
  }
  const center = [0, 1, 2].map(k => (min[k] + max[k]) / 2);
  const size = [0, 1, 2].map(k => max[k] - min[k]);
  let vol = 0;
  for (const [a, b, c] of tris) {
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) +
            a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  const map = new Map(), verts = [], idx = [];
  for (const t of tris) {
    idx.push(t.map(v => {
      const p = [v[0] - center[0], v[1] - center[1], v[2] - center[2]];
      const key = p.map(x => x.toFixed(5)).join(',');
      if (!map.has(key)) { map.set(key, verts.length); verts.push(p); }
      return map.get(key);
    }));
  }
  // watertight check: every edge of a closed mesh is shared by exactly two triangles
  const edges = new Map();
  for (const [a, b, c] of idx) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    if (u === v) continue;
    const k = u < v ? u + '_' + v : v + '_' + u;
    edges.set(k, (edges.get(k) || 0) + 1);
  }
  let openEdges = 0;
  for (const n of edges.values()) if (n !== 2) openEdges++;
  return { verts, idx, size, volumeMm3: Math.abs(vol), watertight: openEdges === 0, openEdges };
}

module.exports = { readStl, prepare };
