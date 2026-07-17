# Specification: Height-map terrain on the top surface

Status: **proposal / not yet implemented**
Author: design analysis
Date: 2026-07-17

## 1. Goal

Let the user project a grayscale height map (a "displacement map") onto the top
surface of a base, so the print carries a sculpted terrain relief (rubble,
rock, cobbles, cracked earth, water, etc.) instead of a flat top. The image is
loaded from the user's disk; brightness drives vertical displacement.

This must hold to every existing hard constraint of the project:

- Works from `file://` — no `fetch`, no XHR, no ES modules, no CDN.
- Classic scripts only; the feature attaches to the existing `BaseGeometry`
  namespace (plus one new namespace for image sampling — see §6).
- No new network access and no new vendored binary dependency.
- three.js stays pinned at r147; OrbitControls untouched.
- Output stays a single watertight, outward-wound, Z-up binary STL that sits
  flat on a slicer bed.

## 2. Why this is a real departure (read before implementing)

The current mesh is watertight **by construction**: every outline (outer,
bevel inset, magnet circle, slit rectangle) is star-convex around the origin
and sampled at one shared angle list, so all loops are index-aligned and get
bridged ring-to-ring. There is deliberately **no general triangulation and no
CSG**. See `CLAUDE.md` and the header of `js/geometry.js`.

A height map is a 2-D scalar field `z = f(x, y)` over the footprint. It is not
a stack of rings. Introducing it is the single largest change to the meshing
model the project has seen. Two facts make it tractable, and three facts make
it genuinely new work:

**Tractable:**

1. A height map is single-valued in Z (no overhangs / caves), which is exactly
   what a slicer wants and what keeps the surface printable without supports on
   its underside.
2. Vertical displacement preserves manifoldness: the flat top is watertight
   because adjacent triangles share vertices; moving a shared vertex in Z does
   not split it, so a grid that is manifold flat stays manifold displaced.

**New work:**

1. The shared-angle-list / ring-bridging strategy does not extend to a 2-D
   grid. A new top-surface tessellation is required (§4).
2. The exact analytic-volume assertion in `tests/verify-geometry.js` cannot
   cover an arbitrary height field (§7). Terrain cases drop to numeric volume
   checks; manifold / winding / degeneracy / horizontal-facet checks still hold.
3. Feature interaction with the slit is a genuine conflict and is resolved by
   making terrain and slit mutually exclusive in v1 (§5).

## 3. User-facing behaviour

### 3.1 Controls (new sidebar section "Terrain")

- **Enable terrain** — checkbox. Off by default. Disabled/greyed when the slit
  is enabled (and vice-versa); see §5.3.
- **Height map** — `<input type="file" accept="image/*">`. Loads a raster
  image from disk. A small thumbnail preview and the source dimensions are
  shown once loaded. A "Clear" button removes it.
- **Relief height (mm)** — number, the peak displacement added above the base
  top. Range 0.2–20, default 2.0. This is the Z distance mapped to full white.
- **Base offset (mm)** — number, extra flat slab kept under the lowest point of
  the terrain so black pixels do not thin the wall to nothing. Range 0–10,
  default 0. Effectively raises the whole terrain field by this amount.
- **Invert** — checkbox. When on, black is high and white is low.
- **Resolution** — select or number: grid subdivision (see §4.4). Presets
  Low / Medium / High mapping to concrete cell counts; default Medium.
- **Edge treatment** — select:
  - `Flat rim` (default): the terrain is forced to 0 relief at the footprint
    boundary so it welds to the existing top ring; interior is displaced.
  - `Full bleed`: terrain is displaced right to the boundary; the outer wall is
    then raised to meet the terrain edge (a vertical skirt is emitted from the
    old top ring up to the displaced boundary ring). More dramatic, but the rim
    height becomes uneven.

### 3.2 Reporting (hints element, never rewrites inputs)

Follow the existing clamp-and-hint pattern in `js/main.js`: never rewrite the
user's fields; apply the safe value to the geometry and report via `#hints`.
Cases to hint:

- No image loaded but terrain enabled → "Load a height map to add terrain."
- Slit enabled while terrain enabled → the mutually-exclusive rule (§5.3).
- Relief height clamped by base height (§5.1).
- Very large source image downsampled to the working resolution (§6.3).

### 3.3 Stats and filename

- Stats line already prints triangle count; terrain will raise it (§4.4). No
  format change needed.
- `makeFilename` in `js/main.js` gains a suffix when terrain is active, e.g.
  `-terrainNAMEr2.0` where `r2.0` is the relief. Keep it filename-safe (strip
  the source filename to `[a-z0-9]` or omit it and just use `-terrain-r2.0`).

## 4. Geometry: top-surface tessellation

The change is localized to `buildPositions` in `js/geometry.js`, in the block
that currently emits the top cap:

```js
if (slit) {
  annulus(positions, slitLoop, topLoop, H, true);
} else {
  fan(positions, topLoop, H, false);   // <-- terrain replaces this branch
}
```

Everything below the top (bottom cap, magnet recess, outer wall, bevel bands)
is unchanged. `topLoop` is still produced exactly as today and is still the
weld boundary — terrain must meet it bit-identically.

Two candidate tessellations. **v1 ships the polar grid (§4.1).** The Cartesian
grid (§4.2) is documented as the future path for uniform terrain quality.

### 4.1 Polar grid (v1 — recommended)

Reuse the existing angle list as the angular coordinate and add `RINGS` radial
steps from the center to the boundary. This stays inside the project's
star-convex philosophy and welds to `topLoop` for free.

Construction, all at height `wallTop + bevel = H` before displacement:

1. Let `theta[]` be `buildAngleList(shape, slit)` — the same list `topLoop` uses.
   (With terrain, `slit` is always null; see §5.3.)
2. For radial index `k = 0..RINGS`, fraction `f = k / RINGS`:
   - `k == RINGS`: the ring **is** `topLoop` (reuse its coordinates verbatim,
     do not recompute — bit-identical welding).
   - `0 < k < RINGS`: `ring_k = sampleLoop(shape, (rx - bevel) * f, (ry - bevel) * f, theta)`
     for round/ellipse; for square use the same support function `sampleLoop`
     already applies. I.e. scaled copies of the top outline shrinking to the center.
   - `k == 0`: the center point (single apex at origin).
3. Displace each vertex: `z = H + relief(x, y)` where `relief` samples the
   height map (§6) at the vertex XY mapped into image space (§6.2), scaled by
   the relief-height control, plus base offset. Under `Flat rim`, force the
   `k == RINGS` ring to `z = H` exactly (relief 0 at boundary) so it still welds.
4. Bridge ring-to-ring with `bridge(...)` for `k = 1..RINGS`, and `fan(...)`
   the innermost ring (`k == 1`) to the center apex. Winding: same as the
   current top cap (CCW from +Z → +Z normal → upward-facing top). Because these
   are the same `bridge`/`fan` helpers used everywhere else, winding stays
   consistent and the STL exporter recomputes facet normals anyway.

Properties:

- Watertight by construction — identical mechanism to the bevel bands.
- Boundary ring is `topLoop`, so the terrain welds to the wall/bevel top with
  zero gap under both edge treatments (`Flat rim` forces its Z to `H`).
- **Known limitation:** angular resolution is fixed at the angle-list density
  (96 + corners); radial resolution is `RINGS`. Detail is denser near the rim
  and sparser toward the center, and the center is a single pinch vertex, so
  fine features at the exact middle are smeared. Document this in the README's
  "Known approximation" list alongside the oval-bevel note.

### 4.2 Cartesian grid clipped to the footprint (future / v2)

A uniform square lattice over the footprint bounding box, displaced per vertex,
with cells outside the outline dropped and the boundary row stitched to
`topLoop`. This gives uniform terrain detail and no center pinch, but:

- Requires clipping a grid to a round/oval/square outline and triangulating the
  partial boundary cells against the polar `topLoop` — exactly the general
  triangulation the project has avoided. `capWithHoles`' ear-clipper is for
  convex holes in a *flat* cap and is not directly reusable for a displaced,
  non-convex boundary band.
- Higher implementation and test risk. Not in v1.

Recommendation: ship §4.1; only move to §4.2 if terrain quality at the center
proves unacceptable in practice.

### 4.3 Normals and preview

`build()` calls `computeVertexNormals()`; that already produces smooth shading
for the displaced surface with no change. The mesh material is deliberately
`THREE.FrontSide` so any winding error shows as see-through faces — this remains
a fast visual check while developing terrain.

### 4.4 Resolution and triangle budget

Polar grid triangle count for the top ≈ `2 * A * RINGS` where `A` is the angle
count (~100). Suggested presets:

| Preset | RINGS | Top tris (approx) |
|--------|-------|-------------------|
| Low    | 12    | ~2,400            |
| Medium | 24    | ~4,800            |
| High   | 48    | ~9,600            |

Today's whole model is a few hundred triangles; even High is trivial for
three.js and produces an STL well under a few MB. There is no need to raise the
angle-list density for v1 — but note angular detail is capped by it, which is
the main quality ceiling of the polar route.

## 5. Feature interactions

### 5.1 Base height / relief clamp

The terrain adds relief **above** `H`; it never eats into the base body, so it
cannot breach the wall or the magnet ceiling. The only clamp is a sanity cap on
relief height (e.g. ≤ some multiple of footprint) and `relief ≥ 0`. Base offset
simply shifts the field up. No interaction with `clampBevel`, magnet clamps, or
wall thickness.

### 5.2 Bevel

Clean and supported. Terrain sits on the post-bevel `topLoop`; its footprint is
the top outline (`rx - bevel`, `ry - bevel`). Under `Flat rim` the terrain edge
is at `z = H`, welding to the bevel's top ring. Under `Full bleed` a vertical
skirt is emitted from the bevel top ring up to the displaced boundary ring.

### 5.3 Slit — mutually exclusive in v1

The slit cuts `0 → H` and closes at the top with
`annulus(slitLoop, topLoop, H, true)`. Terrain replaces that flat top with a
displaced grid; making the slit pass through displaced terrain means cutting a
hole in a non-planar grid and walling it up the varying terrain height — the
`capWithHoles`-class problem on a non-planar surface. Out of scope for v1.

Rule: **terrain and slit cannot both be enabled.** Enforce in the UI (disable
each checkbox when the other is on) and defensively in `readParams` /
`buildPositions` (if both arrive, drop the slit and keep terrain, and hint).

### 5.4 Magnet

Fully independent — the magnet is a bottom-face recess and never touches the
top surface. No changes, no clamps, works with terrain in any combination.

## 6. Image loading and sampling (`file://`-safe)

### 6.1 Loading path (no network, no canvas taint)

```
<input type="file"> change
  → File
  → FileReader.readAsDataURL(file)         // data: URL, not a file: URL
  → new Image(); img.src = dataURL
  → img.onload → draw to offscreen <canvas>
  → ctx.getImageData(...)                  // NOT tainted: data URLs are same-origin
```

Loading via a `data:` URL is critical: assigning a `file://` path to
`img.src` and drawing it taints the canvas in some browsers, and
`getImageData` then throws a SecurityError. The FileReader→data-URL route is
same-origin and reads pixels cleanly from `file://`. No `fetch`, no XHR.

### 6.2 Coordinate mapping

Map each mesh vertex XY into image UV:

- `u = (x - minX) / (maxX - minX)`, `v = (y - minY) / (maxY - minY)` over the
  footprint bounding box (`minX = -rx`, etc.). Image row 0 is top, so flip V:
  `row = (1 - v) * (imgH - 1)`.
- Sample brightness = luminance of the pixel (e.g. `0.299R + 0.587G + 0.114B`,
  or just the red channel for a true grayscale map — document which). Normalize
  to `[0, 1]`, apply `Invert` if set.
- `relief(x, y) = baseOffset + normalizedBrightness * reliefHeight`.
- Bilinear interpolation between the four surrounding texels for smooth relief
  (nearest-neighbor looks blocky at these grid densities).

### 6.3 Working buffer

- Keep the decoded `ImageData` (or a downsampled copy) in memory in the new
  sampler namespace. Downsample very large sources (e.g. > 512×512) to a working
  buffer to keep sampling cheap and hint that it was downsampled.
- The sampler must be a plain module attached to `window` (e.g.
  `window.HeightMap`) with a THREE-free, DOM-free sampling function
  `sample(u, v) → [0,1]` so that — like `buildPositions` — the pure sampling
  math can be unit-tested headlessly by feeding it a synthetic buffer.

### 6.4 Separation of concerns (keep `buildPositions` headless)

`buildPositions` must stay THREE-free and DOM-free (it is tested under Node).
Therefore the height sampler is passed **in** as a plain callback in `params`,
not read from a canvas inside geometry.js:

```js
params.terrain = {
  enabled: true,
  rings: 24,
  edge: 'flat' | 'bleed',
  // pure function (x, y) -> displacement in mm, already including
  // reliefHeight, baseOffset, invert, and edge falloff. Supplied by main.js
  // from the canvas sampler; in tests, supplied as a synthetic closure.
  displace: function (x, y) { return /* mm */; }
};
```

This keeps geometry.js pure and makes terrain testable with a synthetic
`displace` (e.g. a radial bump, a plane, a step) without any image or DOM.

## 7. Testing (`tests/verify-geometry.js`)

The existing invariants that **still apply** to terrain cases and must be
asserted:

- **Manifold:** every directed edge exactly once and its reverse present.
- **No degenerate triangles.**
- **Positive volume.**
- **Horizontal-facet orientation (`badHoriz`):** still valid for the bottom
  face, magnet ceiling, and (under `Flat rim`) the flat boundary; displaced
  top facets are non-horizontal and simply are not tested by that check.

What **changes:**

- **Exact analytic volume cannot be asserted** for an arbitrary displacement.
  Add terrain cases with a *known* synthetic `displace` whose added volume has a
  closed form so the test can still be exact:
  - `displace = 0` everywhere → volume equals the flat-top base exactly (proves
    the terrain tessellation reproduces the flat cap to floating-point).
  - `displace = const c` (with `Full bleed`) → adds `topArea * c` exactly; with
    `Flat rim` the added volume is a known pyramidal/prismatoid sum over the
    polar bands, computable the same way `bandVol` handles bevels.
  - A linear ramp `displace = a*x + b` over a symmetric footprint → adds `0`
    net (mean zero) or a closed-form tilt volume; useful as a second exact case.
- For a genuinely arbitrary map, assert only the topological invariants above
  plus **numeric** volume monotonicity (relief up ⇒ volume up).

New unit tests for the sampler (`window.HeightMap.sample`): feed a synthetic
`ImageData`-like buffer (plain array + width/height) and assert bilinear values,
V-flip, invert, and normalization at known coordinates. No DOM needed.

Add cases to the matrix:

- terrain × {round, ellipse, square} × {flat rim, full bleed} × {bevel none,
  flat, round} × {magnet off, centered, offset}, each asserting the topological
  invariants; the `displace = 0` and `displace = const` subsets asserting exact
  volume.
- terrain + slit both requested → assert the slit is dropped and the result is
  a clean terrain mesh (mirrors the existing "magnet dropped" defensive cases).

## 8. Files touched

- `js/geometry.js` — new top-surface branch in `buildPositions` (polar terrain
  grid); a small helper to emit the ring stack; the terrain+slit defensive drop.
  Stays THREE-free and DOM-free.
- `js/heightmap.js` *(new)* — `window.HeightMap`: FileReader→canvas decode,
  downsample, and a pure `sample(u, v)` / `makeDisplace(params)` factory. Loaded
  as a classic script in dependency order in `index.html` (before `main.js`,
  after nothing else it depends on).
- `js/main.js` — Terrain UI section wiring, file input handling, building the
  `params.terrain.displace` closure from the canvas sampler, the terrain/slit
  mutual-exclusion UI + hints, filename suffix.
- `index.html` — the Terrain controls markup and the new `<script>` tag for
  `js/heightmap.js` in dependency order (three → OrbitControls → geometry →
  heightmap → exporter → main).
- `tests/verify-geometry.js` — synthetic-`displace` exact cases, topological
  cases across the matrix, sampler unit tests, terrain+slit drop case.
- `README.md` — document the feature and add the polar-grid center-pinch /
  non-uniform-detail caveat to the "Known approximation" section.

## 9. Out of scope for v1

- Cartesian / uniform terrain grid (§4.2) — future v2 if center quality is
  insufficient.
- Slit + terrain coexistence (§5.3).
- Terrain on the *bottom* face, or on the bevel walls.
- Color / multi-material output (STL is geometry only).
- Procedural noise generators (only user-supplied image maps in v1).

## 10. Open decisions (confirm before building)

1. **Route:** ship the polar grid (§4.1) for v1? (Recommended.)
2. **Luminance vs red-channel** brightness (§6.2) — pick one and document.
3. **Default edge treatment** — `Flat rim` proposed as default (welds cleanly,
   even rim); `Full bleed` as the dramatic option.
4. **Resolution presets** — the Low/Medium/High RINGS in §4.4, or expose a raw
   number?
5. Whether to accept the loss of exact analytic-volume coverage on arbitrary
   maps (§7), relying on synthetic exact cases + numeric invariants for the
   general case.
