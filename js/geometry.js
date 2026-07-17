/*
 * geometry.js — procedural mesh construction for miniature bases.
 *
 * All dimensions are millimetres, the model is built Z-up (footprint in the
 * XY plane, height along +Z) so the exported STL needs no transformation.
 *
 * No CSG: every supported outline (circle, ellipse, square, hexagon,
 * rounded square) is star-convex around the origin, so all loops are
 * sampled at one shared angle list and bridged index-to-index. The magnet
 * recess is built directly into the bottom face, which keeps the mesh
 * watertight by construction.
 */
window.BaseGeometry = (function () {
  'use strict';

  var TAU = Math.PI * 2;
  var SEGMENTS = 96;
  var FILLET_STEPS = 8; /* rings in a round bevel; sagitta ~0.005*bevel matches the 96-gon chord error */

  /*
   * Uniform angles plus exact corner angles (deduplicated): the square's
   * 45-degree diagonals, and — when a slit is active — the slit rectangle's
   * corner angles atan2(width, length) and their reflections, so the slit
   * loop has exact corners on every base shape.
   */
  function buildAngleList(shape, slit, segments, h, cornerRadius) {
    segments = segments || SEGMENTS;
    var angles = [];
    var i;
    for (i = 0; i < segments; i++) angles.push(i * TAU / segments);
    var extra = [];
    if (shape === 'square') {
      var corners = [0.25, 0.75, 1.25, 1.75];
      for (i = 0; i < corners.length; i++) extra.push(corners[i] * Math.PI);
    } else if (shape === 'hexagon') {
      for (i = 0; i < 6; i++) extra.push((1 / 6 + i / 3) * Math.PI);
    } else if (shape === 'rounded-square') {
      /* Straight-edge/arc junction angle; degenerates gracefully at both
         limits (r=0 -> the square's 45-degree corners, r=h -> the axis
         angles of a plain circle) so no special-casing is needed. */
      var th0 = Math.atan2(h - cornerRadius, h);
      for (i = 0; i < 4; i++) {
        extra.push(i * (Math.PI / 2) + th0, (i + 1) * (Math.PI / 2) - th0);
      }
    }
    if (slit && slit.length > 0 && slit.width > 0) {
      var ca = Math.atan2(slit.width, slit.length);
      extra.push(ca, Math.PI - ca, Math.PI + ca, TAU - ca);
    }
    for (i = 0; i < extra.length; i++) {
      /* normalize into [0, TAU) first: the rounded-square junction formula
         can land exactly on TAU at its rad=h circle limit, which must
         dedupe against the uniform grid's 0 rather than sit a hair away
         from it as a near-duplicate vertex (a degenerate sliver triangle). */
      var c = ((extra[i] % TAU) + TAU) % TAU;
      var present = angles.some(function (a) { return Math.abs(a - c) < 1e-9; });
      if (!present) angles.push(c);
    }
    if (extra.length) {
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
  function sampleLoop(shape, rx, ry, angles, cx, cy, cornerRadius) {
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
      } else if (shape === 'hexagon') {
        var theta = angles[i];
        var k = Math.round(theta / (Math.PI / 3));
        var delta = theta - k * (Math.PI / 3);
        var rM = rx / Math.cos(delta);
        x = rM * c;
        y = rM * s;
      } else if (shape === 'rounded-square') {
        /* rx === ry (square footprint); cc is the arc-center offset. On a
           straight edge r(t) = h/max(ax,ay), same as plain square; on the
           corner, r(t) is the larger root of the arc's quadratic (the
           smaller root is the ray's near miss on the far side of the arc
           center, not a point on the corner itself — verified against both
           the theta0 junction, where it must match the straight-edge value,
           and the rad=h limit, where it must equal a plain circle of
           radius h). Both branches reduce exactly to square (rad=0) or a
           circle (rad=h). */
        var h = rx;
        var rad = cornerRadius || 0;
        var ax = Math.abs(c), ay = Math.abs(s);
        var cc = h - rad;
        var tt;
        if (ay * h <= ax * cc) {
          tt = h / ax;
        } else if (ax * h <= ay * cc) {
          tt = h / ay;
        } else {
          var B = cc * (ax + ay);
          var Cq = 2 * cc * cc - rad * rad;
          tt = B + Math.sqrt(Math.max(0, B * B - Cq));
        }
        x = tt * c;
        y = tt * s;
      } else {
        x = rx * c;
        y = ry * s;
      }
      pts[2 * i] = cx + x;
      pts[2 * i + 1] = cy + y;
    }
    return pts;
  }

  /*
   * The slit rectangle sampled polar-radially, so every vertex lies exactly
   * on its ray. The square support sampling above puts points off the ray
   * when rx != ry, which inverts annulus triangles bridged to it for long
   * slits — hence the dedicated sampler. hl/hw are the half length/width;
   * corners land exactly on the inserted atan2(width, length) angles.
   */
  function sampleSlitLoop(hl, hw, angles) {
    var pts = new Float64Array(angles.length * 2);
    for (var i = 0; i < angles.length; i++) {
      var c = Math.cos(angles[i]);
      var s = Math.sin(angles[i]);
      var r = (Math.abs(s) * hl <= Math.abs(c) * hw) ? hl / Math.abs(c) : hw / Math.abs(s);
      pts[2 * i] = r * c;
      pts[2 * i + 1] = r * s;
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

  /*
   * Flat ring between two index-aligned loops. Faces -Z by default (bottom
   * face); up=true mirrors the winding to face +Z (top face around the slit).
   */
  function annulus(out, inner, outer, z, up) {
    var n = inner.length / 2;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var ix = inner[2 * i], iy = inner[2 * i + 1];
      var jx = inner[2 * j], jy = inner[2 * j + 1];
      var ox = outer[2 * i], oy = outer[2 * i + 1];
      var px = outer[2 * j], py = outer[2 * j + 1];
      if (up) {
        tri(out, ix, iy, z, ox, oy, z, px, py, z);
        tri(out, ix, iy, z, px, py, z, jx, jy, z);
      } else {
        tri(out, ix, iy, z, px, py, z, ox, oy, z);
        tri(out, ix, iy, z, jx, jy, z, px, py, z);
      }
    }
  }

  /*
   * Terrain top surface (§ polar-grid route). Like annulus(up=true) but every
   * vertex carries its own height: inner/outer are index-aligned loops, zIn/zOut
   * are per-vertex Z arrays. Winding matches annulus up=true, so facets face +Z.
   */
  function terrainBand(out, inner, zIn, outer, zOut) {
    var n = inner.length / 2;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var ix = inner[2 * i], iy = inner[2 * i + 1];
      var jx = inner[2 * j], jy = inner[2 * j + 1];
      var ox = outer[2 * i], oy = outer[2 * i + 1];
      var px = outer[2 * j], py = outer[2 * j + 1];
      tri(out, ix, iy, zIn[i], ox, oy, zOut[i], px, py, zOut[j]);
      tri(out, ix, iy, zIn[i], px, py, zOut[j], jx, jy, zIn[j]);
    }
  }

  /* Fan the innermost terrain ring to a center apex; winding matches fan(down=false). */
  function terrainFan(out, ring, zRing, ax, ay, az) {
    var n = ring.length / 2;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      tri(out, ax, ay, az,
        ring[2 * i], ring[2 * i + 1], zRing[i],
        ring[2 * j], ring[2 * j + 1], zRing[j]);
    }
  }

  /*
   * Replace the flat top with a displaced polar grid. Concentric rings from the
   * center out to the top outline (`topLoop`, reused verbatim so the rim welds
   * bit-identically to the wall/bevel top), each vertex raised to H + displace.
   * Flat rim: the outer ring is pinned to H (relief 0) so it welds; interior
   * rings and the center apex carry the terrain relief. Watertight by
   * construction — same ring-bridging mechanism as the bevel bands.
   */
  function buildTerrainTop(out, shape, rx, ry, bevel, angles, H, terrain, topLoop, cornerRadius) {
    var RINGS = terrain.rings;
    var disp = terrain.displace;
    var trx = rx - bevel, tryy = ry - bevel;
    /* Terrain rings scale rx/ry radially by a uniform factor f (not a
       constant-mm offset like the bevel), so the corner radius at the
       bevel-inset base scales by that same f — a different, simpler rule
       than ringCornerRadius's Minkowski-erosion one. */
    var baseRad = bevel > 1e-6 ? ringCornerRadius(rx, cornerRadius || 0, trx) : (cornerRadius || 0);
    var n = angles.length;
    var prev = null, prevZ = null;
    for (var k = 1; k <= RINGS; k++) {
      var last = (k === RINGS);
      var f = k / RINGS;
      var ring = last ? topLoop : sampleLoop(shape, trx * f, tryy * f, angles, 0, 0, baseRad * f);
      var z = new Float64Array(n);
      var i;
      if (last) {
        for (i = 0; i < n; i++) z[i] = H;
      } else {
        for (i = 0; i < n; i++) z[i] = H + disp(ring[2 * i], ring[2 * i + 1]);
      }
      if (k === 1) {
        terrainFan(out, ring, z, 0, 0, H + disp(0, 0));
      } else {
        terrainBand(out, prev, prevZ, ring, z);
      }
      prev = ring;
      prevZ = z;
    }
  }

  /*
   * Flat cap at height z facing -Z: a convex CCW outer loop minus disjoint
   * convex hole loops — the bottom face when the slit and the magnet recess
   * coexist, which is beyond single-annulus bridging. Each hole is keyhole-
   * merged into the boundary along its bridge direction (traversed CW, the
   * two pinch vertices duplicated), then the merged polygon is ear-clipped.
   * Loop coordinates are reused verbatim, so the cap welds bit-identically
   * to the wall rings around it; each bridge edge appears exactly once per
   * direction, which is precisely what the manifold condition requires.
   */
  function capWithHoles(out, outerLoop, holes, z) {
    var X = [], Y = [];
    var i, k;
    var n = outerLoop.length / 2;
    for (i = 0; i < n; i++) {
      X.push(outerLoop[2 * i]);
      Y.push(outerLoop[2 * i + 1]);
    }

    var bridgeEdges = {};
    function ekey(x1, y1, x2, y2) { return x1 + ',' + y1 + '|' + x2 + ',' + y2; }

    for (k = 0; k < holes.length; k++) {
      var loop = holes[k].loop, dx = holes[k].dx, dy = holes[k].dy;
      var m = loop.length / 2;
      var hi = 0, best = -Infinity;
      for (i = 0; i < m; i++) {
        var dh = loop[2 * i] * dx + loop[2 * i + 1] * dy;
        if (dh > best) { best = dh; hi = i; }
      }
      var oi = 0;
      best = -Infinity;
      for (i = 0; i < X.length; i++) {
        var db = X[i] * dx + Y[i] * dy;
        if (db > best) { best = db; oi = i; }
      }
      bridgeEdges[ekey(X[oi], Y[oi], loop[2 * hi], loop[2 * hi + 1])] = true;
      bridgeEdges[ekey(loop[2 * hi], loop[2 * hi + 1], X[oi], Y[oi])] = true;
      /* splice after oi: the hole walked CW (reverse of its CCW storage)
         from the extreme vertex all the way around back to it, then the
         duplicated outer pinch vertex */
      var insX = [], insY = [];
      for (i = 0; i <= m; i++) {
        var idx = ((hi - i) % m + m) % m;
        insX.push(loop[2 * idx]);
        insY.push(loop[2 * idx + 1]);
      }
      insX.push(X[oi]);
      insY.push(Y[oi]);
      X = X.slice(0, oi + 1).concat(insX, X.slice(oi + 1));
      Y = Y.slice(0, oi + 1).concat(insY, Y.slice(oi + 1));
    }

    var N = X.length;
    var next = new Array(N), prev = new Array(N);
    for (i = 0; i < N; i++) {
      next[i] = (i + 1) % N;
      prev[i] = (i + N - 1) % N;
    }
    var remaining = N;
    /* accepted ears have area > 5e-8, comfortably above the 1e-9 degenerate
       threshold asserted in the tests — never lower this to unstick an ear
       search; fix the blocker logic instead */
    var EPS_AREA = 1e-7;
    var EPS_IN = 1e-12;

    function cross2(ax, ay, bx, by, cx, cy) {
      return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    }

    function isEar(v) {
      var p = prev[v], q = next[v];
      if (cross2(X[p], Y[p], X[v], Y[v], X[q], Y[q]) <= EPS_AREA) return false;
      /* a diagonal that lands on a keyhole bridge would duplicate that
         directed edge — the one way ear clipping can break manifoldness */
      if (bridgeEdges[ekey(X[p], Y[p], X[q], Y[q])]) return false;
      for (var w = next[q]; w !== p; w = next[w]) {
        var wx = X[w], wy = Y[w];
        /* keyhole duplicates share a corner's coordinates — not blockers */
        if ((wx === X[p] && wy === Y[p]) || (wx === X[v] && wy === Y[v]) ||
            (wx === X[q] && wy === Y[q])) continue;
        /* inside-or-on blocks: collinear runs must not be cut through */
        if (cross2(X[p], Y[p], X[v], Y[v], wx, wy) >= -EPS_IN &&
            cross2(X[v], Y[v], X[q], Y[q], wx, wy) >= -EPS_IN &&
            cross2(X[q], Y[q], X[p], Y[p], wx, wy) >= -EPS_IN) return false;
      }
      return true;
    }

    var v = 0;
    while (remaining > 3) {
      var found = false;
      for (var scan = 0; scan < remaining; scan++) {
        if (isEar(v)) {
          var p = prev[v], q = next[v];
          /* reversed (p, q, v) so the cap faces -Z */
          tri(out, X[p], Y[p], z, X[q], Y[q], z, X[v], Y[v], z);
          next[p] = q;
          prev[q] = p;
          remaining--;
          v = p;
          found = true;
          break;
        }
        v = next[v];
      }
      if (!found) throw new Error('capWithHoles: no ear found');
    }
    tri(out, X[prev[v]], Y[prev[v]], z, X[next[v]], Y[next[v]], z, X[v], Y[v], z);
  }

  /*
   * Angular resolution of the shared angle list. Terrain raises it in step with
   * the radial ring count so relief sharpens in both directions (a ring at the
   * rim has circumference ~2*pi*R, so ~4x the ring count keeps cells roughly
   * square there while staying a multiple of 4 for clean square-corner
   * alignment). Floored at the default 96 and capped so the whole mesh — walls,
   * bevel and bottom all sample this same list — stays a sane triangle count.
   * An explicit terrain.segments overrides the ring-derived count (custom
   * resolution); it is likewise floored at SEGMENTS and rounded to a multiple
   * of 4. Non-terrain builds are unchanged at SEGMENTS.
   */
  function segmentsFor(params) {
    var t = params.terrain || {};
    if (!(t.enabled && typeof t.displace === 'function' && t.rings > 0)) return SEGMENTS;
    var s, cap;
    if (t.segments > 0) {
      s = Math.round(t.segments); /* explicit custom override */
      cap = 1024;
    } else {
      s = Math.round(t.rings) * 4; /* auto: ~4 segments per ring */
      cap = 384;
    }
    s = Math.max(SEGMENTS, Math.min(cap, s));
    return s - (s % 4); /* keep divisible by 4 so square corners coincide */
  }

  function resolveRadii(params) {
    if (params.shape === 'round') {
      var r = params.diameter / 2;
      return { rx: r, ry: r };
    }
    if (params.shape === 'ellipse') {
      return { rx: params.width / 2, ry: params.depth / 2 };
    }
    if (params.shape === 'hexagon') {
      var a = params.hexFlat / 2;
      return { rx: a, ry: a };
    }
    var h = params.side / 2;
    return { rx: h, ry: h };
  }

  function clampBevel(params, rx, ry) {
    return Math.max(0, Math.min(params.bevel || 0, params.height - 0.05, rx - 0.1, ry - 0.1));
  }

  /* Base (un-inset) fillet radius for the rounded-square shape, clamped to [0, h]. */
  function clampCornerRadius(params, h) {
    if (params.shape !== 'rounded-square') return 0;
    return Math.max(0, Math.min(params.cornerRadius || 0, h));
  }

  /*
   * Fillet radius for a ring inset by a constant Delta = h - ringHalf from the
   * base rounded square (h, r). A constant-mm offset of a rounded square
   * shrinks both the half-side and the corner radius by the same Delta (the
   * arc center h-r is invariant under this transform), so this is an exact
   * offset, not an approximation — verified at both limits (Delta=0 keeps r;
   * Delta=r degenerates the ring to a plain square corner).
   */
  function ringCornerRadius(h, r, ringHalf) {
    return Math.max(0, Math.min(r - (h - ringHalf), ringHalf));
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
   * True when the slit rectangle (half extents hl, hw) keeps `margin`
   * clearance inside the top inset outline AND no annulus triangle bridged
   * between the slit loop and either the outer or the top inset loop is
   * inverted. Containment alone is not enough: skewed ellipses admit fully
   * contained slits whose bridged quads still fold over — the same class of
   * trap as the offset-magnet clamp, so the triangle conditions are explicit.
   */
  function slitOk(shape, rx, ry, bevel, hl, hw, margin, cornerRadius) {
    cornerRadius = cornerRadius || 0;
    var angles = buildAngleList(shape, { length: 2 * hl, width: 2 * hw }, undefined, rx, cornerRadius);
    var outer = sampleLoop(shape, rx, ry, angles, 0, 0, cornerRadius);
    var topRad = bevel > 1e-6 ? ringCornerRadius(rx, cornerRadius, rx - bevel) : cornerRadius;
    var top = bevel > 1e-6 ? sampleLoop(shape, rx - bevel, ry - bevel, angles, 0, 0, topRad) : outer;
    var slit = sampleSlitLoop(hl, hw, angles);
    var n = angles.length;
    var EPS = 1e-6; /* same slack as offsetScale: keeps boundary triangles above the degeneracy threshold */
    var i, j, k;
    /* containment with margin against the top inset (a subset of outer) */
    for (i = 0; i < n; i++) {
      j = (i + 1) % n;
      var ex = top[2 * j] - top[2 * i], ey = top[2 * j + 1] - top[2 * i + 1];
      var elen = Math.sqrt(ex * ex + ey * ey);
      if (elen < 1e-12) continue;
      for (k = 0; k < n; k++) {
        var qx = slit[2 * k] - top[2 * i], qy = slit[2 * k + 1] - top[2 * i + 1];
        if (ex * qy - ey * qx < margin * elen) return false;
      }
    }
    /* both annulus triangles per segment stay downward-wound (see annulus):
       the top ring is the mirrored winding of the same quad, so one sign
       condition covers both faces */
    var rings = [outer, top];
    for (k = 0; k < rings.length; k++) {
      var o = rings[k];
      for (i = 0; i < n; i++) {
        j = (i + 1) % n;
        var ix = slit[2 * i], iy = slit[2 * i + 1];
        var jx = slit[2 * j], jy = slit[2 * j + 1];
        var ox = o[2 * i], oy = o[2 * i + 1];
        var px = o[2 * j], py = o[2 * j + 1];
        /* tri (i, p, o): cross(p - i, o - i) must stay negative */
        if ((px - ix) * (oy - iy) - (py - iy) * (ox - ix) >= -EPS) return false;
        /* tri (i, j, p): cross(j - i, p - i) must stay negative */
        if ((jx - ix) * (py - iy) - (jy - iy) * (px - ix) >= -EPS) return false;
      }
    }
    return true;
  }

  /*
   * Clamp requested slit dimensions to the largest safe size: per-axis
   * bounds first, then (rarely) a uniform-scale bisection on slitOk —
   * validity is monotone under uniform scaling, and the corner angles
   * depend only on the width:length ratio, so scaling keeps the angle
   * list. Returns { length, width, scaled }; length 0 means "no room".
   */
  function clampSlitSize(params, length, width, margin) {
    var r = resolveRadii(params);
    var bevel = clampBevel(params, r.rx, r.ry);
    var cornerRadius = clampCornerRadius(params, r.rx);
    var L = Math.max(0, Math.min(length, 2 * (r.rx - bevel - margin)));
    var W = Math.max(0, Math.min(width, 2 * (r.ry - bevel - margin)));
    if (L <= 0 || W <= 0) return { length: 0, width: 0, scaled: true };
    var hl = L / 2, hw = W / 2;
    if (!slitOk(params.shape, r.rx, r.ry, bevel, hl, hw, margin, cornerRadius)) {
      var lo = 0, hi = 1;
      for (var it = 0; it < 40; it++) {
        var mid = (lo + hi) / 2;
        if (slitOk(params.shape, r.rx, r.ry, bevel, hl * mid, hw * mid, margin, cornerRadius)) lo = mid;
        else hi = mid;
      }
      if (lo <= 1e-6) return { length: 0, width: 0, scaled: true };
      L = 2 * hl * lo;
      W = 2 * hw * lo;
    }
    return {
      length: L,
      width: W,
      scaled: L < length - 1e-9 || W < width - 1e-9
    };
  }

  /*
   * Largest scale t >= 0 so the magnet hole centered at (t*ox, t*oy)
   * (a) keeps `margin` clearance to the effective outline along every
   * sampled direction — the wall guarantee — and (b) keeps both bottom
   * annulus triangles of every quad against the true outline non-inverted
   * (the support condition alone is only the first-order version of (b)
   * and misses second-order chord effects near square corners). Every
   * constraint is linear in the hole center, hence linear in t, and the
   * centered placement satisfies all of them, so taking the minimum
   * upper bound is exact. The result is NOT capped at 1: callers that only
   * ever scale back apply Math.min(1, .) themselves, while the slit case
   * may deliberately push the magnet outward past the requested offset.
   */
  function offsetScale(outer, effOuter, angles, holeR, ox, oy, margin) {
    var EPS = 1e-6;
    var n = angles.length;
    var t = 1e9;
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
    return Math.max(0, t);
  }

  /*
   * Smallest distance along the unit ray (ux, uy) at which a circle of
   * radius R clears the slit rectangle (half extents hl, hw). The expanded
   * rectangle (rect Minkowski disk(R)) is convex and contains the origin,
   * so the ray exits it exactly once: through the long side, the short
   * side, or the corner arc — the three cases are mutually exclusive.
   */
  function slitExitDistance(hl, hw, R, ux, uy) {
    var a = Math.abs(ux), b = Math.abs(uy);
    if (b < 1e-12) return (hl + R) / a;
    if (a < 1e-12) return (hw + R) / b;
    var d1 = (hl + R) / a;
    if (d1 * b <= hw) return d1;
    var d2 = (hw + R) / b;
    if (d2 * a <= hl) return d2;
    /* corner arc: |d*(a,b) - (hl,hw)| = R, larger root (a*a + b*b = 1) */
    var B = a * hl + b * hw;
    var C = hl * hl + hw * hw - R * R;
    return B + Math.sqrt(Math.max(0, B * B - C));
  }

  /*
   * Outline the magnet must clear: the footprint, or — when the recess
   * ceiling rises into the bevel — the bevel surface at ceiling height.
   */
  function magnetEffectiveOutline(params, rx, ry, bevel, angles, outer) {
    var m = params.magnet || {};
    var inset = bevelInsetAtZ(bevel, params.bevelType, params.height - bevel, m.depth || 0);
    if (inset <= 0) return outer;
    var cornerRadius = clampCornerRadius(params, rx);
    var ringRad = ringCornerRadius(rx, cornerRadius, rx - inset);
    return sampleLoop(params.shape, rx - inset, ry - inset, angles, 0, 0, ringRad);
  }

  /*
   * Public clamp for UI validation: place a requested magnet offset onto
   * the nearest safe placement. Reads footprint, height, bevel, bevelType,
   * the candidate magnet.diameter/depth and the slit from params. Returns
   * { x, y, scaled, pushed, valid }: `scaled` = pulled back to keep the
   * wall, `pushed` = moved outward past the request to clear the slit,
   * `valid` = false when no placement along the offset direction works
   * (including a zero offset while the slit is enabled).
   */
  function clampMagnetOffset(params, ox, oy, margin) {
    var r = resolveRadii(params);
    var bevel = clampBevel(params, r.rx, r.ry);
    var cornerRadius = clampCornerRadius(params, r.rx);
    var m = params.magnet || {};
    var hr = (m.diameter || 0) / 2;
    var s = params.slit || {};
    var slit = null;
    if (s.enabled && s.length > 0 && s.width > 0) {
      var sf = clampSlitSize(params, s.length, s.width, margin);
      if (sf.length > 0) slit = sf; /* same dims the UI applies — clamp is idempotent */
    }

    var segments = segmentsFor(params); /* match the build's density (terrain raises it) */

    if (!slit) {
      if (!ox && !oy) return { x: 0, y: 0, scaled: false, pushed: false, valid: true };
      var angles0 = buildAngleList(params.shape, null, segments, r.rx, cornerRadius);
      var outer0 = sampleLoop(params.shape, r.rx, r.ry, angles0, 0, 0, cornerRadius);
      var eff0 = magnetEffectiveOutline(params, r.rx, r.ry, bevel, angles0, outer0);
      var t0 = Math.min(1, offsetScale(outer0, eff0, angles0, hr, ox, oy, margin));
      return { x: ox * t0, y: oy * t0, scaled: t0 < 1 - 1e-12, pushed: false, valid: true };
    }

    if (!ox && !oy) return { x: 0, y: 0, scaled: false, pushed: false, valid: false };
    var dLen = Math.hypot(ox, oy);
    var tLow = slitExitDistance(slit.length / 2, slit.width / 2,
      hr + margin, ox / dLen, oy / dLen) / dLen;
    var angles = buildAngleList(params.shape, slit, segments, r.rx, cornerRadius);
    var outer = sampleLoop(params.shape, r.rx, r.ry, angles, 0, 0, cornerRadius);
    var eff = magnetEffectiveOutline(params, r.rx, r.ry, bevel, angles, outer);
    var tHigh = offsetScale(outer, eff, angles, hr, ox, oy, margin);
    if (tLow > tHigh + 1e-12) {
      return { x: ox, y: oy, scaled: false, pushed: false, valid: false };
    }
    var t = Math.min(Math.max(1, tLow), tHigh);
    return {
      x: ox * t,
      y: oy * t,
      scaled: t < 1 - 1e-12,
      pushed: t > 1 + 1e-12,
      valid: true
    };
  }

  /*
   * Build the raw triangle soup for a base. Returns a plain number array of
   * positions (x,y,z per vertex, 3 vertices per triangle). Kept free of any
   * THREE dependency so it can be tested headlessly.
   *
   * params: {
   *   shape: 'round' | 'ellipse' | 'square' | 'hexagon' | 'rounded-square',
   *   diameter, width, depth, side, hexFlat,  // per-shape footprint (mm)
   *   cornerRadius,                           // rounded-square fillet radius (mm)
   *   height, bevel,                          // bevel 0 = none
   *   bevelType: 'flat' | 'round',            // default 'flat'
   *   magnet: { enabled, diameter, depth, offsetX, offsetY },
   *   slit: { enabled, length, width }         // cut all the way through
   * }
   */
  function buildPositions(params) {
    var shape = params.shape;
    var radii = resolveRadii(params);
    var rx = radii.rx, ry = radii.ry;

    var H = params.height;
    var bevel = clampBevel(params, rx, ry);
    var cornerRadius = clampCornerRadius(params, rx);
    var wallTop = H - bevel;

    /* Terrain wins over the slit: the two are mutually exclusive (v1), and the
       UI already enforces it — this is the defensive drop, mirroring how a
       centered magnet is dropped rather than allowed to corrupt the mesh. */
    var t = params.terrain || {};
    var terrain = (t.enabled && typeof t.displace === 'function' && t.rings > 0)
      ? t : null;

    /* Slit gate + defensive clamp with the same 0.2 mm slack as the magnet. */
    var s = params.slit || {};
    var slit = null;
    if (!terrain && s.enabled && s.length > 0 && s.width > 0) {
      var sf = clampSlitSize(params, s.length, s.width, 0.2);
      if (sf.length > 0.05 && sf.width > 0.05) slit = sf;
    }

    var segments = segmentsFor(params);
    var angles = buildAngleList(shape, slit, segments, rx, cornerRadius);
    var outer = sampleLoop(shape, rx, ry, angles, 0, 0, cornerRadius);
    var slitLoop = slit ? sampleSlitLoop(slit.length / 2, slit.width / 2, angles) : null;
    var positions = [];

    var m = params.magnet || {};
    var hasMagnet = !!m.enabled &&
      m.diameter > 0 && m.depth > 0 &&
      m.diameter / 2 < Math.min(rx, ry) - 0.2 &&
      m.depth < H - 0.05;

    var hr = m.diameter / 2;
    var ox = m.offsetX || 0;
    var oy = m.offsetY || 0;
    if (hasMagnet) {
      /* Defensive clamps with the same 0.2 mm slack as the gate above. */
      var eff = magnetEffectiveOutline(params, rx, ry, bevel, angles, outer);
      if (slit) {
        /* The magnet must clear the slit; push it outward along its offset
           ray when possible, drop it when not (the UI already hinted). */
        var dLen = Math.hypot(ox, oy);
        if (dLen < 1e-9) {
          hasMagnet = false;
        } else {
          var tLow = slitExitDistance(slit.length / 2, slit.width / 2,
            hr + 0.2, ox / dLen, oy / dLen) / dLen;
          var tHigh = offsetScale(outer, eff, angles, hr, ox, oy, 0.2);
          if (tLow > tHigh + 1e-12) {
            hasMagnet = false;
          } else {
            var t = Math.min(Math.max(1, tLow), tHigh);
            ox *= t;
            oy *= t;
          }
        }
      } else if (ox !== 0 || oy !== 0) {
        var t1 = Math.min(1, offsetScale(outer, eff, angles, hr, ox, oy, 0.2));
        ox *= t1;
        oy *= t1;
      }
    }

    if (hasMagnet) {
      var hole = sampleLoop('round', hr, hr, angles, ox, oy);
      if (slit) {
        /* Two holes in the bottom face: keyhole-bridge both into the outer
           loop along the rect-to-magnet normal (provably clear of everything
           else; the offset ray is not) and ear-clip the merged polygon. */
        var cpx = Math.min(Math.max(ox, -slit.length / 2), slit.length / 2);
        var cpy = Math.min(Math.max(oy, -slit.width / 2), slit.width / 2);
        var nx = ox - cpx, ny = oy - cpy;
        var nl = Math.hypot(nx, ny); /* >= hr + 0.2 by the clamp above */
        nx /= nl;
        ny /= nl;
        capWithHoles(positions, outer, [
          { loop: slitLoop, dx: -nx, dy: -ny },
          { loop: hole, dx: nx, dy: ny }
        ], 0);
      } else {
        annulus(positions, hole, outer, 0);
      }
      bridge(positions, hole, 0, hole, m.depth, true);
      fan(positions, hole, m.depth, true, ox, oy); /* apex at hole center — required for validity */
    } else if (slit) {
      annulus(positions, slitLoop, outer, 0);
    } else {
      fan(positions, outer, 0, true);
    }

    if (slit) {
      bridge(positions, slitLoop, 0, slitLoop, H, true); /* cavity wall, like the recess */
    }

    if (wallTop > 1e-6) {
      bridge(positions, outer, 0, outer, wallTop, false);
    }
    var topLoop = outer;
    if (bevel > 1e-6) {
      if (params.bevelType === 'round') {
        var prev = outer, prevZ = wallTop; /* ring 0 = outer, reused verbatim */
        for (var k = 1; k <= FILLET_STEPS; k++) {
          var last = (k === FILLET_STEPS);
          var phi = k * (Math.PI / 2) / FILLET_STEPS;
          /* endpoints set exactly so the model is exactly H tall and welds are bit-identical */
          var ins = last ? bevel : bevel * (1 - Math.cos(phi));
          var z = last ? H : wallTop + bevel * Math.sin(phi);
          var ringRad = ringCornerRadius(rx, cornerRadius, rx - ins);
          var ring = sampleLoop(shape, rx - ins, ry - ins, angles, 0, 0, ringRad);
          bridge(positions, prev, prevZ, ring, z, false);
          prev = ring;
          prevZ = z;
        }
        topLoop = prev;
      } else {
        var insetRad = ringCornerRadius(rx, cornerRadius, rx - bevel);
        var inset = sampleLoop(shape, rx - bevel, ry - bevel, angles, 0, 0, insetRad);
        bridge(positions, outer, wallTop, inset, H, false);
        topLoop = inset;
      }
    }
    if (slit) {
      annulus(positions, slitLoop, topLoop, H, true);
    } else if (terrain) {
      buildTerrainTop(positions, shape, rx, ry, bevel, angles, H, terrain, topLoop, cornerRadius);
    } else {
      fan(positions, topLoop, H, false);
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
    clampMagnetOffset: clampMagnetOffset,
    clampSlitSize: clampSlitSize
  };
})();
