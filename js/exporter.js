/*
 * exporter.js — binary STL writer.
 *
 * The geometry is already Z-up in millimetres, so vertices are written
 * verbatim. Facet normals are recomputed from the triangle edges rather
 * than reusing render normals.
 */
window.StlExport = (function () {
  'use strict';

  function geometryToStl(geometry) {
    var pos = geometry.getAttribute('position');
    var index = geometry.getIndex();
    var triCount = index ? index.count / 3 : pos.count / 3;

    var buffer = new ArrayBuffer(84 + triCount * 50);
    var view = new DataView(buffer);

    var header = 'tabletop-base-generator binary STL (units: mm)';
    for (var i = 0; i < Math.min(80, header.length); i++) {
      view.setUint8(i, header.charCodeAt(i));
    }
    view.setUint32(80, triCount, true);

    var offset = 84;
    for (var t = 0; t < triCount; t++) {
      var i0 = index ? index.getX(t * 3) : t * 3;
      var i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      var i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      var ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
      var bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
      var cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);

      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var wx = cx - ax, wy = cy - ay, wz = cz - az;
      var nx = uy * wz - uz * wy;
      var ny = uz * wx - ux * wz;
      var nz = ux * wy - uy * wx;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

      view.setFloat32(offset, nx / len, true);
      view.setFloat32(offset + 4, ny / len, true);
      view.setFloat32(offset + 8, nz / len, true);
      offset += 12;

      var verts = [ax, ay, az, bx, by, bz, cx, cy, cz];
      for (var k = 0; k < 9; k++) {
        view.setFloat32(offset, verts[k], true);
        offset += 4;
      }
      view.setUint16(offset, 0, true);
      offset += 2;
    }
    return buffer;
  }

  function download(geometry, filename) {
    var blob = new Blob([geometryToStl(geometry)], { type: 'model/stl' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  return {
    geometryToStl: geometryToStl,
    download: download
  };
})();
