# Feature ideas

Candidate features for the base generator, evaluated against the current
architecture (star-convex outlines sampled on a shared angle list, bridged
ring-by-ring, no CSG — see `CLAUDE.md`).

## Done

- **Hexagonal / rounded-square shapes** — `shape: 'hexagon'` and
  `shape: 'rounded-square'` in `js/geometry.js`.
- **Custom preset save/load** via `localStorage` — `js/presets.js`
  (`PresetStore`) plus a `js/dialog.js` modal for save/overwrite/delete,
  wired into the preset dropdown in `js/main.js`.

## Good architectural fit

- **Multiple/array magnet recesses** (e.g. two magnets on an oval base) —
  reuses the keyhole-merge triangulation already built for slit+magnet
  coexistence.
- **Rim texture presets** beyond the freeform height-map image loader —
  built-in procedural patterns ("cobblestone," "wood plank," "gravel") so
  users without a grayscale image still get textured bases.
- **Numbered engraving on the underside** — small embossed digits/text for
  unit tracking, procedural rather than image-driven, similar in spirit to
  the height-map relief.
- **Export/import a preset as a portable file**, alongside the existing
  `localStorage`-backed custom presets — `snapshotInputs()`/
  `applyFullConfig()` already produce/consume a plain JSON-serializable
  object, so this is a download-as-file / upload-and-parse pair around
  logic that already exists, letting presets move between browsers or be
  shared with others.
- **Independent radius per corner** on the rounded square (currently one
  `cornerRadius` shared by all four) — the same straight-edge/arc-quadratic
  sampling in `sampleLoop` generalizes per corner; mainly changes
  `buildAngleList`'s junction-angle math from one `th0` to four.
- **True offset-curve oval bevel** — replaces the documented approximation
  (the inset ellipse currently shrinks both radii rather than following a
  true constant-mm offset curve, per the README's "known approximation"),
  closing a gap the project already flags as imprecise.

## Larger effort (new topology, not just a new outline)

- **Batch export** — generate a grid/sprue of several bases (different
  sizes/presets) into a single STL for printing a squad at once. Touches
  export/assembly logic more than the per-base geometry builder.
- **Freeform outline import** (SVG path or point list) as the base
  footprint, instead of picking from the built-in shape list — breaks the
  star-convex-around-the-origin assumption the whole sampling/bridging
  scheme relies on, so it needs either a genuinely different triangulation
  strategy or a restriction to star-convex user shapes.
