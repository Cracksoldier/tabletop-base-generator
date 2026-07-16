/*
 * main.js — scene setup, UI wiring, validation and STL export.
 */
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }

  var inputs = {
    preset: el('preset'),
    shapeRadios: document.querySelectorAll('input[name="shape"]'),
    diameter: el('diameter'),
    width: el('width'),
    depth: el('depth'),
    side: el('side'),
    height: el('height'),
    bevelEnabled: el('bevel-enabled'),
    bevelSize: el('bevel-size'),
    magnetEnabled: el('magnet-enabled'),
    magnetDiameter: el('magnet-diameter'),
    magnetDepth: el('magnet-depth')
  };
  var hintsEl = el('hints');
  var statsEl = el('stats');
  var exportBtn = el('export');

  /* ---------- three.js scene (Z-up, millimetres) ---------- */

  var container = el('viewport');
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);

  var camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
  camera.up.set(0, 0, 1); /* must be set before OrbitControls is created */
  camera.position.set(48, -48, 38);

  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 2);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 5;
  controls.maxDistance = 800;

  var hemi = new THREE.HemisphereLight(0xd8e2f0, 0x2a2620, 0.9);
  hemi.position.set(0, 0, 1);
  scene.add(hemi);

  var key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(40, -60, 80);
  scene.add(key);

  var fill = new THREE.DirectionalLight(0x8899bb, 0.35);
  fill.position.set(-50, 40, -30);
  scene.add(fill);

  var grid = new THREE.GridHelper(240, 48, 0x39404f, 0x232833);
  grid.rotation.x = Math.PI / 2; /* GridHelper is XZ by default; lay it into XY */
  grid.position.z = -0.02;
  scene.add(grid);

  var material = new THREE.MeshStandardMaterial({
    color: 0x99a3b8,
    roughness: 0.55,
    metalness: 0.05
    /* FrontSide (default) on purpose: winding bugs show as see-through faces */
  });
  var mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  scene.add(mesh);

  function resize() {
    var w = container.clientWidth;
    var h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  /* Keep the current view direction, adjust distance to frame the base. */
  function fitCamera(maxDim) {
    var dist = maxDim * 1.9 + 18;
    var dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).add(dir.multiplyScalar(dist));
  }

  /* ---------- parameters & validation ---------- */

  function num(input, fallback) {
    var v = parseFloat(input.value);
    return isNaN(v) ? fallback : v;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function currentShape() {
    for (var i = 0; i < inputs.shapeRadios.length; i++) {
      if (inputs.shapeRadios[i].checked) return inputs.shapeRadios[i].value;
    }
    return 'round';
  }

  /*
   * Read the form and produce safe, clamped parameters. Inputs are never
   * rewritten; instead every applied limit is reported as a hint.
   */
  function readParams() {
    var hints = [];
    var shape = currentShape();

    var p = {
      shape: shape,
      diameter: clamp(num(inputs.diameter, 32), 5, 300),
      width: clamp(num(inputs.width, 60), 5, 300),
      depth: clamp(num(inputs.depth, 35), 5, 300),
      side: clamp(num(inputs.side, 25), 5, 300),
      height: clamp(num(inputs.height, 4), 1, 50),
      bevel: 0,
      magnet: { enabled: false, diameter: 5, depth: 2 }
    };

    var minFootprint;
    if (shape === 'round') minFootprint = p.diameter;
    else if (shape === 'ellipse') minFootprint = Math.min(p.width, p.depth);
    else minFootprint = p.side;

    if (inputs.bevelEnabled.checked) {
      var bevel = Math.max(0, num(inputs.bevelSize, 1));
      var maxBevel = Math.min(p.height - 0.2, (minFootprint - 1) / 2);
      if (bevel > maxBevel) {
        bevel = Math.max(0, maxBevel);
        hints.push('Bevel limited to ' + bevel.toFixed(1) + ' mm by the base size.');
      }
      p.bevel = bevel;
    }

    if (inputs.magnetEnabled.checked) {
      var mDia = Math.max(0, num(inputs.magnetDiameter, 5));
      var mDepth = Math.max(0, num(inputs.magnetDepth, 2));
      var maxDia = minFootprint - 3;  /* keep >= 1.5 mm wall around the magnet */
      var maxDepth = p.height - 1;    /* keep >= 1 mm ceiling above the magnet */

      if (maxDia <= 0 || maxDepth <= 0) {
        hints.push('Base is too small for a magnet — recess disabled.');
      } else {
        if (mDia > maxDia) {
          mDia = maxDia;
          hints.push('Magnet diameter limited to ' + mDia.toFixed(1) + ' mm (1.5 mm wall).');
        }
        if (mDepth > maxDepth) {
          mDepth = maxDepth;
          hints.push('Magnet depth limited to ' + mDepth.toFixed(1) + ' mm (1 mm ceiling).');
        }
        if (mDia > 0 && mDepth > 0) {
          p.magnet = { enabled: true, diameter: mDia, depth: mDepth };
        }
      }
    }

    return { params: p, hints: hints };
  }

  function footprintLabel(p) {
    if (p.shape === 'round') return p.diameter.toFixed(1) + ' mm round';
    if (p.shape === 'ellipse') return p.width.toFixed(1) + ' × ' + p.depth.toFixed(1) + ' mm oval';
    return p.side.toFixed(1) + ' mm square';
  }

  var currentParams = null;

  function regenerate() {
    var result = readParams();
    currentParams = result.params;

    var old = mesh.geometry;
    mesh.geometry = BaseGeometry.build(currentParams);
    old.dispose();

    var triangles = mesh.geometry.getAttribute('position').count / 3;
    statsEl.textContent = footprintLabel(currentParams) + ', ' +
      currentParams.height.toFixed(1) + ' mm tall — ' + triangles + ' triangles';

    hintsEl.hidden = result.hints.length === 0;
    hintsEl.textContent = result.hints.join('\n');
  }

  /* ---------- UI wiring ---------- */

  function updateShapeFields() {
    var shape = currentShape();
    var fields = document.querySelectorAll('.field[data-shape]');
    for (var i = 0; i < fields.length; i++) {
      fields[i].hidden = fields[i].getAttribute('data-shape') !== shape;
    }
  }

  function updateEnabledStates() {
    inputs.bevelSize.disabled = !inputs.bevelEnabled.checked;
    inputs.magnetDiameter.disabled = !inputs.magnetEnabled.checked;
    inputs.magnetDepth.disabled = !inputs.magnetEnabled.checked;
  }

  function onAnyInput() {
    inputs.preset.value = '';
    updateEnabledStates();
    regenerate();
  }

  var plainInputs = [
    inputs.diameter, inputs.width, inputs.depth, inputs.side, inputs.height,
    inputs.bevelEnabled, inputs.bevelSize,
    inputs.magnetEnabled, inputs.magnetDiameter, inputs.magnetDepth
  ];
  plainInputs.forEach(function (input) {
    input.addEventListener('input', onAnyInput);
  });

  for (var i = 0; i < inputs.shapeRadios.length; i++) {
    inputs.shapeRadios[i].addEventListener('change', function () {
      inputs.preset.value = '';
      updateShapeFields();
      regenerate();
    });
  }

  inputs.preset.addEventListener('change', function () {
    var value = inputs.preset.value;
    if (!value) return;
    var parts = value.split(':');
    var shape = parts[0];
    var dims = parts[1].split('x').map(parseFloat);

    for (var i = 0; i < inputs.shapeRadios.length; i++) {
      inputs.shapeRadios[i].checked = inputs.shapeRadios[i].value === shape;
    }
    if (shape === 'round') inputs.diameter.value = dims[0];
    else if (shape === 'ellipse') { inputs.width.value = dims[0]; inputs.depth.value = dims[1]; }
    else inputs.side.value = dims[0];

    updateShapeFields();
    regenerate();
    fitCamera(Math.max.apply(null, dims));
  });

  function makeFilename(p) {
    function f(n) { return n.toFixed(1); }
    var size;
    if (p.shape === 'round') size = 'round-' + f(p.diameter) + 'mm';
    else if (p.shape === 'ellipse') size = 'oval-' + f(p.width) + 'x' + f(p.depth) + 'mm';
    else size = 'square-' + f(p.side) + 'mm';
    var name = 'base-' + size + '-h' + f(p.height);
    if (p.bevel > 0) name += '-b' + f(p.bevel);
    if (p.magnet.enabled) name += '-mag' + f(p.magnet.diameter) + 'x' + f(p.magnet.depth);
    return name + '.stl';
  }

  exportBtn.addEventListener('click', function () {
    StlExport.download(mesh.geometry, makeFilename(currentParams));
  });

  /* ---------- initial state ---------- */

  updateShapeFields();
  updateEnabledStates();
  regenerate();
})();
