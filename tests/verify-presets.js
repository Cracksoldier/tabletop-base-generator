/* Headless verification of presets.js's PresetStore (pure storage logic). */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/* Minimal in-memory localStorage shim, close enough to the Web Storage API
   for PresetStore's getItem/setItem usage. */
function makeStorageShim() {
  const data = new Map();
  return {
    getItem: function (k) { return data.has(k) ? data.get(k) : null; },
    setItem: function (k, v) { data.set(k, String(v)); },
    removeItem: function (k) { data.delete(k); }
  };
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) { failures++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
  else console.log('ok    ' + name);
}

function freshStore() {
  const window = {};
  const localStorage = makeStorageShim();
  const sandbox = { window: window, localStorage: localStorage };
  const fn = new Function('window', 'localStorage',
    fs.readFileSync(path.join(root, 'js/presets.js'), 'utf8') + '\nreturn window.PresetStore;');
  return fn(sandbox.window, sandbox.localStorage);
}

/* ---------- basic save/list/get/remove ---------- */
{
  const store = freshStore();
  check('list starts empty', store.list().length === 0);

  const okSave = store.save('Goblin 25mm', { shape: 'round', diameter: 25 });
  check('save returns true', okSave === true);
  check('list has one entry', store.list().length === 1);
  check('list entry has name', store.list()[0].name === 'Goblin 25mm');
  check('list entry has savedAt', typeof store.list()[0].savedAt === 'number');

  const got = store.get('Goblin 25mm');
  check('get returns saved params', got && got.shape === 'round' && got.diameter === 25);
  check('get of missing name returns null', store.get('nope') === null);
}

/* ---------- overwrite-by-name ---------- */
{
  const store = freshStore();
  store.save('Ogre', { shape: 'round', diameter: 40 });
  store.save('Ogre', { shape: 'round', diameter: 50 });
  check('overwrite keeps one entry', store.list().length === 1);
  check('overwrite replaces params', store.get('Ogre').diameter === 50);
}

/* ---------- insertion order preserved ---------- */
{
  const store = freshStore();
  store.save('C', {});
  store.save('A', {});
  store.save('B', {});
  const names = store.list().map(function (p) { return p.name; });
  check('insertion order preserved', names.join(',') === 'C,A,B', names.join(','));
}

/* ---------- remove ---------- */
{
  const store = freshStore();
  store.save('Temp', { shape: 'square', side: 25 });
  store.save('Keep', { shape: 'square', side: 30 });
  const okRemove = store.remove('Temp');
  check('remove returns true', okRemove === true);
  check('remove drops the named entry', store.get('Temp') === null);
  check('remove leaves others intact', store.get('Keep') !== null);
  check('list reflects removal', store.list().length === 1);
}

/* ---------- name containing a colon (the UI packs custom entries as
   "custom:" + name in a <select>, so the name itself must round-trip even
   if it contains a colon — this is why main.js must use slice(), not
   split(':'), when unpacking the select value) ---------- */
{
  const store = freshStore();
  store.save('2:1 scale goblins', { shape: 'round', diameter: 25 });
  check('name with colon round-trips via get',
    store.get('2:1 scale goblins') !== null);
  check('name with colon round-trips via list',
    store.list().some(function (p) { return p.name === '2:1 scale goblins'; }));
}

/* ---------- corrupted/missing storage degrades gracefully ---------- */
{
  const window = {};
  const localStorage = {
    getItem: function () { return 'not json{{{'; },
    setItem: function () { throw new Error('storage full'); },
    removeItem: function () {}
  };
  const fn = new Function('window', 'localStorage',
    fs.readFileSync(path.join(root, 'js/presets.js'), 'utf8') + '\nreturn window.PresetStore;');
  const store = fn(window, localStorage);
  check('corrupted JSON: list returns empty array, does not throw',
    Array.isArray(store.list()) && store.list().length === 0);
  check('storage-full: save returns false, does not throw',
    store.save('x', {}) === false);
}

if (failures > 0) {
  console.log('\n' + failures + ' check(s) FAILED');
  process.exit(1);
} else {
  console.log('\nALL CHECKS PASSED');
}
