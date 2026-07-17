# Tabletop Base Generator

A static web app that generates 3D-printable bases for Warhammer (and other
tabletop) miniatures and exports them as STL, ready for slicing.

![Shapes](https://img.shields.io/badge/shapes-round%20%7C%20oval%20%7C%20square-blue)

## Features

- **Live 3D preview** (three.js) with orbit/zoom/pan controls
- **Shapes:** round, oval (elliptic) and square
- **Optional bevel** on the top edge — flat chamfer or rounded
  (quarter-circle fillet)
- **Optional round magnet recess** in the bottom (diameter, depth and X/Y
  position customizable) — the magnet is inserted from below
- **Optional slit** cut all the way through the base (slotta-style, for
  miniatures with a tab), length and width customizable — coexists with the
  magnet recess as long as the magnet is offset clear of the slit
- **Optional height-map terrain** on the top surface — load a grayscale image
  from disk and its brightness is projected as vertical relief (rubble, rock,
  cracked earth …), with adjustable relief height, base offset, contrast and
  resolution (plus invert). Contrast compresses the brightness range around
  mid-gray to tame steep, spiky transitions from high-contrast maps. Loaded
  entirely in-browser (no upload); coexists with the bevel and the magnet, and
  is mutually exclusive with the slit
- **Presets** for common base sizes (25/28.5/32/40/50/60/80/100 mm round,
  60×35 … 120×92 mm oval, 20/25/40/50 mm square)
- **Binary STL export** in millimetres, Z-up — drops straight into your slicer
- Runs **entirely in the browser**: no backend, no build step, no network
  requests (three.js and Font Awesome are vendored locally)

## Usage

Open `index.html` directly in your browser — double-clicking the file works,
no web server needed. Adjust the parameters in the sidebar; the preview
updates live. Click **Download STL** to save the model.

If a value exceeds what the geometry allows (e.g. a magnet wider than the
base), it is automatically limited and a note explains the applied limit.
Guard rails: ≥ 1.5 mm wall around the magnet, ≥ 1 mm of material above it.
The magnet offset is likewise auto-limited so the wall stays intact — also
against the sloped bevel surface when the recess reaches into the bevel.
The slit keeps a ≥ 1.5 mm wall to the (beveled) rim. With both slit and
magnet enabled, a too-small magnet offset is pushed outward until the recess
clears the slit; if no valid placement exists along the chosen direction,
the magnet is dropped and a note explains what to change.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. In the repository: **Settings → Pages**.
3. Under *Build and deployment*, choose **Deploy from a branch**, select
   branch `main` and folder `/ (root)`, then save.
4. The app will be served at `https://<user>.github.io/<repository>/`.

No build workflow is required — the repository is served as-is.

## Technical notes

- **Classic scripts, no ES modules.** Browsers block module scripts on
  `file://` URLs, so the app uses plain `<script>` tags. three.js **r147**
  (the last release with non-module `OrbitControls`) is vendored in
  `vendor/` (MIT, see `vendor/LICENSE-three.txt`).
- **Font Awesome 6.7.2 Free** (solid style only) is vendored in
  `vendor/fontawesome/` as webfont + CSS for the UI icons (OFL/MIT/CC-BY,
  see `vendor/fontawesome/LICENSE.txt`). The fonts live below the document
  root, so they load fine from `file://`.
- **Geometry is built procedurally, without CSG.** All outlines are sampled
  at a shared angle list and bridged ring-by-ring; the magnet recess is
  constructed directly into the bottom face, and the slit is a rectangle
  loop on the same angle list (sampled polar-radially so every vertex sits
  exactly on its ray — a prerequisite for the ring bridging) bridged bottom
  to top. When slit and magnet coexist, the bottom face has two holes and is
  triangulated by keyhole-bridged ear clipping over the very same sampled
  loops. The result is watertight (manifold) by construction in all cases.
- The **oval bevel** is an approximation: the inset outline is an ellipse
  with reduced radii rather than a true offset curve, so the chamfer width
  varies slightly around the perimeter. For typical bevels (≤ 2 mm) this is
  not noticeable. The round bevel inherits the same approximation (its
  rings are reduced-radii ellipses) and polygonizes the quarter-circle
  fillet in 8 steps — a deviation below 0.01 mm at a 2 mm bevel.
- **Height-map terrain** replaces the flat top with a displaced polar grid:
  concentric rings (the shared angle list × N radial steps) whose outermost
  ring is the existing top outline reused verbatim, so the relief welds
  bit-identically to the wall/bevel top and the mesh stays watertight by
  construction. With terrain active the shared angle list is densified in
  step with the ring count (~4 segments per ring, up to 384) so the whole
  mesh — walls, bevel and bottom included — gains angular detail to match the
  radial relief. Two approximations remain from the polar layout: radial
  detail still thins toward the middle, and the exact center is a single pinch
  vertex, so the finest features right at the center are smeared. The terrain edge is
  pinned flush with the rim ("flat rim"), and the image is read from disk via
  a data URL (never a `file://` path, which would taint the canvas). Terrain
  and the through-slit are mutually exclusive.
- The STL is **binary**, little-endian, units = mm, Z-up, with facet normals
  recomputed from the triangle edges.

## File layout

```
index.html            page layout and script loading order
favicon.svg, .png     d20 tab icon (SVG + 32px PNG fallback)
css/style.css         UI styling
js/geometry.js        procedural mesh construction (no THREE dependency in core)
js/heightmap.js       height-map decode + pure displacement sampler (BaseGeometry-free)
js/exporter.js        binary STL writer + download
js/main.js            scene, controls, UI wiring, validation, presets
vendor/               three.js r147 (three.min.js, OrbitControls.js, license)
vendor/fontawesome/   Font Awesome 6.7.2 Free, solid subset (css, webfonts, license)
```
