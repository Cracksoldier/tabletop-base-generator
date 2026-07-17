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

## Larger effort (new topology, not just a new outline)

- **Batch export** — generate a grid/sprue of several bases (different
  sizes/presets) into a single STL for printing a squad at once. Touches
  export/assembly logic more than the per-base geometry builder.
