/*
 * geometry.js — procedural mesh construction for miniature bases.
 *
 * All dimensions are millimetres, the model is built Z-up (footprint in the
 * XY plane, height along +Z) so the exported STL needs no transformation.
 *
 * No CSG: every supported outline (circle, ellipse, square) is star-convex
 * around the origin, so all loops are sampled at one shared angle list and
 * bridged index-to-index. The magnet recess is built directly into the
 * bottom face, which keeps the mesh watertight by construction.
 */
window.BaseGeometry = (function () {
  'use strict';

  var TAU = Math.PI * 2;
  var SEGMENTS = 96;
  var FILLET_STEPS = 8; /* rings in a round bevel; sagitta ~0.005*bevel matches the 96-gon chord error */

  /* Uniform angles plus the shape's exact corner angles (deduplicated). */
  function buildAngleList(shape) {
    var angles = [];
    var i;
    for (i = 0; i < SEGMENTS; i++) angles.push(i * TAU / SEGMENTS);
    if (shape === 'square') {
      var corners = [0.25, 0.75, 1.25, 1.75];
      for (i = 0; i < corners.length; i++) {
        var c = corners[i] * Math.PI;
        var present = angles.some(function (a) { return Math.abs(a - c) < 1e-9; });
        if (!present) angles.push(c);
      }
      angles.sort(function (a, b) { return a - b; });
    }
    return angles;
  }

  /*
   * Sample one closed outline (CCW viewed from +Z) at the shared angles.
   * rx/ry are half-extents; the square uses the radial support function
   * r(t) = rx / max(|cos t|, |sin t|) so corners land exactly on the
   * inserted 45-degree angles. cx/cy translate the loop (default origin).
   */
  function sampleLoop(shape, rx, ry, angles, cx, cy) {
    cx = cx || 0;
    cy = cy || 0;
    var pts = new Float64Array(angles.length * 2);
    for (var i = 0; i < angles.length; i++) {
      var c = Math.cos(angles[i]);
      var s = Math.sin(angles[i]);
      var x, y;
      if (shape === 'square') {
        var m = Math.max(Math.abs(c), Math.abs(s));
        x = rx * c / m;
        y = ry * s / m;
      } else {
        x = rx * c;
        y = ry * s;
      }
      pts[2 * i] = cx + x;
      pts[2 * i + 1] = cy + y;
    }
    return pts;
  }

  function tri(out, ax, ay, az, bx, by, bz, cx, cy, cz) {
    out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }

  /*
   * Wall band between two index-aligned loops. Default winding gives
   * radially outward normals; flip=true gives inward normals (used for the
   * magnet recess wall, whose material-outward direction points at the axis).
   */
  function bridge(out, lo, zLo, hi, zHi, flip) {
    var n = lo.length / 2;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var ax = lo[2 * i], ay = lo[2 * i + 1];
      var bx = lo[2 * j], by = lo[2 * j + 1];
      var cx = hi[2 * j], cy = hi[2 * j + 1];
      var dx = hi[2 * i], dy = hi[2 * i + 1];
      if (flip) {
        tri(out, ax, ay, zLo, cx, cy, zHi, bx, by, zLo);
        tri(out, ax, ay, zLo, dx, dy, zHi, cx, cy, zHi);
      } else {
        tri(out, ax, ay, zLo, bx, by, zLo, cx, cy, zHi);
        tri(out, ax, ay, zLo, cx, cy, zHi, dx, dy, zHi);
      }
    }
  }

  /* Cap fanned from an apex inside the loop (default origin). down=true faces -Z. */
  function fan(out, loop, z, down, cx, cy) {
    cx = cx || 0;
    cy = cy || 0;
    var n = loop.length / 2;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var ax = loop[2 * i], ay = loop[2 * i + 1];
      var bx = loop[2 * j], by = loop[2 * j + 1];
      if (down) {
        tri(out, cx, cy, z, bx, by, z, ax, ay, z);
      } else {
        tri(out, cx, cy, z, ax, ay, z, bx, by, z);
      }
    }
  }

  /* Flat ring between two index-aligned loops, facing -Z (bottom face). */
  function annulus(out, inner, outer, z) {
    var n = inner.length / 2;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var ix = inner[2 * i], iy = inner[2 * i + 1];
      var jx = inner[2 * j], jy = inner[2 * j + 1];
      var ox = outer[2 * i], oy = outer[2 * i + 1];
      var px = outer[2 * j], py = outer[2 * j + 1];
      tri(out, ix, iy, z, px, py, z, ox, oy, z);
      tri(out, ix, iy, z, jx, jy, z, px, py, z);
    }
  }

  function resolveRadii(params) {
    if (params.shape === 'round') {
      var r = params.diameter / 2;
      return { rx: r, ry: r };
    }
    if (params.shape === 'ellipse') {
      return { rx: params.width / 2, ry: params.depth / 2 };
    }
    var h = params.side / 2;
    return { rx: h, ry: h };
  }

  function clampBevel(params, rx, ry) {
    return Math.max(0, Math.min(params.bevel || 0, params.height - 0.05, rx - 0.1, ry - 0.1));
  }

  /* Radial inset of the top bevel surface at height z (0 at or below the wall top). */
  function bevelInsetAtZ(bevel, bevelType, wallTop, z) {
    var over = z - wallTop;
    if (bevel <= 1e-6 || over <= 0) return 0;
    if (over > bevel) over = bevel;
    if (bevelType === 'round') return bevel - Math.sqrt(bevel * bevel - over * over);
    return over; /* flat chamfer is exactly 45 degrees */
  }

  /*
   * Largest scale t in [0,1] so the magnet hole centered at (t*ox, t*oy)
   * (a) keeps `margin` clearance to the effective outline along every
   * sampled direction — the wall guarantee — and (b) keeps both bottom
   * annulus triangles of every quad against the true outline non-inverted
   * (the support condition alone is only the first-order version of (b)
   * and misses second-order chord effects near square corners). Every
   * constraint is linear in the hole center, hence linear in t, and the
   * centered placement satisfies all of them, so taking the minimum
   * upper bound is exact.
   */
  function offsetScale(outer, effOuter, angles, holeR, ox, oy, margin) {
    var EPS = 1e-6;
    var n = angles.length;
    var t = 1;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var uix = Math.cos(angles[i]), uiy = Math.sin(angles[i]);
      var ujx = Math.cos(angles[j]), ujy = Math.sin(angles[j]);
      var ojx = outer[2 * j], ojy = outer[2 * j + 1];

      /* wall: (effOuter_i - t*p) . u_i >= holeR + margin */
      var room = effOuter[2 * i] * uix + effOuter[2 * i + 1] * uiy - holeR - margin;
      if (room <= 0) return 0;
      var proj = ox * uix + oy * uiy;
      if (proj > 0 && room / proj < t) t = room / proj;

      /* annulus triangle (h_i, h_j, o_j): cross(h_j - h_i, o_j - h_i) <= -EPS */
      var dx = holeR * (ujx - uix), dy = holeR * (ujy - uiy);
      var aB = dx * (ojy - holeR * uiy) - dy * (ojx - holeR * uix);
      var bB = -(dx * oy - dy * ox);
      if (bB > 0 && (-EPS - aB) / bB < t) t = (-EPS - aB) / bB;

      /* annulus triangle (h_i, o_j, o_i): cross(o_j - h_i, o_i - h_i) <= -EPS */
      var ex = outer[2 * i] - ojx, ey = outer[2 * i + 1] - ojy;
      var aA = (ojx * outer[2 * i + 1] - ojy * outer[2 * i]) +
               holeR * (ex * uiy - ey * uix);
      var bA = ex * oy - ey * ox;
      if (bA > 0 && (-EPS - aA) / bA < t) t = (-EPS - aA) / bA;
    }
    return Math.max(0, Math.min(1, t));
  }

  /*
   * Outline the magnet must clear: the footprint, or — when the recess
   * ceiling rises into the bevel — the bevel surface at ceiling height.
   */
  function magnetEffectiveOutline(params, rx, ry, bevel, angles, outer) {
    var m = params.magnet || {};
    var inset = bevelInsetAtZ(bevel, params.bevelType, params.height - bevel, m.depth || 0);
    if (inset <= 0) return outer;
    return sampleLoop(params.shape, rx - inset, ry - inset, angles);
  }

  /*
   * Public clamp for UI validation: scale a requested magnet offset back
   * onto the largest safe placement. Reads footprint, height, bevel,
   * bevelType and the candidate magnet.diameter/depth from params.
   * Returns { x, y, scaled }.
   */
  function clampMagnetOffset(params, ox, oy, margin) {
    if (!ox && !oy) return { x: 0, y: 0, scaled: false };
    var r = resolveRadii(params);
    var bevel = clampBevel(params, r.rx, r.ry);
    var m = params.magnet || {};
    var angles = buildAngleList(params.shape);
    var outer = sampleLoop(params.shape, r.rx, r.ry, angles);
    var eff = magnetEffectiveOutline(params, r.rx, r.ry, bevel, angles, outer);
    var t = offsetScale(outer, eff, angles, (m.diameter || 0) / 2, ox, oy, margin);
    return { x: ox * t, y: oy * t, scaled: t < 1 - 1e-12 };
  }

  /*
   * Build the raw triangle soup for a base. Returns a plain number array of
   * positions (x,y,z per vertex, 3 vertices per triangle). Kept free of any
   * THREE dependency so it can be tested headlessly.
   *
   * params: {
   *   shape: 'round' | 'ellipse' | 'square',
   *   diameter, width, depth, side,           // per-shape footprint (mm)
   *   height, bevel,                          // bevel 0 = none
   *   bevelType: 'flat' | 'round',            // default 'flat'
   *   magnet: { enabled, diameter, depth, offsetX, offsetY }
   * }
   */
  function buildPositions(params) {
    var shape = params.shape;
    var radii = resolveRadii(params);
    var rx = radii.rx, ry = radii.ry;

    var H = params.height;
    var bevel = clampBevel(params, rx, ry);
    var wallTop = H - bevel;

    var angles = buildAngleList(shape);
    var outer = sampleLoop(shape, rx, ry, angles);
    var positions = [];

    var m = params.magnet || {};
    var hasMagnet = !!m.enabled &&
      m.diameter > 0 && m.depth > 0 &&
      m.diameter / 2 < Math.min(rx, ry) - 0.2 &&
      m.depth < H - 0.05;

    if (hasMagnet) {
      var hr = m.diameter / 2;
      var ox = m.offsetX || 0;
      var oy = m.offsetY || 0;
      if (ox !== 0 || oy !== 0) {
        /* Defensive clamp with the same 0.2 mm slack as the gate above. */
        var eff = magnetEffectiveOutline(params, rx, ry, bevel, angles, outer);
        var t = offsetScale(outer, eff, angles, hr, ox, oy, 0.2);
        ox *= t;
        oy *= t;
      }
      var hole = sampleLoop('round', hr, hr, angles, ox, oy);
      annulus(positions, hole, outer, 0);
      bridge(positions, hole, 0, hole, m.depth, true);
      fan(positions, hole, m.depth, true, ox, oy); /* apex at hole center — required for validity */
    } else {
      fan(positions, outer, 0, true);
    }

    if (wallTop > 1e-6) {
      bridge(positions, outer, 0, outer, wallTop, false);
    }
    if (bevel > 1e-6) {
      if (params.bevelType === 'round') {
        var prev = outer, prevZ = wallTop; /* ring 0 = outer, reused verbatim */
        for (var k = 1; k <= FILLET_STEPS; k++) {
          var last = (k === FILLET_STEPS);
          var phi = k * (Math.PI / 2) / FILLET_STEPS;
          /* endpoints set exactly so the model is exactly H tall and welds are bit-identical */
          var ins = last ? bevel : bevel * (1 - Math.cos(phi));
          var z = last ? H : wallTop + bevel * Math.sin(phi);
          var ring = sampleLoop(shape, rx - ins, ry - ins, angles);
          bridge(positions, prev, prevZ, ring, z, false);
          prev = ring;
          prevZ = z;
        }
        fan(positions, prev, H, false);
      } else {
        var inset = sampleLoop(shape, rx - bevel, ry - bevel, angles);
        bridge(positions, outer, wallTop, inset, H, false);
        fan(positions, inset, H, false);
      }
    } else {
      fan(positions, outer, H, false);
    }

    return positions;
  }

  /* Build a THREE.BufferGeometry with flat per-facet normals. */
  function build(params) {
    var positions = buildPositions(params);
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
  }

  return {
    build: build,
    buildPositions: buildPositions,
    clampMagnetOffset: clampMagnetOffset
  };
})();
