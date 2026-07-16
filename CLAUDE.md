# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static web app that generates 3D-printable Warhammer miniature bases (round / oval / square, optional top bevel, optional magnet recess in the bottom) with a three.js preview and binary STL export. No backend, no build step, no package.json.

## Commands

- **Run the app:** open `index.html` directly in a browser (`Start-Process index.html`). It must work from `file://` — that is a hard requirement, not a convenience.
- **Run tests:** `node tests/verify-geometry.js` — headless checks that every shape × bevel × magnet combination produces a manifold, outward-wound mesh with exact analytic volume, and that the STL writer output matches the binary format. Run this after any change to `js/geometry.js` or `js/exporter.js`.
- **Syntax-check browser-only code:** `node --check js/main.js` (it touches the DOM, so it can't be executed under Node).
- **Deploy:** GitHub Pages, "Deploy from a branch", `main` / root. The repo is served as-is.

## Hard constraint: file:// compatibility

Browsers block ES module scripts, `fetch`, and XHR on `file://` URLs. Therefore:

- **Classic scripts only** — no `type="module"`, no `import`/`export`. Each JS file attaches one namespace to `window` (`BaseGeometry`, `StlExport`); `index.html` loads them in dependency order (three → OrbitControls → geometry → exporter → main).
- **No runtime network access** — presets and all data live inline in JS; no JSON files, no CDN scripts, no textures.
- **three.js is pinned to r147** in `vendor/` — the last release shipping non-module `examples/js/controls/OrbitControls.js` (removed in r148). Do not upgrade past r147 without replacing OrbitControls.

## Architecture

- **Units and orientation:** everything is millimetres, built Z-up (footprint in XY, height along +Z), so the STL needs no transform and sits flat on a slicer bed. The viewer compensates: `camera.up.set(0,0,1)` is set *before* constructing OrbitControls, and the GridHelper is rotated into the XY plane.
- **`js/geometry.js` — no CSG.** All outlines (circle, ellipse, square) are star-convex around the origin. Every loop (outer outline, bevel inset, magnet circle) is sampled at one shared angle list (96 uniform angles + exact square corner angles), so loops are index-aligned and get bridged ring-by-ring: bottom cap or magnet annulus+recess, outer wall, optional bevel chamfer, top cap. The magnet recess is built directly into the bottom face. This makes the mesh watertight by construction — `tests/verify-geometry.js` asserts it. Loop coordinates are computed once and reused verbatim so vertices are bit-identical and slicers weld them.
  - `buildPositions(params)` is deliberately THREE-free (returns a raw position array) so it can be tested headlessly; `build(params)` wraps it in a `BufferGeometry`. Keep that separation.
  - Winding convention: loops are CCW viewed from +Z; CCW triangle winding = outward normal. The `flip` arguments on `bridge`/`fan` exist for the magnet recess (its material-outward normals point into the cavity).
- **`js/exporter.js`:** binary STL writer; recomputes facet normals from triangle edges rather than trusting render normals. File size is exactly `84 + 50 × triangleCount` (asserted in tests).
- **`js/main.js`:** scene, UI wiring, validation. Clamping never rewrites the user's input fields — clamped values are applied to the geometry and reported via the hints element (e.g. magnet keeps a 1.5 mm wall and 1 mm ceiling). Old geometries are `dispose()`d on every regeneration. The mesh material is deliberately `THREE.FrontSide` so winding bugs show up instantly as see-through faces when orbiting.
- **Known approximation:** the oval bevel insets the ellipse by shrinking its radii, which is not a true offset curve; documented in README, accepted for small bevels.
