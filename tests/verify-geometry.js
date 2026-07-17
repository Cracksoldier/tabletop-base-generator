/* Headless verification of geometry.js and exporter.js */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const window = {};
eval(fs.readFileSync(path.join(root, 'js/geometry.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'js/exporter.js'), 'utf8'));
// heightmap.js touches document/FileReader/Image only inside load(); its pure
// sample()/makeDisplace() eval fine under Node and are what the tests exercise.
eval(fs.readFileSync(path.join(root, 'js/heightmap.js'), 'utf8'));
const BaseGeometry = window.BaseGeometry;
const StlExport = window.StlExport;
const HeightMap = window.HeightMap;

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

// mirrors segmentsFor: terrain raises the shared angular density in step with
// the ring count (rings*4, floored at 96, capped at 384, divisible by 4)
function segmentsFor(p) {
  const t = p.terrain || {};
  if (!(t.enabled && typeof t.displace === 'function' && t.rings > 0)) return 96;
  let s, cap;
  if (t.segments > 0) { s = Math.round(t.segments); cap = 1024; }
  else { s = Math.round(t.rings) * 4; cap = 384; }
  s = Math.max(96, Math.min(cap, s));
  return s - (s % 4);
}

// mirrors buildAngleList: N uniform angles, square corner angles, and the
// slit's corner angles (atan2(width, length) and reflections) when active
function angleListFor(p) {
  const TAU = 2 * Math.PI;
  const segments = segmentsFor(p);
  const angles = [];
  for (let i = 0; i < segments; i++) angles.push(i * TAU / segments);
  const extra = [];
  if (p.shape === 'square') {
    for (const c of [0.25, 0.75, 1.25, 1.75]) extra.push(c * Math.PI);
  }
  if (p.slit && p.slit.enabled && p.slit.length > 0 && p.slit.width > 0) {
    const ca = Math.atan2(p.slit.width, p.slit.length);
    extra.push(ca, Math.PI - ca, Math.PI + ca, TAU - ca);
  }
  for (const c of extra) {
    if (!angles.some(a => Math.abs(a - c) < 1e-9)) angles.push(c);
  }
  angles.sort((a, b) => a - b);
  return angles;
}

// polygon area factor for an ellipse sampled at the angle list: A = Cang*rx*ry
function Cang(angles) {
  let sum = 0;
  for (let i = 0; i < angles.length; i++) {
    const j = (i + 1) % angles.length;
    const d = angles[j] - angles[i] + (j === 0 ? 2 * Math.PI : 0);
    sum += Math.sin(d);
  }
  return 0.5 * sum;
}

function bandVol(C, rx1, ry1, z1, rx2, ry2, z2) {
  return (z2 - z1) / 6 * C * (rx1 * ry1 + 4 * ((rx1 + rx2) / 2) * ((ry1 + ry2) / 2) + rx2 * ry2);
}

function analyticVolume(p, magnetDropped) {
  const Cpoly = Cang(angleListFor(p));
  const C = p.shape === 'square' ? 4 : Cpoly;
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
  if (p.magnet && p.magnet.enabled && !magnetDropped) {
    v -= Cpoly * Math.pow(p.magnet.diameter / 2, 2) * p.magnet.depth;
  }
  if (p.slit && p.slit.enabled && p.slit.length > 0 && p.slit.width > 0) {
    v -= p.slit.length * p.slit.width * p.height; // sampled rectangle is exact
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

/* ---------- slit (cut all the way through) ---------- */

// slit-only, per shape x bevel type — safe dims, so the volume is exact
const slitDims = {
  round: { length: 20, width: 3 },
  ellipse: { length: 30, width: 4 },
  square: { length: 14, width: 2 }
};
for (const shape of ['round', 'ellipse', 'square']) {
  for (const bv of bevelVariants) {
    cases.push({
      name: shape + ' slit bevel=' + bv.label,
      exact: true,
      params: { shape, diameter: 32, width: 60, depth: 35, side: 25,
                height: 4, bevel: bv.bevel, bevelType: bv.bevelType,
                magnet: { enabled: false },
                slit: { enabled: true, ...slitDims[shape] } }
    });
  }
}
// slit + magnet clearing the slit: the two-hole bottom cap (capWithHoles)
const slitMagnets = {
  round: { enabled: true, diameter: 5, depth: 2, offsetX: 0, offsetY: 6.5 },
  ellipse: { enabled: true, diameter: 5, depth: 2, offsetX: 12, offsetY: -8 },
  square: { enabled: true, diameter: 4, depth: 2, offsetX: 0, offsetY: 7 }
};
for (const shape of ['round', 'ellipse', 'square']) {
  cases.push({
    name: shape + ' slit + clearing offset magnet',
    exact: true,
    params: { shape, diameter: 32, width: 60, depth: 35, side: 25,
              height: 4, bevel: 0, bevelType: 'flat',
              magnet: slitMagnets[shape],
              slit: { enabled: true, ...slitDims[shape] } }
  });
}
// a centered magnet cannot clear the slit and must be dropped entirely
cases.push({ name: 'slit + centered magnet (magnet dropped)',
  exact: true, magnetDropped: true,
  params: { shape: 'round', diameter: 32, height: 4, bevel: 0,
            magnet: { enabled: true, diameter: 5, depth: 2 },
            slit: { enabled: true, length: 20, width: 3 } } });
// pushing this fat magnet clear of the slit would breach the wall — dropped
cases.push({ name: 'slit + magnet with no room to clear (magnet dropped)',
  exact: true, magnetDropped: true,
  params: { shape: 'round', diameter: 32, height: 4, bevel: 0,
            magnet: { enabled: true, diameter: 8, depth: 2, offsetX: 3, offsetY: 0 },
            slit: { enabled: true, length: 20, width: 3 } } });
// a small offset is pushed outward to the slit clearance (volume is
// translation invariant, so it stays exact)
cases.push({ name: 'slit + magnet pushed sideways clear of the slit',
  exact: true,
  params: { shape: 'round', diameter: 32, height: 4, bevel: 0,
            magnet: { enabled: true, diameter: 5, depth: 2, offsetX: 0, offsetY: 2 },
            slit: { enabled: true, length: 20, width: 3 } } });
// magnet just clearing the defensive margin
cases.push({ name: 'slit + magnet barely clearing',
  exact: true,
  params: { shape: 'round', diameter: 40, height: 4, bevel: 0,
            magnet: { enabled: true, diameter: 6, depth: 2, offsetX: 0, offsetY: 7.2 },
            slit: { enabled: true, length: 24, width: 4 } } });
// diagonal push past the slit end exercises the corner-exit quadratic and a
// bridge normal that differs from the offset ray
cases.push({ name: 'slit + diagonal magnet pushed around the slit end',
  exact: true,
  params: { shape: 'round', diameter: 40, height: 4, bevel: 1, bevelType: 'round',
            magnet: { enabled: true, diameter: 5, depth: 2, offsetX: 11, offsetY: 2 },
            slit: { enabled: true, length: 20, width: 3 } } });
// square slit in a square base: corner angles dedupe against the 45° entries
cases.push({ name: 'square slit W=L (45-degree corner dedupe)',
  exact: true,
  params: { shape: 'square', side: 30, height: 4, bevel: 0,
            magnet: { enabled: false },
            slit: { enabled: true, length: 8, width: 8 } } });
// wide slit reaching toward the square corners, under a flat bevel
cases.push({ name: 'wide slit near square corners',
  exact: true,
  params: { shape: 'square', side: 40, height: 4, bevel: 1, bevelType: 'flat',
            magnet: { enabled: false },
            slit: { enabled: true, length: 30, width: 24 } } });
// oversized request: the defensive clamp must land somewhere valid
cases.push({ name: 'slit longer than the base (defensive clamp)',
  params: { shape: 'round', diameter: 32, height: 4, bevel: 0,
            magnet: { enabled: false },
            slit: { enabled: true, length: 40, width: 3 } } });
// ellipse-skew regression: contained-with-margin yet would invert annulus
// triangles — the clamp's explicit non-inversion conditions must catch it
cases.push({ name: 'skewed oval slit (inversion regression, defensive clamp)',
  params: { shape: 'ellipse', width: 105, depth: 42, height: 4, bevel: 0,
            magnet: { enabled: false },
            slit: { enabled: true, length: 50.5, width: 33.5 } } });

for (const c of cases) {
  const positions = BaseGeometry.buildPositions(c.params);
  const r = analyze(positions);
  check(c.name + ': manifold', r.badEdges === 0, r.badEdges + ' bad edges');
  check(c.name + ': no degenerate tris', r.degenerate === 0, r.degenerate + ' degenerate');
  check(c.name + ': positive volume', r.volume > 0, 'volume=' + r.volume.toFixed(3));
  check(c.name + ': horizontal facets oriented', r.badHoriz === 0, r.badHoriz + ' misoriented');
  if (c.exact) {
    const want = analyticVolume(c.params, c.magnetDropped);
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

// slit monotonicity: the through-cut removes material on every shape
for (const shape of ['round', 'ellipse', 'square']) {
  const plain = cases.find(c => c.name === shape + ' bevel=none magnet=off').volume;
  const slit = cases.find(c => c.name === shape + ' slit bevel=none').volume;
  check(shape + ': slit removes material', slit < plain,
    slit + ' vs ' + plain);
}

// clampSlitSize: safe requests pass through, oversized ones scale back
const slitClampParams = { shape: 'round', diameter: 32, height: 4, bevel: 0 };
const slitSafe = BaseGeometry.clampSlitSize(slitClampParams, 20, 3, 1.5);
check('clampSlitSize: safe slit unchanged',
  slitSafe.scaled === false && slitSafe.length === 20 && slitSafe.width === 3,
  JSON.stringify(slitSafe));
const slitLong = BaseGeometry.clampSlitSize(slitClampParams, 40, 3, 1.5);
check('clampSlitSize: oversized slit scaled back',
  slitLong.scaled === true && slitLong.length <= 29 + 1e-9 && slitLong.length > 20,
  JSON.stringify(slitLong));
// the skewed-oval case: fully contained with margin, yet must come back
// scaled because annulus triangles would invert (containment is not enough)
const ovalParams = { shape: 'ellipse', width: 105, depth: 42, height: 4, bevel: 0 };
const ovalSlit = BaseGeometry.clampSlitSize(ovalParams, 50.5, 33.5, 1.5);
check('clampSlitSize: skewed oval slit scaled back', ovalSlit.scaled === true,
  JSON.stringify(ovalSlit));
const ovalBuilt = BaseGeometry.buildPositions({ ...ovalParams,
  magnet: { enabled: false },
  slit: { enabled: true, length: ovalSlit.length, width: ovalSlit.width } });
const ovalR = analyze(ovalBuilt);
check('clampSlitSize: clamped oval slit builds clean',
  ovalR.badEdges === 0 && ovalR.degenerate === 0 && ovalR.badHoriz === 0 && ovalR.volume > 0,
  JSON.stringify({ badEdges: ovalR.badEdges, degenerate: ovalR.degenerate,
                   badHoriz: ovalR.badHoriz }));

// clampMagnetOffset with an active slit: pull back, push out, or reject
const slitMagParams = { shape: 'round', diameter: 32, height: 4, bevel: 0,
                        magnet: { enabled: true, diameter: 5, depth: 2 },
                        slit: { enabled: true, length: 20, width: 3 } };
const clear = BaseGeometry.clampMagnetOffset(slitMagParams, 0, 8, 1.5);
check('clampMagnetOffset+slit: clear offset unchanged',
  clear.valid === true && clear.pushed === false && clear.scaled === false &&
  clear.x === 0 && clear.y === 8, JSON.stringify(clear));
const pushed = BaseGeometry.clampMagnetOffset(slitMagParams, 0, 2, 1.5);
check('clampMagnetOffset+slit: near offset pushed clear',
  pushed.valid === true && pushed.pushed === true &&
  Math.abs(pushed.y - 5.5) < 1e-9 && pushed.x === 0, JSON.stringify(pushed));
const centered = BaseGeometry.clampMagnetOffset(slitMagParams, 0, 0, 1.5);
check('clampMagnetOffset+slit: centered magnet invalid', centered.valid === false,
  JSON.stringify(centered));
const alongSlit = BaseGeometry.clampMagnetOffset(slitMagParams, 5, 0, 1.5);
check('clampMagnetOffset+slit: no room along the long axis',
  alongSlit.valid === false, JSON.stringify(alongSlit));

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

/* ---------- terrain (height-map top surface) ---------- */

// Sampler unit tests: a synthetic 2x2 buffer, columns dark->bright, and (with
// the V flip) row 0 = top. RGBA rows are laid out top-to-bottom like a real
// image. Luminance of a gray pixel (r=g=b=v) is v/255.
function grayBuf(rows) {
  const h = rows.length, w = rows[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = rows[y][x];
    data[o + 3] = 255;
  }
  return { data, width: w, height: h };
}
// row 0 (image top) = [0,255], row 1 (image bottom) = [0,255]
const sbuf = grayBuf([[0, 255], [0, 255]]);
check('sample: left edge is black (0)', Math.abs(HeightMap.sample(sbuf, 0, 0.5) - 0) < 1e-9,
  HeightMap.sample(sbuf, 0, 0.5));
check('sample: right edge is white (1)', Math.abs(HeightMap.sample(sbuf, 1, 0.5) - 1) < 1e-9,
  HeightMap.sample(sbuf, 1, 0.5));
check('sample: horizontal midpoint bilinear (0.5)',
  Math.abs(HeightMap.sample(sbuf, 0.5, 0.5) - 0.5) < 1e-9, HeightMap.sample(sbuf, 0.5, 0.5));
// V flip: top row vs bottom row. Use a vertical gradient: image row0=0, row1=255.
// v=1 (footprint back) maps to image row 0 (top) => 0; v=0 maps to row1 => 1.
const vbuf = grayBuf([[0, 0], [255, 255]]);
check('sample: V flip top (v=1 -> image row 0)', Math.abs(HeightMap.sample(vbuf, 0.5, 1) - 0) < 1e-9,
  HeightMap.sample(vbuf, 0.5, 1));
check('sample: V flip bottom (v=0 -> image row 1)', Math.abs(HeightMap.sample(vbuf, 0.5, 0) - 1) < 1e-9,
  HeightMap.sample(vbuf, 0.5, 0));
check('sample: clamps out-of-range UV', Math.abs(HeightMap.sample(sbuf, 2, -1) - 1) < 1e-9,
  HeightMap.sample(sbuf, 2, -1));

// makeDisplace: brightness*relief + baseOffset, with invert
const dsp = HeightMap.makeDisplace(sbuf, { rx: 10, ry: 10, reliefHeight: 4, baseOffset: 1, invert: false });
check('makeDisplace: black -> baseOffset', Math.abs(dsp(-10, 0) - 1) < 1e-9, dsp(-10, 0));
check('makeDisplace: white -> baseOffset + relief', Math.abs(dsp(10, 0) - 5) < 1e-9, dsp(10, 0));
const dspInv = HeightMap.makeDisplace(sbuf, { rx: 10, ry: 10, reliefHeight: 4, baseOffset: 0, invert: true });
check('makeDisplace: invert flips black<->white', Math.abs(dspInv(-10, 0) - 4) < 1e-9, dspInv(-10, 0));

// Geometry: synthetic displace closures (no image needed)
const flat = () => 0;
const bump = (x, y) => 1.5 * Math.exp(-(x * x + y * y) / 40); // smooth radial hill

// displace=0 reproduces the flat top exactly -> volume equals the flat base
for (const shape of ['round', 'ellipse', 'square']) {
  for (const bv of bevelVariants) {
    const base = { shape, diameter: 32, width: 60, depth: 35, side: 25,
      height: 4, bevel: bv.bevel, bevelType: bv.bevelType, magnet: { enabled: false } };
    const flatPos = BaseGeometry.buildPositions({ ...base,
      terrain: { enabled: true, rings: 24, displace: flat } });
    const r = analyze(flatPos);
    const want = analyticVolume(base);
    check(shape + ' terrain(0) bevel=' + bv.label + ': manifold + oriented',
      r.badEdges === 0 && r.degenerate === 0 && r.badHoriz === 0,
      JSON.stringify({ badEdges: r.badEdges, degenerate: r.degenerate, badHoriz: r.badHoriz }));
    check(shape + ' terrain(0) bevel=' + bv.label + ': volume equals flat base',
      Math.abs(r.volume - want) < 1e-6, 'got ' + r.volume + ' expected ' + want);
  }
}

// added volume is exactly linear in constant relief c (every terrain vertex
// moves linearly with c; projected triangle areas are fixed) -> a closed-form-
// free exact check: V(2c) - V(0) == 2*(V(c) - V(0))
function terrainVol(c) {
  return analyze(BaseGeometry.buildPositions({
    shape: 'round', diameter: 32, height: 4, bevel: 0, magnet: { enabled: false },
    terrain: { enabled: true, rings: 24, displace: () => c }
  })).volume;
}
const v0 = terrainVol(0), v1 = terrainVol(1), v2 = terrainVol(2);
check('terrain: constant relief adds material', v1 > v0, v1 + ' vs ' + v0);
check('terrain: added volume linear in relief',
  Math.abs((v2 - v0) - 2 * (v1 - v0)) < 1e-6, (v2 - v0) + ' vs ' + 2 * (v1 - v0));
// flat rim pins the boundary to 0, so the plateau can't cover the full top area
const topArea = C96 * 16 * 16;
check('terrain: constant added volume within flat-rim bound',
  (v1 - v0) > 0 && (v1 - v0) < topArea * 1, (v1 - v0) + ' vs ' + topArea);

// topological matrix: terrain x shape x bevel x magnet with a real relief map
for (const shape of ['round', 'ellipse', 'square']) {
  for (const bv of bevelVariants) {
    for (const mv of magnetVariants) {
      const p = { shape, diameter: 32, width: 60, depth: 35, side: 25,
        height: 6, bevel: bv.bevel, bevelType: bv.bevelType, magnet: mv.magnet,
        terrain: { enabled: true, rings: 24, displace: bump } };
      const r = analyze(BaseGeometry.buildPositions(p));
      const nm = shape + ' terrain bevel=' + bv.label + ' magnet=' + mv.label;
      check(nm + ': manifold', r.badEdges === 0, r.badEdges + ' bad edges');
      check(nm + ': no degenerate tris', r.degenerate === 0, r.degenerate + ' degenerate');
      check(nm + ': positive volume', r.volume > 0, 'volume=' + r.volume.toFixed(3));
      check(nm + ': horizontal facets oriented', r.badHoriz === 0, r.badHoriz + ' misoriented');
    }
  }
}

// terrain wins over slit: both requested -> the slit is dropped, mesh is clean,
// and the volume matches a terrain-only build (no through-cut removed)
const bothPos = BaseGeometry.buildPositions({
  shape: 'round', diameter: 32, height: 4, bevel: 0, magnet: { enabled: false },
  slit: { enabled: true, length: 20, width: 3 },
  terrain: { enabled: true, rings: 24, displace: bump } });
const bothR = analyze(bothPos);
const terrainOnly = analyze(BaseGeometry.buildPositions({
  shape: 'round', diameter: 32, height: 4, bevel: 0, magnet: { enabled: false },
  terrain: { enabled: true, rings: 24, displace: bump } }));
check('terrain + slit: slit dropped, mesh clean',
  bothR.badEdges === 0 && bothR.degenerate === 0 && bothR.badHoriz === 0 &&
  Math.abs(bothR.volume - terrainOnly.volume) < 1e-9,
  JSON.stringify({ badEdges: bothR.badEdges, degenerate: bothR.degenerate,
    badHoriz: bothR.badHoriz, dv: bothR.volume - terrainOnly.volume }));

// different ring counts all stay manifold (and change triangle count)
const rLow = analyze(BaseGeometry.buildPositions({ shape: 'round', diameter: 32, height: 4,
  bevel: 1, bevelType: 'round', magnet: { enabled: false },
  terrain: { enabled: true, rings: 12, displace: bump } }));
const rHigh = analyze(BaseGeometry.buildPositions({ shape: 'round', diameter: 32, height: 4,
  bevel: 1, bevelType: 'round', magnet: { enabled: false },
  terrain: { enabled: true, rings: 48, displace: bump } }));
check('terrain: low + high resolution both manifold',
  rLow.badEdges === 0 && rHigh.badEdges === 0 && rHigh.triCount > rLow.triCount,
  JSON.stringify({ low: rLow.triCount, high: rHigh.triCount }));
// custom resolution reaches well past the High preset (UI allows up to 256)
const rMax = analyze(BaseGeometry.buildPositions({ shape: 'ellipse', width: 60, depth: 35,
  height: 4, bevel: 1, bevelType: 'flat', magnet: { enabled: true, diameter: 5, depth: 2 },
  terrain: { enabled: true, rings: 256, displace: bump } }));
check('terrain: max custom resolution (256 rings) manifold',
  rMax.badEdges === 0 && rMax.degenerate === 0 && rMax.badHoriz === 0 && rMax.volume > 0,
  JSON.stringify({ badEdges: rMax.badEdges, degenerate: rMax.degenerate,
    badHoriz: rMax.badHoriz, tris: rMax.triCount }));
// explicit angular segment override (custom) decouples angular from radial
// density: same rings, more segments -> more triangles, still manifold, and
// displace=0 still reproduces the flat base exactly at the overridden density
const segBase = { shape: 'ellipse', width: 60, depth: 35, height: 4, bevel: 1,
  bevelType: 'round', magnet: { enabled: true, diameter: 5, depth: 2 } };
const segAuto = analyze(BaseGeometry.buildPositions({ ...segBase,
  terrain: { enabled: true, rings: 24, displace: bump } }));
const segHi = analyze(BaseGeometry.buildPositions({ ...segBase,
  terrain: { enabled: true, rings: 24, segments: 512, displace: bump } }));
check('terrain: segment override raises angular density independently',
  segHi.badEdges === 0 && segHi.degenerate === 0 && segHi.badHoriz === 0 &&
  segHi.triCount > segAuto.triCount,
  JSON.stringify({ auto: segAuto.triCount, override: segHi.triCount }));
const segFlatBase = { shape: 'round', diameter: 32, height: 4, bevel: 0, magnet: { enabled: false } };
const segFlat = analyze(BaseGeometry.buildPositions({ ...segFlatBase,
  terrain: { enabled: true, rings: 24, segments: 300, displace: () => 0 } }));
check('terrain: segment override displace(0) equals flat base',
  Math.abs(segFlat.volume - analyticVolume({ ...segFlatBase,
    terrain: { enabled: true, rings: 24, segments: 300, displace: () => 0 } })) < 1e-6,
  'got ' + segFlat.volume);

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
