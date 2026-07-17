/*
 * heightmap.js — load a grayscale height map from disk and turn it into a pure
 * displacement function for the terrain top surface.
 *
 * Two halves, deliberately separated:
 *   - the DOM/browser side (load) decodes an image file into a plain pixel
 *     buffer via FileReader -> data URL -> <canvas> -> getImageData;
 *   - the pure side (sample, makeDisplace) is THREE-free and DOM-free so it can
 *     be unit-tested headlessly, exactly like BaseGeometry.buildPositions.
 *
 * geometry.js never touches a canvas: main.js builds a displace(x, y) closure
 * from makeDisplace and passes it in via params.terrain.displace.
 *
 * file:// note: the file MUST be read through a data: URL. Assigning a file://
 * path to img.src taints the canvas in some browsers, and getImageData then
 * throws a SecurityError. A data URL is same-origin, so the pixels read clean.
 */
window.HeightMap = (function () {
  'use strict';

  var MAX_DIM = 512; /* downsample larger sources to keep sampling cheap */

  /*
   * Bilinear luminance sample of a buffer { data (RGBA Uint8), width, height }
   * at UV in [0,1]. V is flipped because image row 0 is the top, while the
   * footprint's +Y is toward the back. Returns brightness in [0,1].
   */
  function sample(buf, u, v) {
    var w = buf.width, h = buf.height, data = buf.data;
    if (w < 1 || h < 1) return 0;
    u = u < 0 ? 0 : (u > 1 ? 1 : u);
    v = v < 0 ? 0 : (v > 1 ? 1 : v);
    var fx = u * (w - 1);
    var fy = (1 - v) * (h - 1); /* V flip */
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    var tx = fx - x0, ty = fy - y0;

    function lum(x, y) {
      var o = (y * w + x) * 4;
      return (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
    }
    var top = lum(x0, y0) * (1 - tx) + lum(x1, y0) * tx;
    var bot = lum(x0, y1) * (1 - tx) + lum(x1, y1) * tx;
    return top * (1 - ty) + bot * ty;
  }

  /*
   * Build a pure displace(x, y) -> mm closure. Maps a mesh vertex XY over the
   * footprint bbox [-rx, rx] x [-ry, ry] into UV, samples brightness, optionally
   * inverts, then scales: displacement = baseOffset + brightness * reliefHeight.
   * opts: { rx, ry, reliefHeight, baseOffset, invert }.
   */
  function makeDisplace(buf, opts) {
    var rx = opts.rx, ry = opts.ry;
    var relief = opts.reliefHeight || 0;
    var base = opts.baseOffset || 0;
    var invert = !!opts.invert;
    return function (x, y) {
      var u = (x + rx) / (2 * rx);
      var v = (y + ry) / (2 * ry);
      var b = sample(buf, u, v);
      if (invert) b = 1 - b;
      return base + b * relief;
    };
  }

  /* ---------- browser-only decode (not exercised under Node) ---------- */

  var current = null; /* { data, width, height, srcWidth, srcHeight, downsampled } */

  /*
   * Decode an image File into the working buffer, then invoke cb(info) where
   * info = { width, height, srcWidth, srcHeight, downsampled } — or cb(null, err)
   * on failure. Stores the buffer internally; read it with get().
   */
  function load(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { cb(null, new Error('Could not read the file.')); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { cb(null, new Error('Could not decode the image.')); };
      img.onload = function () {
        var sw = img.naturalWidth, sh = img.naturalHeight;
        var scale = Math.min(1, MAX_DIM / Math.max(sw, sh));
        var w = Math.max(1, Math.round(sw * scale));
        var h = Math.max(1, Math.round(sh * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var imageData;
        try {
          imageData = ctx.getImageData(0, 0, w, h);
        } catch (e) {
          cb(null, new Error('Could not read image pixels.'));
          return;
        }
        current = {
          data: imageData.data, width: w, height: h,
          srcWidth: sw, srcHeight: sh, downsampled: scale < 1
        };
        cb({ width: w, height: h, srcWidth: sw, srcHeight: sh, downsampled: scale < 1 });
      };
      img.src = reader.result; /* data: URL — same-origin, canvas stays clean */
    };
    reader.readAsDataURL(file);
  }

  function get() { return current; }
  function clear() { current = null; }

  return {
    sample: sample,
    makeDisplace: makeDisplace,
    load: load,
    get: get,
    clear: clear
  };
})();
