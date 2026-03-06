import type { TriangleMesh, Vec2, Vec3 } from "../scene/types";
import { EPS, cross, dot, sub } from "./math";

export type Ray = { o: Vec3; d: Vec3 };

export type Hit = {
  t: number;
  normal: Vec3;
  materialId: number;
  uv0: Vec2;
  uv1: Vec2;
};

type TriData = {
  i0: number;
  i1: number;
  i2: number;
  materialId: number;
  min: Vec3;
  max: Vec3;
  centroid: Vec3;
};

type BvhNode = {
  min: Vec3;
  max: Vec3;
  left: number;
  right: number;
  start: number;
  count: number;
  axis: number;
};

type Bin = {
  count: number;
  min: Vec3;
  max: Vec3;
};

const SAH_BINS = 12;
const LEAF_SIZE = 4;

function boundsUnion(aMin: Vec3, aMax: Vec3, bMin: Vec3, bMax: Vec3): [Vec3, Vec3] {
  return [
    [Math.min(aMin[0], bMin[0]), Math.min(aMin[1], bMin[1]), Math.min(aMin[2], bMin[2])],
    [Math.max(aMax[0], bMax[0]), Math.max(aMax[1], bMax[1]), Math.max(aMax[2], bMax[2])]
  ];
}

function emptyBoundsMin(): Vec3 {
  return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
}

function emptyBoundsMax(): Vec3 {
  return [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
}

function surfaceArea(min: Vec3, max: Vec3): number {
  const ex = Math.max(0, max[0] - min[0]);
  const ey = Math.max(0, max[1] - min[1]);
  const ez = Math.max(0, max[2] - min[2]);
  return 2 * (ex * ey + ey * ez + ez * ex);
}

function axisOfMaxExtent(min: Vec3, max: Vec3): 0 | 1 | 2 {
  const ex = max[0] - min[0];
  const ey = max[1] - min[1];
  const ez = max[2] - min[2];
  if (ex >= ey && ex >= ez) {
    return 0;
  }
  if (ey >= ex && ey >= ez) {
    return 1;
  }
  return 2;
}

function intersectAabbTNear(ray: Ray, min: Vec3, max: Vec3, tMax: number): number | null {
  let t0 = 0;
  let t1 = tMax;
  for (let axis = 0; axis < 3; axis++) {
    const inv = 1 / ray.d[axis];
    let tNear = (min[axis] - ray.o[axis]) * inv;
    let tFar = (max[axis] - ray.o[axis]) * inv;
    if (tNear > tFar) {
      const tmp = tNear;
      tNear = tFar;
      tFar = tmp;
    }
    t0 = Math.max(t0, tNear);
    t1 = Math.min(t1, tFar);
    if (t1 < t0) {
      return null;
    }
  }
  return t0;
}

function intersectTri(ray: Ray, a: Vec3, b: Vec3, c: Vec3, tMax: number): { t: number; n: Vec3; u: number; v: number } | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const p = cross(ray.d, ac);
  const det = dot(ab, p);
  if (Math.abs(det) < EPS) {
    return null;
  }
  const invDet = 1 / det;
  const s = sub(ray.o, a);
  const u = invDet * dot(s, p);
  if (u < 0 || u > 1) {
    return null;
  }
  const q = cross(s, ab);
  const v = invDet * dot(ray.d, q);
  if (v < 0 || u + v > 1) {
    return null;
  }
  const t = invDet * dot(ac, q);
  if (t <= EPS || t >= tMax) {
    return null;
  }
  const n = cross(ab, ac);
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return { t, n: [n[0] / len, n[1] / len, n[2] / len], u, v };
}

export class TriangleBvh {
  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;
  private readonly uv2s: Float32Array;
  private triRefs: number[];
  private tris: TriData[];
  private readonly nodes: BvhNode[];

  constructor(meshes: TriangleMesh[]) {
    const mergedPositions: number[] = [];
    const mergedUv0: number[] = [];
    const mergedUv1: number[] = [];
    const triData: TriData[] = [];
    let vertexOffset = 0;

    for (const mesh of meshes) {
      const pos = mesh.positions;
      const vertexCount = Math.floor(pos.length / 3);
      const uv0 = mesh.uvs;
      const uv1 = mesh.uv2s;
      for (let i = 0; i < pos.length; i++) {
        mergedPositions.push(pos[i]);
      }
      for (let v = 0; v < vertexCount; v++) {
        const u0 = uv0 ? uv0[v * 2 + 0] ?? 0 : 0;
        const v0 = uv0 ? uv0[v * 2 + 1] ?? 0 : 0;
        const u1 = uv1 ? uv1[v * 2 + 0] ?? u0 : u0;
        const v1 = uv1 ? uv1[v * 2 + 1] ?? v0 : v0;
        mergedUv0.push(u0, v0);
        mergedUv1.push(u1, v1);
      }
      const defaultMat = mesh.materialId ?? 0;
      const triCount = Math.floor(mesh.indices.length / 3);
      for (let t = 0; t < triCount; t++) {
        const i0 = mesh.indices[t * 3 + 0] + vertexOffset;
        const i1 = mesh.indices[t * 3 + 1] + vertexOffset;
        const i2 = mesh.indices[t * 3 + 2] + vertexOffset;
        const a: Vec3 = [
          mergedPositions[i0 * 3 + 0],
          mergedPositions[i0 * 3 + 1],
          mergedPositions[i0 * 3 + 2]
        ];
        const b: Vec3 = [
          mergedPositions[i1 * 3 + 0],
          mergedPositions[i1 * 3 + 1],
          mergedPositions[i1 * 3 + 2]
        ];
        const c: Vec3 = [
          mergedPositions[i2 * 3 + 0],
          mergedPositions[i2 * 3 + 1],
          mergedPositions[i2 * 3 + 2]
        ];
        const min: Vec3 = [
          Math.min(a[0], b[0], c[0]),
          Math.min(a[1], b[1], c[1]),
          Math.min(a[2], b[2], c[2])
        ];
        const max: Vec3 = [
          Math.max(a[0], b[0], c[0]),
          Math.max(a[1], b[1], c[1]),
          Math.max(a[2], b[2], c[2])
        ];
        const centroid: Vec3 = [
          (a[0] + b[0] + c[0]) / 3,
          (a[1] + b[1] + c[1]) / 3,
          (a[2] + b[2] + c[2]) / 3
        ];
        triData.push({
          i0,
          i1,
          i2,
          materialId: mesh.materialIds?.[t] ?? defaultMat,
          min,
          max,
          centroid
        });
      }
      vertexOffset += pos.length / 3;
    }

    this.positions = new Float32Array(mergedPositions);
    this.uvs = new Float32Array(mergedUv0);
    this.uv2s = new Float32Array(mergedUv1);
    this.tris = triData;
    this.triRefs = triData.map((_, i) => i);
    this.nodes = [];
    if (this.tris.length) {
      this.buildNode(0, this.tris.length);
      this.reorderTrianglesForLeaves();
    }
  }

  private reorderTrianglesForLeaves(): void {
    const reordered = new Array<TriData>(this.tris.length);
    for (let i = 0; i < this.triRefs.length; i++) {
      reordered[i] = this.tris[this.triRefs[i]];
      this.triRefs[i] = i;
    }
    this.tris = reordered;
  }

  private centroidToBin(value: number, min: number, max: number): number {
    const extent = max - min;
    if (extent <= 1e-12) {
      return 0;
    }
    const u = (value - min) / extent;
    const bin = Math.floor(u * SAH_BINS);
    return Math.max(0, Math.min(SAH_BINS - 1, bin));
  }

  private computeBounds(start: number, end: number): { bMin: Vec3; bMax: Vec3; cMin: Vec3; cMax: Vec3 } {
    let bMin = emptyBoundsMin();
    let bMax = emptyBoundsMax();
    let cMin = emptyBoundsMin();
    let cMax = emptyBoundsMax();

    for (let i = start; i < end; i++) {
      const tri = this.tris[this.triRefs[i]];
      [bMin, bMax] = boundsUnion(bMin, bMax, tri.min, tri.max);
      [cMin, cMax] = boundsUnion(cMin, cMax, tri.centroid, tri.centroid);
    }
    return { bMin, bMax, cMin, cMax };
  }

  private findSahSplit(start: number, end: number, bMin: Vec3, bMax: Vec3, cMin: Vec3, cMax: Vec3):
    | { axis: number; splitBin: number; cost: number }
    | null {
    const nodeArea = Math.max(1e-12, surfaceArea(bMin, bMax));
    const triCount = end - start;
    const leafCost = triCount;
    let bestAxis = -1;
    let bestBin = -1;
    let bestCost = Number.POSITIVE_INFINITY;

    for (let axis = 0; axis < 3; axis++) {
      const extent = cMax[axis] - cMin[axis];
      if (extent <= 1e-12) {
        continue;
      }

      const bins: Bin[] = new Array(SAH_BINS);
      for (let i = 0; i < SAH_BINS; i++) {
        bins[i] = { count: 0, min: emptyBoundsMin(), max: emptyBoundsMax() };
      }

      for (let i = start; i < end; i++) {
        const tri = this.tris[this.triRefs[i]];
        const binId = this.centroidToBin(tri.centroid[axis], cMin[axis], cMax[axis]);
        const b = bins[binId];
        b.count++;
        [b.min, b.max] = boundsUnion(b.min, b.max, tri.min, tri.max);
      }

      const leftCount = new Array<number>(SAH_BINS).fill(0);
      const rightCount = new Array<number>(SAH_BINS).fill(0);
      const leftMin: Vec3[] = new Array(SAH_BINS);
      const leftMax: Vec3[] = new Array(SAH_BINS);
      const rightMin: Vec3[] = new Array(SAH_BINS);
      const rightMax: Vec3[] = new Array(SAH_BINS);

      let lc = 0;
      let lMin = emptyBoundsMin();
      let lMax = emptyBoundsMax();
      for (let i = 0; i < SAH_BINS; i++) {
        lc += bins[i].count;
        leftCount[i] = lc;
        [lMin, lMax] = boundsUnion(lMin, lMax, bins[i].min, bins[i].max);
        leftMin[i] = lMin;
        leftMax[i] = lMax;
      }

      let rc = 0;
      let rMin = emptyBoundsMin();
      let rMax = emptyBoundsMax();
      for (let i = SAH_BINS - 1; i >= 0; i--) {
        rc += bins[i].count;
        rightCount[i] = rc;
        [rMin, rMax] = boundsUnion(rMin, rMax, bins[i].min, bins[i].max);
        rightMin[i] = rMin;
        rightMax[i] = rMax;
      }

      for (let split = 0; split < SAH_BINS - 1; split++) {
        const lc2 = leftCount[split];
        const rc2 = rightCount[split + 1];
        if (lc2 === 0 || rc2 === 0) {
          continue;
        }
        const lArea = surfaceArea(leftMin[split], leftMax[split]);
        const rArea = surfaceArea(rightMin[split + 1], rightMax[split + 1]);
        const cost = 1 + (lArea * lc2 + rArea * rc2) / nodeArea;
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestBin = split;
        }
      }
    }

    if (bestAxis < 0 || bestCost >= leafCost) {
      return null;
    }
    return { axis: bestAxis, splitBin: bestBin, cost: bestCost };
  }

  private partitionByBin(start: number, end: number, axis: number, splitBin: number, cMin: Vec3, cMax: Vec3): number {
    let i = start;
    let j = end - 1;
    while (i <= j) {
      const leftTri = this.tris[this.triRefs[i]];
      const leftBin = this.centroidToBin(leftTri.centroid[axis], cMin[axis], cMax[axis]);
      if (leftBin <= splitBin) {
        i++;
        continue;
      }
      const tmp = this.triRefs[i];
      this.triRefs[i] = this.triRefs[j];
      this.triRefs[j] = tmp;
      j--;
    }
    return i;
  }

  private buildNode(start: number, end: number): number {
    const { bMin, bMax, cMin, cMax } = this.computeBounds(start, end);
    const nodeIndex = this.nodes.length;
    const count = end - start;
    const node: BvhNode = {
      min: bMin,
      max: bMax,
      left: -1,
      right: -1,
      start,
      count,
      axis: -1
    };
    this.nodes.push(node);

    if (count <= LEAF_SIZE) {
      return nodeIndex;
    }

    const split = this.findSahSplit(start, end, bMin, bMax, cMin, cMax);
    let mid = -1;
    let axis = -1;

    if (split) {
      axis = split.axis;
      mid = this.partitionByBin(start, end, axis, split.splitBin, cMin, cMax);
    }

    if (mid <= start || mid >= end) {
      axis = axisOfMaxExtent(cMin, cMax);
      this.triRefs
        .slice(start, end)
        .sort((a, b) => this.tris[a].centroid[axis] - this.tris[b].centroid[axis])
        .forEach((v, i) => {
          this.triRefs[start + i] = v;
        });
      mid = (start + end) >> 1;
    }

    node.axis = axis;
    node.left = this.buildNode(start, mid);
    node.right = this.buildNode(mid, end);
    node.start = -1;
    node.count = 0;
    return nodeIndex;
  }

  private getVertex(i: number): Vec3 {
    return [this.positions[i * 3 + 0], this.positions[i * 3 + 1], this.positions[i * 3 + 2]];
  }

  private getUv0(i: number): Vec2 {
    return [this.uvs[i * 2 + 0], this.uvs[i * 2 + 1]];
  }

  private getUv1(i: number): Vec2 {
    return [this.uv2s[i * 2 + 0], this.uv2s[i * 2 + 1]];
  }

  intersect(ray: Ray, tMax = Number.POSITIVE_INFINITY): Hit | null {
    if (!this.nodes.length) {
      return null;
    }
    const stack: number[] = [0];
    let bestT = tMax;
    let best: Hit | null = null;

    while (stack.length) {
      const nodeIndex = stack.pop() as number;
      const n = this.nodes[nodeIndex];
      const tNear = intersectAabbTNear(ray, n.min, n.max, bestT);
      if (tNear === null) {
        continue;
      }

      if (n.left < 0 && n.right < 0) {
        for (let i = n.start; i < n.start + n.count; i++) {
          const tri = this.tris[i];
          const a = this.getVertex(tri.i0);
          const b = this.getVertex(tri.i1);
          const c = this.getVertex(tri.i2);
          const hit = intersectTri(ray, a, b, c, bestT);
          if (hit && hit.t < bestT) {
            bestT = hit.t;
            const w = 1 - hit.u - hit.v;
            const uv0a = this.getUv0(tri.i0);
            const uv0b = this.getUv0(tri.i1);
            const uv0c = this.getUv0(tri.i2);
            const uv1a = this.getUv1(tri.i0);
            const uv1b = this.getUv1(tri.i1);
            const uv1c = this.getUv1(tri.i2);
            best = {
              t: hit.t,
              normal: hit.n,
              materialId: tri.materialId,
              uv0: [
                uv0a[0] * w + uv0b[0] * hit.u + uv0c[0] * hit.v,
                uv0a[1] * w + uv0b[1] * hit.u + uv0c[1] * hit.v
              ],
              uv1: [
                uv1a[0] * w + uv1b[0] * hit.u + uv1c[0] * hit.v,
                uv1a[1] * w + uv1b[1] * hit.u + uv1c[1] * hit.v
              ]
            };
          }
        }
      } else {
        const l = n.left;
        const r = n.right;
        if (l < 0 || r < 0) {
          if (l >= 0) {
            stack.push(l);
          }
          if (r >= 0) {
            stack.push(r);
          }
          continue;
        }

        // Packet-friendly near-first traversal using split axis sign.
        if (n.axis >= 0 && ray.d[n.axis] >= 0) {
          stack.push(r);
          stack.push(l);
        } else if (n.axis >= 0) {
          stack.push(l);
          stack.push(r);
        } else {
          const ln = intersectAabbTNear(ray, this.nodes[l].min, this.nodes[l].max, bestT);
          const rn = intersectAabbTNear(ray, this.nodes[r].min, this.nodes[r].max, bestT);
          if (ln === null && rn === null) {
            continue;
          }
          if (ln === null) {
            stack.push(r);
          } else if (rn === null) {
            stack.push(l);
          } else if (ln <= rn) {
            stack.push(r);
            stack.push(l);
          } else {
            stack.push(l);
            stack.push(r);
          }
        }
      }
    }

    return best;
  }
}
