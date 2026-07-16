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
   * inserted 45-degree angles.
   */
  function sampleLoop(shape, rx, ry, angles) {
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
      pts[2 * i] = x;
      pts[2 * i + 1] = y;
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

  /* Cap fanned from the loop centroid (origin). down=true faces -Z. */
  function fan(out, loop, z, down) {
    var n = loop.length / 2;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var ax = loop[2 * i], ay = loop[2 * i + 1];
      var bx = loop[2 * j], by = loop[2 * j + 1];
      if (down) {
        tri(out, 0, 0, z, bx, by, z, ax, ay, z);
      } else {
        tri(out, 0, 0, z, ax, ay, z, bx, by, z);
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

  /*
   * Build the raw triangle soup for a base. Returns a plain number array of
   * positions (x,y,z per vertex, 3 vertices per triangle). Kept free of any
   * THREE dependency so it can be tested headlessly.
   *
   * params: {
   *   shape: 'round' | 'ellipse' | 'square',
   *   diameter, width, depth, side,           // per-shape footprint (mm)
   *   height, bevel,                          // bevel 0 = none
   *   magnet: { enabled, diameter, depth }
   * }
   */
  function buildPositions(params) {
    var shape = params.shape;
    var rx, ry;
    if (shape === 'round') {
      rx = ry = params.diameter / 2;
    } else if (shape === 'ellipse') {
      rx = params.width / 2;
      ry = params.depth / 2;
    } else {
      rx = ry = params.side / 2;
    }

    var H = params.height;
    var bevel = Math.max(0, Math.min(params.bevel || 0, H - 0.05, rx - 0.1, ry - 0.1));

    var angles = buildAngleList(shape);
    var outer = sampleLoop(shape, rx, ry, angles);
    var positions = [];

    var m = params.magnet || {};
    var hasMagnet = !!m.enabled &&
      m.diameter > 0 && m.depth > 0 &&
      m.diameter / 2 < Math.min(rx, ry) - 0.2 &&
      m.depth < H - 0.05;

    if (hasMagnet) {
      var hole = sampleLoop('round', m.diameter / 2, m.diameter / 2, angles);
      annulus(positions, hole, outer, 0);
      bridge(positions, hole, 0, hole, m.depth, true);
      fan(positions, hole, m.depth, true);
    } else {
      fan(positions, outer, 0, true);
    }

    var wallTop = H - bevel;
    if (wallTop > 1e-6) {
      bridge(positions, outer, 0, outer, wallTop, false);
    }
    if (bevel > 1e-6) {
      var inset = sampleLoop(shape, rx - bevel, ry - bevel, angles);
      bridge(positions, outer, wallTop, inset, H, false);
      fan(positions, inset, H, false);
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
    buildPositions: buildPositions
  };
})();
