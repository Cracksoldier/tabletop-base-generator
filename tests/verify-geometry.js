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
  let badHoriz = 0;
  // top plane, for orienting horizontal facets
  let Hmax = -Infinity;
  for (let i = 2; i < positions.length; i += 3) if (positions[i] > Hmax) Hmax = positions[i];
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
    // horizontal facets must face the right way: up only on the top plane,
    // down at z=0 and mid-height (recess ceiling). Volume and edge checks
    // are blind to an inverted bottom face, so this is asserted explicitly.
    if (a[2] === b[2] && b[2] === c[2]) {
      const wantUp = a[2] === Hmax;
      if (wantUp ? nz <= 0 : nz >= 0) badHoriz++;
    }
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
  return { triCount, volume, degenerate, badEdges, badHoriz };
}

/*
 * Exact analytic volume of the generated mesh. Caps and walls are prisms;
 * each bevel band is a prismatoid (all vertices in two parallel planes), so
 * Simpson's rule on the linearly interpolated radii is exact:
 *   V = dz/6 * C * (rx1*ry1 + 4*((rx1+rx2)/2)*((ry1+ry2)/2) + rx2*ry2)
 * C is the polygon area factor (A = C*rx*ry): inscribed 96-gon for
 * round/ellipse, exactly 4 for the square. The magnet hole is always a
 * 96-gon prism, and its volume is translation invariant.
 */
const C96 = 0.5 * 96 * Math.sin(2 * Math.PI / 96);
const FILLET_STEPS = 8; // mirrors geometry.js

function bandVol(C, rx1, ry1, z1, rx2, ry2, z2) {
  return (z2 - z1) / 6 * C * (rx1 * ry1 + 4 * ((rx1 + rx2) / 2) * ((ry1 + ry2) / 2) + rx2 * ry2);
}

function analyticVolume(p) {
  const C = p.shape === 'square' ? 4 : C96;
  let rx, ry;
  if (p.shape === 'round') rx = ry = p.diameter / 2;
  else if (p.shape === 'ellipse') { rx = p.width / 2; ry = p.depth / 2; }
  else rx = ry = p.side / 2;
  const bevel = p.bevel || 0;
  const wallTop = p.height - bevel;
  let v = C * rx * ry * wallTop;
  if (bevel > 0) {
    if (p.bevelType === 'round') {
      let pIns = 0, pZ = wallTop;
      for (let k = 1; k <= FILLET_STEPS; k++) {
        const last = k === FILLET_STEPS;
        const phi = k * (Math.PI / 2) / FILLET_STEPS;
        const ins = last ? bevel : bevel * (1 - Math.cos(phi));
        const z = last ? p.height : wallTop + bevel * Math.sin(phi);
        v += bandVol(C, rx - pIns, ry - pIns, pZ, rx - ins, ry - ins, z);
        pIns = ins; pZ = z;
      }
    } else {
      v += bandVol(C, rx, ry, wallTop, rx - bevel, ry - bevel, p.height);
    }
  }
  if (p.magnet && p.magnet.enabled) {
    v -= C96 * Math.pow(p.magnet.diameter / 2, 2) * p.magnet.depth;
  }
  return v;
}

/* ---------- shape x bevel-type x magnet-placement matrix ---------- */

const bevelVariants = [
  { label: 'none', bevel: 0, bevelType: 'flat' },
  { label: 'flat', bevel: 1, bevelType: 'flat' },
  { label: 'round', bevel: 1, bevelType: 'round' }
];
const magnetVariants = [
  { label: 'off', magnet: { enabled: false } },
  { label: 'centered', magnet: { enabled: true, diameter: 5, depth: 2 } },
  { label: 'offset', magnet: { enabled: true, diameter: 5, depth: 2, offsetX: 4, offsetY: -2 } }
];

const cases = [];
for (const shape of ['round', 'ellipse', 'square']) {
  for (const bv of bevelVariants) {
    for (const mv of magnetVariants) {
      cases.push({
        name: shape + ' bevel=' + bv.label + ' magnet=' + mv.label,
        exact: true, // safe offsets: analyticVolume applies verbatim
        params: { shape, diameter: 32, width: 60, depth: 35, side: 25,
                  height: 4, bevel: bv.bevel, bevelType: bv.bevelType, magnet: mv.magnet }
      });
    }
  }
}

// extremes — defensive clamps kick in, so only the invariants are asserted
cases.push({ name: 'tiny with big requested bevel (defensive clamp)',
  params: { shape: 'round', diameter: 6, height: 2, bevel: 5, magnet: { enabled: false } } });
cases.push({ name: 'huge oval, deep offset magnet',
  exact: true,
  params: { shape: 'ellipse', width: 120, depth: 92, height: 10, bevel: 2, bevelType: 'round',
            magnet: { enabled: true, diameter: 10, depth: 8, offsetX: 40, offsetY: 20 } } });
cases.push({ name: 'ellipse, magnet at far end',
  exact: true,
  params: { shape: 'ellipse', width: 60, depth: 35, height: 4, bevel: 0,
            magnet: { enabled: true, diameter: 5, depth: 2, offsetX: 26, offsetY: 0 } } });
// requested offsets far outside — the defensive support clamp must land the
// hole somewhere valid; the exact volume still holds by translation invariance
for (const shape of ['round', 'ellipse', 'square']) {
  cases.push({ name: shape + ', absurd requested offset (defensive clamp)',
    exact: true,
    params: { shape, diameter: 32, width: 60, depth: 35, side: 25,
              height: 4, bevel: 1, bevelType: 'round',
              magnet: { enabled: true, diameter: 5, depth: 2, offsetX: 1000, offsetY: -1000 } } });
}
// square-corner inversion regression: honors the 1.5 mm wall per-axis yet
// inverted 14 bottom triangles before the support-function clamp existed
cases.push({ name: 'square corner offset (inversion regression)',
  exact: true,
  params: { shape: 'square', side: 60, height: 6, bevel: 0,
            magnet: { enabled: true, diameter: 20, depth: 2, offsetX: 18.5, offsetY: 18.5 } } });
// recess ceiling rising into the bevel: offset must be clamped against the
// bevel surface at ceiling height, not the footprint
cases.push({ name: 'deep magnet under bevel, offset to the rim',
  exact: true,
  params: { shape: 'round', diameter: 32, height: 4, bevel: 2, bevelType: 'flat',
            magnet: { enabled: true, diameter: 5, depth: 3, offsetX: 100, offsetY: 0 } } });

for (const c of cases) {
  const positions = BaseGeometry.buildPositions(c.params);
  const r = analyze(positions);
  check(c.name + ': manifold', r.badEdges === 0, r.badEdges + ' bad edges');
  check(c.name + ': no degenerate tris', r.degenerate === 0, r.degenerate + ' degenerate');
  check(c.name + ': positive volume', r.volume > 0, 'volume=' + r.volume.toFixed(3));
  check(c.name + ': horizontal facets oriented', r.badHoriz === 0, r.badHoriz + ' misoriented');
  if (c.exact) {
    const want = analyticVolume(c.params);
    check(c.name + ': exact volume', Math.abs(r.volume - want) < 1e-6,
      'got ' + r.volume + ' expected ' + want);
  }
  c.volume = r.volume;
  c.triCount = r.triCount;
}

// exact volume: square 25x25x4 no bevel no magnet = 2500 mm^3
const sq = cases.find(c => c.name === 'square bevel=none magnet=off');
check('square exact volume 2500', Math.abs(sq.volume - 2500) < 1e-6, 'got ' + sq.volume);

// round no bevel no magnet ~ pi*16^2*4 within polygon deficit
const rd = cases.find(c => c.name === 'round bevel=none magnet=off');
const polyVol = C96 * 16 * 16 * 4;
check('round volume matches 96-gon prism', Math.abs(rd.volume - polyVol) < 1e-6,
  'got ' + rd.volume + ' expected ' + polyVol);

// monotonicity: flat chamfer removes more than the fillet, both remove material
for (const shape of ['round', 'ellipse', 'square']) {
  const v = (bevel, mag) => cases.find(c =>
    c.name === shape + ' bevel=' + bevel + ' magnet=' + mag).volume;
  check(shape + ': bevel removes material', v('flat', 'off') < v('none', 'off'));
  check(shape + ': fillet keeps more than chamfer',
    v('flat', 'off') < v('round', 'off') && v('round', 'off') < v('none', 'off'));
  check(shape + ': magnet removes material', v('none', 'centered') < v('none', 'off'));
  check(shape + ': magnet offset does not change volume',
    Math.abs(v('none', 'offset') - v('none', 'centered')) < 1e-6);
}

// clampMagnetOffset: safe offsets pass through untouched, unsafe ones scale back
const clampParams = { shape: 'square', side: 60, height: 6, bevel: 0,
                      magnet: { enabled: true, diameter: 20, depth: 2 } };
const safe = BaseGeometry.clampMagnetOffset(clampParams, 5, 0, 1.5);
check('clampMagnetOffset: safe offset unchanged',
  safe.scaled === false && safe.x === 5 && safe.y === 0,
  JSON.stringify(safe));
const corner = BaseGeometry.clampMagnetOffset(clampParams, 18.5, 18.5, 1.5);
check('clampMagnetOffset: corner offset scaled back',
  corner.scaled === true && corner.x < 18.5 && Math.abs(corner.x - corner.y) < 1e-9,
  JSON.stringify(corner));
const noOffset = BaseGeometry.clampMagnetOffset(clampParams, 0, 0, 1.5);
check('clampMagnetOffset: zero offset is a no-op',
  noOffset.scaled === false && noOffset.x === 0 && noOffset.y === 0);

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
check('STL triangle count field', new DataView(buf).getUint32(80, true) === T);
// first facet normal is unit length
const dv = new DataView(buf);
const n = [dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true)];
const nlen = Math.hypot(n[0], n[1], n[2]);
check('STL first normal unit length', Math.abs(nlen - 1) < 1e-5, 'len=' + nlen);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
