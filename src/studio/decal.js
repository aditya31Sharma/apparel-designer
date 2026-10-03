// Surface decal builder: clones the garment triangles that sit under a projector
// box, clips them to the print rectangle and lifts them off the fabric along
// their own normals. The print is fabric geometry, so it cannot float or cut
// through the garment (the rule that fixed every clipping bug by hand).
import * as THREE from 'three';

export const SURFACE_LIFT = 0.003;   // ~1.4 mm at garment scale
const FACING_MIN = 0.12;              // reject triangles that face away from the projector

export class SurfaceIndex {
  constructor(meshes) {
    const posList = [], nrmList = [], triCount = [];
    let total = 0;
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const g = mesh.geometry;
      const pos = g.attributes.position, nrm = g.attributes.normal;
      const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      const v = new THREE.Vector3();
      const P = new Float32Array(pos.count * 3), N = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
        v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
        N[i * 3] = v.x; N[i * 3 + 1] = v.y; N[i * 3 + 2] = v.z;
      }
      const idx = g.index ? g.index.array : null;
      const tris = idx ? idx.length / 3 : pos.count / 3;
      posList.push({ P, N, idx, tris });
      triCount.push(tris);
      total += tris;
    }
    // flatten every triangle into one corner array (positions + normals per corner)
    this.triCount = total;
    this.tp = new Float32Array(total * 9);
    this.tn = new Float32Array(total * 9);
    this.fn = new Float32Array(total * 3);
    this.cent = new Float32Array(total * 3);
    let t = 0;
    for (const { P, N, idx, tris } of posList) {
      for (let k = 0; k < tris; k++, t++) {
        for (let c = 0; c < 3; c++) {
          const vi = idx ? idx[k * 3 + c] : k * 3 + c;
          this.tp.set(P.subarray(vi * 3, vi * 3 + 3), t * 9 + c * 3);
          this.tn.set(N.subarray(vi * 3, vi * 3 + 3), t * 9 + c * 3);
        }
        const o = t * 9;
        const ax = this.tp[o + 3] - this.tp[o], ay = this.tp[o + 4] - this.tp[o + 1], az = this.tp[o + 5] - this.tp[o + 2];
        const bx = this.tp[o + 6] - this.tp[o], by = this.tp[o + 7] - this.tp[o + 1], bz = this.tp[o + 8] - this.tp[o + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const l = Math.hypot(nx, ny, nz) || 1;
        this.fn[t * 3] = nx / l; this.fn[t * 3 + 1] = ny / l; this.fn[t * 3 + 2] = nz / l;
        this.cent[t * 3] = (this.tp[o] + this.tp[o + 3] + this.tp[o + 6]) / 3;
        this.cent[t * 3 + 1] = (this.tp[o + 1] + this.tp[o + 4] + this.tp[o + 7]) / 3;
        this.cent[t * 3 + 2] = (this.tp[o + 2] + this.tp[o + 5] + this.tp[o + 8]) / 3;
      }
    }
    // uniform grid over triangle centroids
    this.cell = 0.06;
    this.grid = new Map();
    for (let i = 0; i < total; i++) {
      const key = this._key(this.cent[i * 3], this.cent[i * 3 + 1], this.cent[i * 3 + 2]);
      let arr = this.grid.get(key);
      if (!arr) { arr = []; this.grid.set(key, arr); }
      arr.push(i);
    }
    this.stamp = new Uint32Array(total);
    this.stampId = 1;
  }

  _key(x, y, z) {
    const c = this.cell;
    return ((Math.floor(x / c) + 512) * 1024 + (Math.floor(y / c) + 512)) * 1024 + (Math.floor(z / c) + 512);
  }

  // triangles whose centroid lies in the AABB, padded by one cell
  query(min, max) {
    const c = this.cell, out = [];
    const id = ++this.stampId;
    const x0 = Math.floor(min.x / c) - 1, x1 = Math.floor(max.x / c) + 1;
    const y0 = Math.floor(min.y / c) - 1, y1 = Math.floor(max.y / c) + 1;
    const z0 = Math.floor(min.z / c) - 1, z1 = Math.floor(max.z / c) + 1;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const arr = this.grid.get(((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512));
      if (!arr) continue;
      for (const t of arr) { if (this.stamp[t] !== id) { this.stamp[t] = id; out.push(t); } }
    }
    return out;
  }

  // area-weighted average face normal around a point, same side as `ref`
  smoothNormal(point, ref, radius) {
    const r = new THREE.Vector3(radius, radius, radius);
    const tris = this.query(point.clone().sub(r), point.clone().add(r));
    const acc = new THREE.Vector3();
    const r2 = radius * radius;
    for (const t of tris) {
      const dx = this.cent[t * 3] - point.x, dy = this.cent[t * 3 + 1] - point.y, dz = this.cent[t * 3 + 2] - point.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      let nx = this.fn[t * 3], ny = this.fn[t * 3 + 1], nz = this.fn[t * 3 + 2];
      const dot = nx * ref.x + ny * ref.y + nz * ref.z;
      if (Math.abs(dot) < 0.3) continue;
      if (dot < 0) { nx = -nx; ny = -ny; nz = -nz; }   // two-sided: inverted walls count too
      acc.x += nx; acc.y += ny; acc.z += nz;
    }
    return acc.lengthSq() > 1e-8 ? acc.normalize() : ref.clone().normalize();
  }
}

// frame: { origin, right, up, normal } (unit vectors), size: { w, h }, depth: half depth
export function buildDecalGeometry(index, frame, w, h, depth, lift = SURFACE_LIFT) {
  const { origin: O, right: R, up: U, normal: N } = frame;
  const hw = w / 2, hh = h / 2;
  const corners = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    corners.push(O.clone().addScaledVector(R, sx * hw).addScaledVector(U, sy * hh).addScaledVector(N, sz * depth));
  }
  const box = new THREE.Box3().setFromPoints(corners);
  const cand = index.query(box.min, box.max);

  const outP = [], outN = [], outUV = [];
  const tp = index.tp, tn = index.tn, fn = index.fn;
  const Ox = O.x, Oy = O.y, Oz = O.z;

  // Depth buffer in projector space, rasterized at sample points: Meshy garments
  // are often double-walled (~2 mm) and fold over themselves. Only the outermost
  // layer at each point gets the print. Comparing at identical sample points (not
  // bounding boxes) keeps sloped fabric from hiding its own neighbours.
  const S = Math.max(w, h) / 220;
  const Gx = Math.ceil(w / S) + 1, Gy = Math.ceil(h / S) + 1;
  const zbuf = new Float32Array(Gx * Gy).fill(-Infinity);
  const proj = new Float32Array(cand.length * 9);
  cand.forEach((t, ci) => {
    for (let c = 0; c < 3; c++) {
      const o = t * 9 + c * 3;
      const dx = tp[o] - Ox, dy = tp[o + 1] - Oy, dz = tp[o + 2] - Oz;
      proj[ci * 9 + c * 3] = dx * R.x + dy * R.y + dz * R.z;
      proj[ci * 9 + c * 3 + 1] = dx * U.x + dy * U.y + dz * U.z;
      proj[ci * 9 + c * 3 + 2] = dx * N.x + dy * N.y + dz * N.z;
    }
  });
  // calls cb(cellIndex, z) for every sample point inside projected triangle ci
  const raster = (ci, cb) => {
    const o = ci * 9;
    const x0 = proj[o], y0 = proj[o + 1], z0 = proj[o + 2];
    const x1 = proj[o + 3], y1 = proj[o + 4], z1 = proj[o + 5];
    const x2 = proj[o + 6], y2 = proj[o + 7], z2 = proj[o + 8];
    const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(den) < 1e-14) return 0;
    const gx0 = Math.max(0, Math.ceil((Math.min(x0, x1, x2) + hw) / S - 0.5));
    const gx1 = Math.min(Gx - 1, Math.floor((Math.max(x0, x1, x2) + hw) / S - 0.5));
    const gy0 = Math.max(0, Math.ceil((Math.min(y0, y1, y2) + hh) / S - 0.5));
    const gy1 = Math.min(Gy - 1, Math.floor((Math.max(y0, y1, y2) + hh) / S - 0.5));
    let n = 0;
    for (let gy = gy0; gy <= gy1; gy++) {
      const py = (gy + 0.5) * S - hh;
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = (gx + 0.5) * S - hw;
        const a = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den;
        const b = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den;
        const c = 1 - a - b;
        if (a < -1e-6 || b < -1e-6 || c < -1e-6) continue;
        n++;
        if (cb(gy * Gx + gx, a * z0 + b * z1 + c * z2) === false) return n;
      }
    }
    return n;
  };
  for (let ci = 0; ci < cand.length; ci++) {
    const zc = (proj[ci * 9 + 2] + proj[ci * 9 + 5] + proj[ci * 9 + 8]) / 3;
    if (zc < -depth || zc > depth * 1.5) continue;
    raster(ci, (k, z) => { if (z > zbuf[k]) zbuf[k] = z; });
  }
  const OCCLUDE_TOL = 0.0012;
  const occluded = (ci) => {
    let hidden = 0;
    const total = raster(ci, (k, z) => { if (zbuf[k] > z + OCCLUDE_TOL) hidden++; });
    return total > 0 && hidden * 2 > total;
  };
  // polygon vertex = [x,y,z (projector space), px,py,pz (world), nx,ny,nz]
  const planes = [[0, 1, hw], [0, -1, hw], [1, 1, hh], [1, -1, hh], [2, 1, depth], [2, -1, depth]];

  for (let ci = 0; ci < cand.length; ci++) {
    const t = cand[ci];
    // Meshy shells are often double-walled with the OUTER wall's normals pointing
    // inward, so facing is tested two-sided; the depth buffer keeps the outer wall.
    const facing = fn[t * 3] * N.x + fn[t * 3 + 1] * N.y + fn[t * 3 + 2] * N.z;
    if (Math.abs(facing) < FACING_MIN) continue;
    if (occluded(ci)) continue;
    const flip = facing < 0;
    let poly = [];
    for (let c = 0; c < 3; c++) {
      const o = t * 9 + c * 3;
      const px = tp[o], py = tp[o + 1], pz = tp[o + 2];
      const dx = px - Ox, dy = py - Oy, dz = pz - Oz;
      poly.push([dx * R.x + dy * R.y + dz * R.z, dx * U.x + dy * U.y + dz * U.z, dx * N.x + dy * N.y + dz * N.z,
        px, py, pz, tn[o], tn[o + 1], tn[o + 2]]);
    }
    for (const [axis, sign, lim] of planes) {
      if (!poly.length) break;
      const next = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const da = lim - sign * a[axis], db = lim - sign * b[axis];
        if (da >= 0) next.push(a);
        if ((da >= 0) !== (db >= 0)) {
          const s = da / (da - db);
          next.push(a.map((v, k) => v + (b[k] - v) * s));
        }
      }
      poly = next;
    }
    if (poly.length < 3) continue;
    for (let i = 1; i < poly.length - 1; i++) {
      // keep winding facing the projector (decals are single-sided)
      const tri = flip ? [poly[0], poly[i + 1], poly[i]] : [poly[0], poly[i], poly[i + 1]];
      for (const v of tri) {
        let nx = v[6], ny = v[7], nz = v[8];
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        // lift outward: normals on inverted walls point into the garment
        if (nx * N.x + ny * N.y + nz * N.z < 0) { nx = -nx; ny = -ny; nz = -nz; }
        outP.push(v[3] + nx * lift, v[4] + ny * lift, v[5] + nz * lift);
        outN.push(nx, ny, nz);
        outUV.push(v[0] / w + 0.5, v[1] / h + 0.5);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(outN, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(outUV, 2));
  geo.computeBoundingSphere();
  return geo;
}
