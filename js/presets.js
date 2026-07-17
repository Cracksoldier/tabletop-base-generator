/*
 * presets.js — localStorage-backed store for user-saved full-configuration
 * presets (shape, dimensions, bevel, magnet, slit — everything except
 * terrain, which can't be serialized since it depends on a loaded image).
 *
 * Storage schema: a single localStorage key holding
 *   { version: 1, presets: [{ name, savedAt, params }] }
 * An array (not a name-keyed object) keeps insertion order explicit and
 * under the caller's control. All localStorage access is wrapped in
 * try/catch: private-browsing/storage-full failures degrade to returning
 * an empty list / false rather than throwing, so main.js can surface a
 * hint through the existing hints mechanism instead of crashing.
 */
window.PresetStore = (function () {
  'use strict';

  var KEY = 'tabletop-base-generator.customPresets';

  function readAll() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.presets)) return [];
      return parsed.presets;
    } catch (e) {
      return [];
    }
  }

  function writeAll(presets) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, presets: presets }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function list() {
    return readAll().map(function (p) { return { name: p.name, savedAt: p.savedAt }; });
  }

  function get(name) {
    var found = readAll().filter(function (p) { return p.name === name; })[0];
    return found ? found.params : null;
  }

  /* Overwrites any existing preset with the same name. Returns true on success. */
  function save(name, params) {
    var presets = readAll();
    var idx = -1;
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].name === name) { idx = i; break; }
    }
    var entry = { name: name, savedAt: Date.now(), params: params };
    if (idx === -1) presets.push(entry);
    else presets[idx] = entry;
    return writeAll(presets);
  }

  function remove(name) {
    var presets = readAll().filter(function (p) { return p.name !== name; });
    return writeAll(presets);
  }

  return {
    list: list,
    get: get,
    save: save,
    remove: remove
  };
})();
