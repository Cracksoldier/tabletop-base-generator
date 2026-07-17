/*
 * main.js — scene setup, UI wiring, validation and STL export.
 */
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }

  var inputs = {
    preset: el('preset'),
    presetGroup: el('my-presets-group'),
    presetSave: el('preset-save'),
    presetDelete: el('preset-delete'),
    shapeRadios: document.querySelectorAll('input[name="shape"]'),
    diameter: el('diameter'),
    width: el('width'),
    depth: el('depth'),
    side: el('side'),
    hexFlat: el('hex-flat'),
    cornerRadius: el('corner-radius'),
    height: el('height'),
    bevelEnabled: el('bevel-enabled'),
    bevelTypeRadios: document.querySelectorAll('input[name="bevel-type"]'),
    bevelSize: el('bevel-size'),
    magnetEnabled: el('magnet-enabled'),
    magnetDiameter: el('magnet-diameter'),
    magnetDepth: el('magnet-depth'),
    magnetOffsetX: el('magnet-offset-x'),
    magnetOffsetY: el('magnet-offset-y'),
    slitEnabled: el('slit-enabled'),
    slitLength: el('slit-length'),
    slitWidth: el('slit-width'),
    terrainEnabled: el('terrain-enabled'),
    terrainImage: el('terrain-image'),
    terrainRelief: el('terrain-relief'),
    terrainBase: el('terrain-base'),
    terrainContrast: el('terrain-contrast'),
    terrainContrastValue: el('terrain-contrast-value'),
    terrainInvert: el('terrain-invert'),
    terrainResRadios: document.querySelectorAll('input[name="terrain-res"]'),
    terrainResCustom: el('terrain-res-custom'),
    terrainResCustomField: el('terrain-res-custom-field'),
    terrainSegCustom: el('terrain-seg-custom'),
    terrainSegCustomField: el('terrain-seg-custom-field'),
    terrainThumb: el('terrain-thumb'),
    terrainClear: el('terrain-clear'),
    terrainPreview: document.querySelector('.terrain-preview'),
    meshColor: el('mesh-color'),
    axesEnabled: el('axes-enabled'),
    axesThrough: el('axes-through')
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

  /* ---------- axis orientation markers (X red, Y green, Z blue) ---------- */

  /* Materials whose depthTest/renderOrder flip when "visible through the base"
     is toggled. Labels always ignore depth so their text stays legible. */
  var axesDepthMaterials = [];

  /* A camera-facing text label drawn on a canvas, so it needs no font file or
     network access (works from file://). */
  function axisLabel(text, color, pos) {
    var px = 128;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.font = 'bold 88px system-ui, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px / 2, px / 2);
    var texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      depthTest: false, /* labels stay readable even behind the mesh */
      transparent: true
    }));
    sprite.position.copy(pos);
    sprite.scale.set(6, 6, 6);
    sprite.renderOrder = 999;
    return sprite;
  }

  var axes = new THREE.Group();
  var AXIS_LEN = 26;
  var AXIS_DEFS = [
    { dir: new THREE.Vector3(1, 0, 0), color: 0xe0524b, label: 'X', css: '#e0524b' },
    { dir: new THREE.Vector3(0, 1, 0), color: 0x59b85a, label: 'Y', css: '#59b85a' },
    { dir: new THREE.Vector3(0, 0, 1), color: 0x4d90e0, label: 'Z', css: '#4d90e0' }
  ];
  AXIS_DEFS.forEach(function (a) {
    var arrow = new THREE.ArrowHelper(
      a.dir, new THREE.Vector3(0, 0, 0), AXIS_LEN, a.color,
      AXIS_LEN * 0.22, /* head length */
      AXIS_LEN * 0.12  /* head width */
    );
    axesDepthMaterials.push(arrow.line.material, arrow.cone.material);
    axes.add(arrow);
    axes.add(axisLabel(a.label, a.css, a.dir.clone().multiplyScalar(AXIS_LEN + 4)));
  });
  scene.add(axes);

  /* Show/hide the whole marker, and optionally draw the arrows through the
     base (depthTest off + high renderOrder, like the labels always are). */
  function updateAxes() {
    axes.visible = inputs.axesEnabled.checked;
    var through = inputs.axesThrough.checked;
    axesDepthMaterials.forEach(function (m) {
      m.depthTest = !through;
      m.needsUpdate = true;
    });
    axes.traverse(function (obj) {
      if (obj.isLine || obj.isMesh) obj.renderOrder = through ? 998 : 0;
    });
  }

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

  function currentBevelType() {
    for (var i = 0; i < inputs.bevelTypeRadios.length; i++) {
      if (inputs.bevelTypeRadios[i].checked) return inputs.bevelTypeRadios[i].value;
    }
    return 'flat';
  }

  function currentTerrainResMode() {
    for (var i = 0; i < inputs.terrainResRadios.length; i++) {
      if (inputs.terrainResRadios[i].checked) return inputs.terrainResRadios[i].value;
    }
    return '24';
  }

  function currentTerrainRings() {
    var mode = currentTerrainResMode();
    if (mode === 'custom') {
      return clamp(Math.round(num(inputs.terrainResCustom, 64)), 4, 256);
    }
    return parseInt(mode, 10);
  }

  /* Custom angular segments override; 0 means "derive from the ring count". */
  function currentTerrainSegments() {
    if (currentTerrainResMode() !== 'custom') return 0;
    return clamp(Math.round(num(inputs.terrainSegCustom, 256)), 96, 1024);
  }

  /* Footprint half-extents, matching resolveRadii in geometry.js. */
  function footprintRadii(p) {
    if (p.shape === 'round') return { rx: p.diameter / 2, ry: p.diameter / 2 };
    if (p.shape === 'ellipse') return { rx: p.width / 2, ry: p.depth / 2 };
    if (p.shape === 'hexagon') return { rx: p.hexFlat / 2, ry: p.hexFlat / 2 };
    return { rx: p.side / 2, ry: p.side / 2 };
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
      hexFlat: clamp(num(inputs.hexFlat, 25), 5, 300),
      cornerRadius: 0,
      height: clamp(num(inputs.height, 4), 1, 50),
      bevel: 0,
      bevelType: currentBevelType(),
      magnet: { enabled: false, diameter: 5, depth: 2, offsetX: 0, offsetY: 0 },
      slit: { enabled: false, length: 20, width: 3 },
      terrain: { enabled: false }
    };

    if (shape === 'rounded-square') {
      var maxCorner = p.side / 2;
      var reqCorner = num(inputs.cornerRadius, 0);
      p.cornerRadius = clamp(reqCorner, 0, maxCorner);
      if (reqCorner > maxCorner + 1e-9) {
        hints.push('Corner radius limited to ' + p.cornerRadius.toFixed(1) + ' mm by the base size.');
      }
    }

    var minFootprint;
    if (shape === 'round') minFootprint = p.diameter;
    else if (shape === 'ellipse') minFootprint = Math.min(p.width, p.depth);
    else if (shape === 'hexagon') minFootprint = p.hexFlat;
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

    /* Terrain is read before the slit and wins over it: the two are mutually
       exclusive (v1). A displaced top surface can't also host the slit's
       through-cut, so an active terrain forces the slit off. */
    var terrainActive = false;
    if (inputs.terrainEnabled.checked) {
      var buf = HeightMap.get();
      if (!buf) {
        hints.push('Load a height map to add terrain.');
      } else {
        var tr = footprintRadii(p);
        var relief = clamp(num(inputs.terrainRelief, 2), 0.2, 20);
        var baseOff = clamp(num(inputs.terrainBase, 0), 0, 10);
        var contrast = clamp(num(inputs.terrainContrast, 1), 0.1, 2);
        p.terrain = {
          enabled: true,
          rings: currentTerrainRings(),
          segments: currentTerrainSegments(),
          relief: relief,
          displace: HeightMap.makeDisplace(buf, {
            rx: tr.rx, ry: tr.ry,
            reliefHeight: relief, baseOffset: baseOff,
            invert: inputs.terrainInvert.checked, contrast: contrast
          })
        };
        terrainActive = true;
        if (buf.downsampled) {
          hints.push('Height map downsampled to ' + buf.width + ' × ' + buf.height +
            ' px for preview and export.');
        }
      }
    }
    if (terrainActive && inputs.slitEnabled.checked) {
      hints.push('Terrain and slit can’t be combined — slit disabled.');
    }

    /* Read the slit before the magnet: the magnet clamp needs p.slit. */
    if (!terrainActive && inputs.slitEnabled.checked) {
      var sLen = Math.max(0, num(inputs.slitLength, 20));
      var sWid = Math.max(0, num(inputs.slitWidth, 3));
      if (sLen > 0 && sWid > 0) {
        var sFit = BaseGeometry.clampSlitSize(p, sLen, sWid, 1.5);
        if (sFit.length < 1 || sFit.width < 0.2) {
          hints.push('Base is too small for a slit — slit disabled.');
        } else {
          if (sFit.scaled) {
            hints.push('Slit limited to ' + sFit.length.toFixed(1) + ' × ' +
              sFit.width.toFixed(1) + ' mm (1.5 mm wall).');
          }
          p.slit = { enabled: true, length: sFit.length, width: sFit.width };
        }
      }
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
          p.magnet = { enabled: true, diameter: mDia, depth: mDepth, offsetX: 0, offsetY: 0 };
          var ox = clamp(num(inputs.magnetOffsetX, 0), -300, 300);
          var oy = clamp(num(inputs.magnetOffsetY, 0), -300, 300);
          /* with a slit even a zero offset must be validated (it overlaps) */
          if (ox !== 0 || oy !== 0 || p.slit.enabled) {
            var off = BaseGeometry.clampMagnetOffset(p, ox, oy, 1.5);
            if (!off.valid) {
              /* suggest a sideways offset that clears the slit, if one exists */
              var need = p.slit.width / 2 + mDia / 2 + 1.5;
              var probe = BaseGeometry.clampMagnetOffset(p, 0, need, 1.5);
              hints.push(probe.valid
                ? 'Magnet recess overlaps the slit — offset it sideways (e.g. Y ≥ ' +
                  need.toFixed(1) + ' mm) or disable one of the two.'
                : 'Base is too small for slit + magnet — magnet disabled.');
              p.magnet.enabled = false;
            } else {
              if (off.pushed) {
                hints.push('Magnet offset increased to ' + off.x.toFixed(1) + ', ' +
                  off.y.toFixed(1) + ' mm to clear the slit.');
              } else if (off.scaled) {
                hints.push('Magnet offset limited to ' + off.x.toFixed(1) + ', ' +
                  off.y.toFixed(1) + ' mm (1.5 mm wall).');
              }
              p.magnet.offsetX = off.x;
              p.magnet.offsetY = off.y;
            }
          }
        }
      }
    }

    return { params: p, hints: hints };
  }

  function footprintLabel(p) {
    if (p.shape === 'round') return p.diameter.toFixed(1) + ' mm round';
    if (p.shape === 'ellipse') return p.width.toFixed(1) + ' × ' + p.depth.toFixed(1) + ' mm oval';
    if (p.shape === 'hexagon') return p.hexFlat.toFixed(1) + ' mm hexagon (flat-to-flat)';
    if (p.shape === 'rounded-square') return p.side.toFixed(1) + ' mm rounded square (r' + p.cornerRadius.toFixed(1) + ')';
    return p.side.toFixed(1) + ' mm square';
  }

  var currentParams = null;

  function regenerate() {
    var result = readParams();
    currentParams = result.params;

    var geometry;
    try {
      geometry = BaseGeometry.build(currentParams);
    } catch (err) {
      /* The clamps make this unreachable for known combinations, but if a
         build ever throws we keep the last good mesh on screen and surface
         the failure instead of letting the exception escape the input
         handler (which would freeze the preview with no explanation). */
      hintsEl.hidden = false;
      hintsEl.textContent = result.hints.concat(
        'Could not generate this base — try different settings.').join('\n');
      return;
    }

    var old = mesh.geometry;
    mesh.geometry = geometry;
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
      var shapes = fields[i].getAttribute('data-shape').split(' ');
      fields[i].hidden = shapes.indexOf(shape) === -1;
    }
  }

  function updateEnabledStates() {
    inputs.bevelSize.disabled = !inputs.bevelEnabled.checked;
    for (var i = 0; i < inputs.bevelTypeRadios.length; i++) {
      inputs.bevelTypeRadios[i].disabled = !inputs.bevelEnabled.checked;
    }
    inputs.magnetDiameter.disabled = !inputs.magnetEnabled.checked;
    inputs.magnetDepth.disabled = !inputs.magnetEnabled.checked;
    inputs.magnetOffsetX.disabled = !inputs.magnetEnabled.checked;
    inputs.magnetOffsetY.disabled = !inputs.magnetEnabled.checked;
    /* Terrain and slit are mutually exclusive: each disables the other's
       controls while it is on, so the conflict can't be entered from the UI. */
    var terrainOn = inputs.terrainEnabled.checked;
    var slitOn = inputs.slitEnabled.checked;
    inputs.slitEnabled.disabled = terrainOn;
    inputs.slitLength.disabled = !slitOn || terrainOn;
    inputs.slitWidth.disabled = !slitOn || terrainOn;

    inputs.terrainEnabled.disabled = slitOn;
    inputs.terrainImage.disabled = !terrainOn || slitOn;
    inputs.terrainRelief.disabled = !terrainOn || slitOn;
    inputs.terrainBase.disabled = !terrainOn || slitOn;
    inputs.terrainContrast.disabled = !terrainOn || slitOn;
    inputs.terrainInvert.disabled = !terrainOn || slitOn;
    var terrainUsable = terrainOn && !slitOn;
    for (var t = 0; t < inputs.terrainResRadios.length; t++) {
      inputs.terrainResRadios[t].disabled = !terrainUsable;
    }
    var customMode = currentTerrainResMode() === 'custom';
    inputs.terrainResCustomField.hidden = !customMode;
    inputs.terrainResCustom.disabled = !terrainUsable || !customMode;
    inputs.terrainSegCustomField.hidden = !customMode;
    inputs.terrainSegCustom.disabled = !terrainUsable || !customMode;
  }

  function onAnyInput() {
    inputs.preset.value = '';
    updatePresetDeleteVisibility();
    updateEnabledStates();
    regenerate();
  }

  var plainInputs = [
    inputs.diameter, inputs.width, inputs.depth, inputs.side, inputs.hexFlat, inputs.cornerRadius, inputs.height,
    inputs.bevelEnabled, inputs.bevelSize,
    inputs.magnetEnabled, inputs.magnetDiameter, inputs.magnetDepth,
    inputs.magnetOffsetX, inputs.magnetOffsetY,
    inputs.slitEnabled, inputs.slitLength, inputs.slitWidth,
    inputs.terrainEnabled, inputs.terrainRelief, inputs.terrainBase,
    inputs.terrainContrast, inputs.terrainInvert,
    inputs.terrainResCustom, inputs.terrainSegCustom
  ];
  plainInputs.forEach(function (input) {
    input.addEventListener('input', onAnyInput);
  });

  /* Live-update the contrast readout beside its slider. */
  function updateContrastReadout() {
    inputs.terrainContrastValue.textContent = num(inputs.terrainContrast, 1).toFixed(2);
  }
  inputs.terrainContrast.addEventListener('input', updateContrastReadout);

  for (var i = 0; i < inputs.bevelTypeRadios.length; i++) {
    inputs.bevelTypeRadios[i].addEventListener('change', onAnyInput);
  }

  for (var i = 0; i < inputs.terrainResRadios.length; i++) {
    inputs.terrainResRadios[i].addEventListener('change', onAnyInput);
  }

  /* Load a height map from disk; the decoded buffer lives in HeightMap. */
  inputs.terrainImage.addEventListener('change', function () {
    var file = inputs.terrainImage.files && inputs.terrainImage.files[0];
    if (!file) return;
    HeightMap.load(file, function (info, err) {
      if (err || !info) {
        HeightMap.clear();
        inputs.terrainPreview.hidden = true;
        hintsEl.hidden = false;
        hintsEl.textContent = (err && err.message) || 'Could not load the height map.';
        return;
      }
      if (inputs.terrainThumb.src) URL.revokeObjectURL(inputs.terrainThumb.src);
      inputs.terrainThumb.src = URL.createObjectURL(file);
      inputs.terrainPreview.hidden = false;
      regenerate();
    });
  });

  inputs.terrainClear.addEventListener('click', function () {
    HeightMap.clear();
    inputs.terrainImage.value = '';
    if (inputs.terrainThumb.src) URL.revokeObjectURL(inputs.terrainThumb.src);
    inputs.terrainThumb.removeAttribute('src');
    inputs.terrainPreview.hidden = true;
    regenerate();
  });

  /* Preview-only: recolor the material directly, no geometry rebuild. */
  inputs.meshColor.addEventListener('input', function () {
    material.color.set(inputs.meshColor.value);
  });

  /* Preview-only: axis marker visibility and see-through mode. */
  inputs.axesEnabled.addEventListener('change', updateAxes);
  inputs.axesThrough.addEventListener('change', updateAxes);
  updateAxes();

  for (var i = 0; i < inputs.shapeRadios.length; i++) {
    inputs.shapeRadios[i].addEventListener('change', function () {
      inputs.preset.value = '';
      updatePresetDeleteVisibility();
      updateShapeFields();
      regenerate();
    });
  }

  /* Shared by the built-in shape:dims presets and applyFullConfig — sets the
     shape radio and whichever dimension fields are present on cfg (the
     built-in handler passes only the fields its shape uses; a saved custom
     preset always has all of them, since snapshotInputs reads every field
     regardless of the shape active when it was saved). */
  function applyShapeDims(cfg) {
    for (var i = 0; i < inputs.shapeRadios.length; i++) {
      inputs.shapeRadios[i].checked = inputs.shapeRadios[i].value === cfg.shape;
    }
    if (cfg.diameter !== undefined) inputs.diameter.value = cfg.diameter;
    if (cfg.width !== undefined) inputs.width.value = cfg.width;
    if (cfg.depth !== undefined) inputs.depth.value = cfg.depth;
    if (cfg.side !== undefined) inputs.side.value = cfg.side;
    if (cfg.hexFlat !== undefined) inputs.hexFlat.value = cfg.hexFlat;
    if (cfg.cornerRadius !== undefined) inputs.cornerRadius.value = cfg.cornerRadius;
  }

  /* Raw field values (not the post-clamp params) for a custom preset, so
     clamping re-applies naturally on load. Terrain is deliberately excluded
     — its displace() closure can't be serialized, and a partially-restored
     terrain state (image gone, sliders back) would be confusing. */
  function snapshotInputs() {
    return {
      shape: currentShape(),
      diameter: inputs.diameter.value,
      width: inputs.width.value,
      depth: inputs.depth.value,
      side: inputs.side.value,
      hexFlat: inputs.hexFlat.value,
      cornerRadius: inputs.cornerRadius.value,
      height: inputs.height.value,
      bevelEnabled: inputs.bevelEnabled.checked,
      bevelType: currentBevelType(),
      bevelSize: inputs.bevelSize.value,
      magnetEnabled: inputs.magnetEnabled.checked,
      magnetDiameter: inputs.magnetDiameter.value,
      magnetDepth: inputs.magnetDepth.value,
      magnetOffsetX: inputs.magnetOffsetX.value,
      magnetOffsetY: inputs.magnetOffsetY.value,
      slitEnabled: inputs.slitEnabled.checked,
      slitLength: inputs.slitLength.value,
      slitWidth: inputs.slitWidth.value
    };
  }

  /* Restores a full custom-preset snapshot, including bevel/magnet/slit
     on/off state — unlike the built-in presets, which only ever touch shape
     and dimensions. */
  function applyFullConfig(cfg) {
    applyShapeDims(cfg);
    inputs.height.value = cfg.height;
    inputs.bevelEnabled.checked = cfg.bevelEnabled;
    for (var i = 0; i < inputs.bevelTypeRadios.length; i++) {
      inputs.bevelTypeRadios[i].checked = inputs.bevelTypeRadios[i].value === cfg.bevelType;
    }
    inputs.bevelSize.value = cfg.bevelSize;
    inputs.magnetEnabled.checked = cfg.magnetEnabled;
    inputs.magnetDiameter.value = cfg.magnetDiameter;
    inputs.magnetDepth.value = cfg.magnetDepth;
    inputs.magnetOffsetX.value = cfg.magnetOffsetX;
    inputs.magnetOffsetY.value = cfg.magnetOffsetY;
    inputs.slitEnabled.checked = cfg.slitEnabled;
    inputs.slitLength.value = cfg.slitLength;
    inputs.slitWidth.value = cfg.slitWidth;
  }

  /* Custom entries are packed as "custom:" + name (not name:dims like the
     built-in presets); extracted with slice() rather than split(':') so a
     name containing a colon round-trips. */
  var CUSTOM_PREFIX = 'custom:';
  function isCustomPresetValue(value) {
    return value.indexOf(CUSTOM_PREFIX) === 0;
  }
  function customPresetName(value) {
    return value.slice(CUSTOM_PREFIX.length);
  }

  /* Rebuilds the "My presets" optgroup from storage; called on load and
     after every save/delete. */
  function refreshPresetOptions() {
    inputs.presetGroup.innerHTML = '';
    var list = PresetStore.list();
    inputs.presetGroup.hidden = list.length === 0;
    list.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = CUSTOM_PREFIX + p.name;
      opt.textContent = p.name;
      inputs.presetGroup.appendChild(opt);
    });
  }

  function updatePresetDeleteVisibility() {
    inputs.presetDelete.hidden = !isCustomPresetValue(inputs.preset.value);
  }

  inputs.preset.addEventListener('change', function () {
    var value = inputs.preset.value;
    updatePresetDeleteVisibility();
    if (!value) return;

    if (isCustomPresetValue(value)) {
      var name = customPresetName(value);
      var cfg = PresetStore.get(name);
      if (!cfg) return;
      applyFullConfig(cfg);
      updateShapeFields();
      updateEnabledStates();
      regenerate();
      var fr = footprintRadii(currentParams);
      fitCamera(Math.max(fr.rx, fr.ry) * 2);
      return;
    }

    var parts = value.split(':');
    var shape = parts[0];
    var dims = parts[1].split('x').map(parseFloat);
    var dimsCfg = { shape: shape };
    if (shape === 'round') dimsCfg.diameter = dims[0];
    else if (shape === 'ellipse') { dimsCfg.width = dims[0]; dimsCfg.depth = dims[1]; }
    else dimsCfg.side = dims[0];
    applyShapeDims(dimsCfg);

    updateShapeFields();
    regenerate();
    fitCamera(Math.max.apply(null, dims));
  });

  /* ---------- custom preset save / overwrite / delete (dialog-driven) ---------- */

  function openSaveDialog() {
    var note = document.createElement('p');
    note.textContent = 'Save the current configuration as a custom preset. Terrain is not included.';
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 50;
    input.placeholder = 'Preset name';

    Dialog.open({
      title: 'Save preset',
      bodyNodes: [note, input],
      confirmLabel: 'Save',
      focusEl: input,
      onConfirm: function () {
        var name = input.value.trim().slice(0, 50);
        if (!name) { input.focus(); return; }
        var existing = PresetStore.list().filter(function (e) {
          return e.name.toLowerCase() === name.toLowerCase();
        })[0];
        if (existing) {
          showOverwriteConfirm(existing.name);
          return;
        }
        savePreset(name);
      }
    });
  }

  function showOverwriteConfirm(name) {
    var note = document.createElement('p');
    note.textContent = 'A preset named "' + name + '" already exists. Overwrite it?';
    Dialog.update({
      title: 'Overwrite preset?',
      bodyNodes: [note],
      confirmLabel: 'Overwrite',
      onConfirm: function () { savePreset(name); }
    });
  }

  function savePreset(name) {
    var ok = PresetStore.save(name, snapshotInputs());
    Dialog.close();
    if (!ok) {
      hintsEl.hidden = false;
      hintsEl.textContent = 'Could not save the preset (browser storage unavailable).';
      return;
    }
    refreshPresetOptions();
    inputs.preset.value = CUSTOM_PREFIX + name;
    updatePresetDeleteVisibility();
  }

  inputs.presetSave.addEventListener('click', openSaveDialog);

  inputs.presetDelete.addEventListener('click', function () {
    var value = inputs.preset.value;
    if (!isCustomPresetValue(value)) return;
    var name = customPresetName(value);

    var note = document.createElement('p');
    note.textContent = 'Delete the preset "' + name + '"? This cannot be undone.';
    Dialog.open({
      title: 'Delete preset',
      bodyNodes: [note],
      confirmLabel: 'Delete',
      onConfirm: function () {
        PresetStore.remove(name);
        Dialog.close();
        refreshPresetOptions();
        inputs.preset.value = '';
        updatePresetDeleteVisibility();
      }
    });
  });

  function makeFilename(p) {
    function f(n) { return n.toFixed(1); }
    var size;
    if (p.shape === 'round') size = 'round-' + f(p.diameter) + 'mm';
    else if (p.shape === 'ellipse') size = 'oval-' + f(p.width) + 'x' + f(p.depth) + 'mm';
    else if (p.shape === 'hexagon') size = 'hex-' + f(p.hexFlat) + 'mm';
    else if (p.shape === 'rounded-square') size = 'rsquare-' + f(p.side) + 'mm-r' + f(p.cornerRadius);
    else size = 'square-' + f(p.side) + 'mm';
    var name = 'base-' + size + '-h' + f(p.height);
    if (p.bevel > 0) name += (p.bevelType === 'round' ? '-rb' : '-b') + f(p.bevel);
    if (p.magnet.enabled) {
      name += '-mag' + f(p.magnet.diameter) + 'x' + f(p.magnet.depth);
      if (p.magnet.offsetX !== 0 || p.magnet.offsetY !== 0) {
        name += '-off' + f(p.magnet.offsetX) + 'x' + f(p.magnet.offsetY);
      }
    }
    if (p.slit.enabled) {
      name += '-slit' + f(p.slit.length) + 'x' + f(p.slit.width);
    }
    if (p.terrain && p.terrain.enabled) {
      name += '-terrain-r' + f(p.terrain.relief);
    }
    return name + '.stl';
  }

  exportBtn.addEventListener('click', function () {
    StlExport.download(mesh.geometry, makeFilename(currentParams));
  });

  /* ---------- initial state ---------- */

  refreshPresetOptions();
  updatePresetDeleteVisibility();
  updateShapeFields();
  updateEnabledStates();
  updateContrastReadout();
  regenerate();
})();
