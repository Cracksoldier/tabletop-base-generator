# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static web app that generates 3D-printable Warhammer miniature bases (round / oval / square, optional top bevel, optional magnet recess in the bottom, optional slotta-style slit cut through the base) with a three.js preview and binary STL export. No backend, no build step, no package.json.

## Commands

- **Run the app:** open `index.html` directly in a browser (`Start-Process index.html`). It must work from `file://` — that is a hard requirement, not a convenience.
- **Run tests:** `node tests/verify-geometry.js` — headless checks that every shape × bevel × magnet × slit combination produces a manifold, outward-wound mesh with exact analytic volume, and that the STL writer output matches the binary format. Run this after any change to `js/geometry.js` or `js/exporter.js`.
- **Syntax-check browser-only code:** `node --check js/main.js` (it touches the DOM, so it can't be executed under Node).
- **Deploy:** GitHub Pages, "Deploy from a branch", `main` / root. The repo is served as-is.

## Hard constraint: file:// compatibility

Browsers block ES module scripts, `fetch`, and XHR on `file://` URLs. Therefore:

- **Classic scripts only** — no `type="module"`, no `import`/`export`. Each JS file attaches one namespace to `window` (`BaseGeometry`, `StlExport`); `index.html` loads them in dependency order (three → OrbitControls → geometry → exporter → main).
- **No runtime network access** — presets and all data live inline in JS; no JSON files, no CDN scripts, no textures.
- **Font Awesome 6.7.2 Free (solid subset) is vendored** in `vendor/fontawesome/` as webfont + CSS for UI icons. The webfonts load from `file://` because they sit below the document root (Firefox requires same-directory-or-below). Do not swap to a CDN or the SVG+JS build without checking `file://` first.
- **three.js is pinned to r147** in `vendor/` — the last release shipping non-module `examples/js/controls/OrbitControls.js` (removed in r148). Do not upgrade past r147 without replacing OrbitControls.

## Architecture

- **Units and orientation:** everything is millimetres, built Z-up (footprint in XY, height along +Z), so the STL needs no transform and sits flat on a slicer bed. The viewer compensates: `camera.up.set(0,0,1)` is set *before* constructing OrbitControls, and the GridHelper is rotated into the XY plane.
- **`js/geometry.js` — no CSG.** All outlines (circle, ellipse, square) are star-convex around the origin. Every loop (outer outline, bevel inset, magnet circle, slit rectangle) is sampled at one shared angle list (96 uniform angles + exact square corner angles + the slit's `atan2(width, length)` corner angles when the slit is active), so loops are index-aligned and get bridged ring-by-ring: bottom cap or magnet annulus+recess, outer wall, optional bevel (single chamfer band, or `FILLET_STEPS` chained rings for the round bevel), top cap. The magnet recess is built directly into the bottom face. This makes the mesh watertight by construction — `tests/verify-geometry.js` asserts it. Loop coordinates are computed once and reused verbatim so vertices are bit-identical and slicers weld them.
  - `buildPositions(params)` is deliberately THREE-free (returns a raw position array) so it can be tested headlessly; `build(params)` wraps it in a `BufferGeometry`. Keep that separation.
  - Winding convention: loops are CCW viewed from +Z; CCW triangle winding = outward normal. The `flip` arguments on `bridge`/`fan` exist for the magnet recess (its material-outward normals point into the cavity).
  - **Offset magnet:** the hole loop may be translated off-center (`magnet.offsetX/offsetY`); its recess ceiling then fans from the hole center, not the origin. The offset is clamped by `clampMagnetOffset`/`offsetScale` — one pass over the shared angle list enforcing both the wall margin (support condition, measured against the bevel surface at recess-ceiling height when the recess reaches into the bevel) and the exact non-inversion of every bottom-annulus triangle (all constraints are linear in the hole center, so the max safe scale has closed form). Don't replace this with a simple radial/per-axis clamp: near square corners it produces inverted bottom triangles that neither the volume nor the edge-manifold checks can detect — which is why the tests assert horizontal-facet orientation explicitly.
  - **Slit:** a rectangle loop cut all the way through (bottom annulus → flipped wall → upward top annulus around it). It is sampled by `sampleSlitLoop` (polar-radial, every vertex exactly on its ray) — NOT by `sampleLoop`'s square support function, whose points sit off the ray for `rx ≠ ry` and provably invert annulus triangles for long slits. `clampSlitSize` enforces containment-with-margin **plus** the explicit per-segment annulus non-inversion crosses (containment alone passes round/square but fails skewed ovals), bisecting a uniform scale when the per-axis bounds aren't enough. When slit and magnet coexist, the bottom face has two holes and is built by `capWithHoles`: each hole keyhole-merged into the outer loop along the rect-to-magnet normal `±n̂` (provably crossing-free; the offset ray is not) and the merged polygon ear-clipped; bridge diagonals are rejected so no directed edge duplicates. `clampMagnetOffset` is slit-aware: it pushes a too-small offset *outward* (`pushed`) until the recess clears the slit, or reports `valid:false` (geometry then drops the magnet — same rule defensively in `buildPositions`).
- **`js/exporter.js`:** binary STL writer; recomputes facet normals from triangle edges rather than trusting render normals. File size is exactly `84 + 50 × triangleCount` (asserted in tests).
- **`js/main.js`:** scene, UI wiring, validation. Clamping never rewrites the user's input fields — clamped values are applied to the geometry and reported via the hints element (e.g. magnet keeps a 1.5 mm wall and 1 mm ceiling). Old geometries are `dispose()`d on every regeneration. The mesh material is deliberately `THREE.FrontSide` so winding bugs show up instantly as see-through faces when orbiting.
- **Known approximation:** the oval bevel insets the ellipse by shrinking its radii, which is not a true offset curve; documented in README, accepted for small bevels.
