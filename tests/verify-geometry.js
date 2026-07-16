/* Headless verification of geometry.js and exporter.js */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const window = {};
eval(fs.readFileSync(path.join(root, 'js/geometry.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'js/exporter.js'), 'utf8'));
const BaseGeometry = window.BaseGeometry;
const StlExport = window.StlExport;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) { failures++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
  else console.log('ok    ' + name);
}

function analyze(positions) {
  const triCount = positions.length / 9;
  const edges = new Map(); // directed edge -> count
  let volume = 0;
  let degenerate = 0;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const v = [
      positions.slice(o, o + 3),
      positions.slice(o + 3, o + 6),
      positions.slice(o + 6, o + 9)
    ];
    const key = p => p[0] + ',' + p[1] + ',' + p[2];
    // signed volume (divergence theorem): positive iff outward CCW winding
    const [a, b, c] = v;
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1])
             + a[1] * (b[2] * c[0] - b[0] * c[2])
             + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    // area
    const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
    const wx = c[0]-a[0], wy = c[1]-a[1], wz = c[2]-a[2];
    const nx = uy*wz-uz*wy, ny = uz*wx-ux*wz, nz = ux*wy-uy*wx;
    if (Math.sqrt(nx*nx+ny*ny+nz*nz) / 2 < 1e-9) degenerate++;
    for (let k = 0; k < 3; k++) {
      const e = key(v[k]) + '|' + key(v[(k + 1) % 3]);
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  }
  // manifold: every directed edge exactly once, and its reverse exists
  let badEdges = 0;
  for (const [e, count] of edges) {
    const rev = e.split('|').reverse().join('|');
    if (count !== 1 || !edges.has(rev)) badEdges++;
  }
  return { triCount, volume, degenerate, badEdges };
}

const magnetOff = { enabled: false };
const magnetOn = { enabled: true, diameter: 5, depth: 2 };

const cases = [];
for (const shape of ['round', 'ellipse', 'square']) {
  for (const bevel of [0, 1]) {
    for (const magnet of [magnetOff, magnetOn]) {
      cases.push({
        name: shape + ' bevel=' + bevel + ' magnet=' + magnet.enabled,
        params: { shape, diameter: 32, width: 60, depth: 35, side: 25,
                  height: 4, bevel, magnet }
      });
    }
  }
}
// extremes
cases.push({ name: 'tiny with big requested bevel (defensive clamp)',
  params: { shape: 'round', diameter: 6, height: 2, bevel: 5, magnet: magnetOff } });
cases.push({ name: 'huge oval, deep magnet',
  params: { shape: 'ellipse', width: 120, depth: 92, height: 10, bevel: 2,
            magnet: { enabled: true, diameter: 10, depth: 8 } } });

for (const c of cases) {
  const positions = BaseGeometry.buildPositions(c.params);
  const r = analyze(positions);
  check(c.name + ': manifold', r.badEdges === 0, r.badEdges + ' bad edges');
  check(c.name + ': no degenerate tris', r.degenerate === 0, r.degenerate + ' degenerate');
  check(c.name + ': positive volume', r.volume > 0, 'volume=' + r.volume.toFixed(3));
  c.volume = r.volume;
  c.triCount = r.triCount;
}

// exact volume: square 25x25x4 no bevel no magnet = 2500 mm^3
const sq = cases.find(c => c.name === 'square bevel=0 magnet=false');
check('square exact volume 2500', Math.abs(sq.volume - 2500) < 1e-6, 'got ' + sq.volume);

// square with magnet: 2500 - pi*2.5^2*2 (96-gon approximation of the hole)
const sqm = cases.find(c => c.name === 'square bevel=0 magnet=true');
const holeVol = 0.5 * 96 * Math.sin(2 * Math.PI / 96) * 2.5 * 2.5 * 2; // prism on 96-gon
check('square-with-magnet volume', Math.abs(sqm.volume - (2500 - holeVol)) < 1e-6,
  'got ' + sqm.volume + ' expected ' + (2500 - holeVol));

// round no bevel no magnet ~ pi*16^2*4 within polygon deficit
const rd = cases.find(c => c.name === 'round bevel=0 magnet=false');
const polyVol = 0.5 * 96 * Math.sin(2 * Math.PI / 96) * 16 * 16 * 4;
check('round volume matches 96-gon prism', Math.abs(rd.volume - polyVol) < 1e-6,
  'got ' + rd.volume + ' expected ' + polyVol);

// monotonicity: bevel and magnet each remove material
for (const shape of ['round', 'ellipse', 'square']) {
  const v = (bevel, mag) => cases.find(c =>
    c.name === shape + ' bevel=' + bevel + ' magnet=' + mag).volume;
  check(shape + ': bevel removes material', v(1, false) < v(0, false));
  check(shape + ': magnet removes material', v(0, true) < v(0, false));
}

// STL exporter: fake BufferGeometry over one case
const pos = BaseGeometry.buildPositions(cases[0].params);
const fakeGeom = {
  getIndex: () => null,
  getAttribute: () => ({
    count: pos.length / 3,
    getX: i => pos[3 * i],
    getY: i => pos[3 * i + 1],
    getZ: i => pos[3 * i + 2]
  })
};
const buf = StlExport.geometryToStl(fakeGeom);
const T = pos.length / 9;
check('STL byte size = 84 + 50*T', buf.byteLength === 84 + 50 * T,
  buf.byteLength + ' vs ' + (84 + 50 * T));
const dv = new DataView(buf);
check('STL triangle count field', dv.getUint32(80, true) === T);
// first facet normal is unit length
const n = [dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true)];
const nlen = Math.hypot(n[0], n[1], n[2]);
check('STL first normal unit length', Math.abs(nlen - 1) < 1e-5, 'len=' + nlen);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
