import type { Box, MaterialTextureRef, Plane, SerializedScene, Sphere, TriangleMesh, Vec2, Vec3 } from "../scene/types";
import { TriangleBvh, type Hit, type Ray } from "./bvh";
import { EPS, Rng, add, clamp01, cross, dot, hash4, mul, normalize, sub } from "./math";

export type RenderCamera = {
  pos: Vec3;
  target: Vec3;
  up: Vec3;
  fovY: number;
};

export type RenderSettings = {
  jobId: number;
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
  regionWidth?: number;
  regionHeight?: number;
  spp: number;
  maxBounces: number;
  lightIntensity?: number;
  shadowDarkness?: number;
  fireflyClamp?: number;
  fireflySuppression?: number;
  specularSpikeClamp?: number;
  extremeSpikeKill?: number;
  normalStrength?: number;
  tileSize?: number;
  partialInterval?: number;
  camera: RenderCamera;
  scene: SerializedScene;
  shouldCancel: () => boolean;
  onProgress?: (sample: number, spp: number) => void;
  onTile?: (x: number, y: number, width: number, height: number, rgba: Uint8ClampedArray) => void;
};

type HitRecord = Hit & { p: Vec3 };

type PbrMaterial = {
  baseColor: Vec3;
  emissive: Vec3;
  metallic: number;
  roughness: number;
  baseColorTexture?: MaterialTextureRef;
  emissiveTexture?: MaterialTextureRef;
  metallicRoughnessTexture?: MaterialTextureRef;
  normalTexture?: MaterialTextureRef;
  normalScale: number;
};

type EmissiveLight =
  | { type: "sphere"; sphere: Sphere; materialId: number; area: number; weight: number }
  | { type: "box"; box: Box; materialId: number; area: number; weight: number }
  | { type: "plane"; plane: Plane; materialId: number; area: number; weight: number }
  | {
      type: "triangles";
      mesh: TriangleMesh;
      triangleIndices: Uint32Array;
      cdf: Float32Array;
      totalArea: number;
      weight: number;
    };

type EmissiveLightSample = {
  position: Vec3;
  normal: Vec3;
  emission: Vec3;
  pdf: number;
};

const PI = Math.PI;
const lightDir = normalize([1, 2, 1]);
const skyColor: Vec3 = [0.35, 0.4, 0.5];
const ambient = 0.01;
const SHADOW_BIAS = 1e-2;
const MAX_THROUGHPUT = 8.0;
const DEFAULT_MAX_SAMPLE_LUMINANCE = 12.0;
const MIN_RAYTRACE_ROUGHNESS = 0.06;
const EMISSIVE_DIRECT_SAMPLES = 3;
const EMISSIVE_DIRECT_MAX_GEOM = 2.5;
const FIREFLY_NEIGHBOR_BOOST = 3.0;
const FIREFLY_CENTER_WEIGHT = 0.15;
const FIREFLY_TRIGGER_RATIO = 1.35;
const EXTREME_SPIKE_RATIO = 4.5;
const EXTREME_SPIKE_NEIGHBOR_LIMIT = 1.6;

function mulVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

function oneMinus(v: Vec3): Vec3 {
  return [1 - v[0], 1 - v[1], 1 - v[2]];
}

function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function luminance(c: Vec3): number {
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}

function clampVecMax(v: Vec3, maxValue: number): Vec3 {
  return [
    Math.min(maxValue, Math.max(0, v[0])),
    Math.min(maxValue, Math.max(0, v[1])),
    Math.min(maxValue, Math.max(0, v[2]))
  ];
}

function clampLuminance(v: Vec3, maxLum: number): Vec3 {
  const lum = luminance(v);
  if (lum <= maxLum || lum <= 1e-8) {
    return v;
  }
  const s = maxLum / lum;
  return [v[0] * s, v[1] * s, v[2] * s];
}

function clampThroughput(v: Vec3, maxLum: number): Vec3 {
  return clampLuminance(clampVecMax(v, MAX_THROUGHPUT), maxLum);
}

function clampSecondaryContribution(v: Vec3, bounce: number, specularSpikeClamp: number, maxSampleLuminance: number): Vec3 {
  const limit = bounce >= 1 ? Math.min(maxSampleLuminance, specularSpikeClamp) : maxSampleLuminance;
  return clampLuminance(v, limit);
}

function clampEmissiveDirectContribution(v: Vec3, specularSpikeClamp: number, maxSampleLuminance: number): Vec3 {
  return clampLuminance(v, Math.min(maxSampleLuminance, specularSpikeClamp * 0.7));
}

function mulScalar(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] * b[0] * s, a[1] * b[1] * s, a[2] * b[2] * s];
}

function safeNormalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

function getMaterial(scene: SerializedScene, materialId: number): PbrMaterial {
  const m = scene.materials[materialId];
  return {
    baseColor: m?.baseColor ?? [1, 1, 1],
    emissive: m?.emissive ?? [0, 0, 0],
    metallic: Math.max(0, Math.min(1, m?.metallic ?? 0)),
    roughness: Math.max(MIN_RAYTRACE_ROUGHNESS, Math.min(1, m?.roughness ?? 0.7)),
    baseColorTexture: m?.baseColorTexture,
    emissiveTexture: m?.emissiveTexture,
    metallicRoughnessTexture: m?.metallicRoughnessTexture,
    normalTexture: m?.normalTexture,
    normalScale: Math.max(0, m?.normalScale ?? 1)
  };
}

function emissivePower(mat: PbrMaterial): number {
  return luminance(mat.emissive);
}

function intersectSphere(ray: Ray, s: Sphere, tMax: number): Hit | null {
  const oc = sub(ray.o, s.center);
  const a = dot(ray.d, ray.d);
  const b = 2 * dot(oc, ray.d);
  const c = dot(oc, oc) - s.radius * s.radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    return null;
  }
  const sd = Math.sqrt(disc);
  let t = (-b - sd) / (2 * a);
  if (t <= EPS || t >= tMax) {
    t = (-b + sd) / (2 * a);
  }
  if (t <= EPS || t >= tMax) {
    return null;
  }
  const p = add(ray.o, mul(ray.d, t));
  const n = normalize(sub(p, s.center));
  return {
    t,
    normal: n,
    geomNormal: n,
    tangent: [1, 0, 0],
    bitangent: [0, 0, 1],
    materialId: s.materialId,
    uv0: [0, 0],
    uv1: [0, 0]
  };
}

function intersectPlane(ray: Ray, p: Plane, tMax: number): Hit | null {
  const n = normalize(p.normal);
  const den = dot(n, ray.d);
  if (Math.abs(den) < EPS) {
    return null;
  }
  const t = -(dot(n, ray.o) + p.d) / den;
  if (t <= EPS || t >= tMax) {
    return null;
  }
  const nn = den < 0 ? n : mul(n, -1);
  return {
    t,
    normal: nn,
    geomNormal: nn,
    tangent: [1, 0, 0],
    bitangent: [0, 0, 1],
    materialId: p.materialId,
    uv0: [0, 0],
    uv1: [0, 0]
  };
}

function intersectBox(ray: Ray, b: Box, tMax: number): Hit | null {
  const min: Vec3 = [
    b.center[0] - b.halfExtents[0],
    b.center[1] - b.halfExtents[1],
    b.center[2] - b.halfExtents[2]
  ];
  const max: Vec3 = [
    b.center[0] + b.halfExtents[0],
    b.center[1] + b.halfExtents[1],
    b.center[2] + b.halfExtents[2]
  ];
  let tNear = 0;
  let tFar = tMax;
  let hitAxis = 0;
  for (let axis = 0; axis < 3; axis++) {
    const inv = 1 / ray.d[axis];
    let t0 = (min[axis] - ray.o[axis]) * inv;
    let t1 = (max[axis] - ray.o[axis]) * inv;
    if (t0 > t1) {
      const tmp = t0;
      t0 = t1;
      t1 = tmp;
    }
    if (t0 > tNear) {
      tNear = t0;
      hitAxis = axis;
    }
    tFar = Math.min(tFar, t1);
    if (tNear > tFar) {
      return null;
    }
  }
  if (tNear <= EPS || tNear >= tMax) {
    return null;
  }
  const p = add(ray.o, mul(ray.d, tNear));
  const n: Vec3 = [0, 0, 0];
  n[hitAxis] = p[hitAxis] > b.center[hitAxis] ? 1 : -1;
  return {
    t: tNear,
    normal: n,
    geomNormal: n,
    tangent: [1, 0, 0],
    bitangent: [0, 0, 1],
    materialId: b.materialId,
    uv0: [0, 0],
    uv1: [0, 0]
  };
}

function intersectScene(ray: Ray, scene: SerializedScene, triBvh: TriangleBvh | null, tMax = Infinity): HitRecord | null {
  let bestT = tMax;
  let best: Hit | null = null;
  for (const obj of scene.objects) {
    if (obj.type === "triangles") {
      continue;
    }
    const h =
      obj.type === "sphere"
        ? intersectSphere(ray, obj, bestT)
        : obj.type === "plane"
          ? intersectPlane(ray, obj, bestT)
          : intersectBox(ray, obj, bestT);
    if (h && h.t < bestT) {
      bestT = h.t;
      best = h;
    }
  }
  if (triBvh) {
    const triHit = triBvh.intersect(ray, bestT);
    if (triHit && triHit.t < bestT) {
      bestT = triHit.t;
      best = triHit;
    }
  }
  if (!best) {
    return null;
  }
  return { ...best, p: add(ray.o, mul(ray.d, bestT)) };
}

function isOccluded(origin: Vec3, dir: Vec3, scene: SerializedScene, triBvh: TriangleBvh | null, maxT = 1e6): boolean {
  const shadowRay: Ray = { o: origin, d: dir };
  return intersectScene(shadowRay, scene, triBvh, maxT) !== null;
}

function toSrgb8(x: number): number {
  const g = Math.pow(clamp01(x), 1 / 2.2);
  return Math.round(g * 255);
}

function srgbToLinear(x: number): number {
  const c = clamp01(x);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function wrapUv(v: number, mode: number): number {
  if (mode === 0) {
    return clamp01(v);
  }
  if (mode === 2) {
    const t = ((v % 2) + 2) % 2;
    return t <= 1 ? t : 2 - t;
  }
  return v - Math.floor(v);
}

function sampleTextureRgba(scene: SerializedScene, texRef: MaterialTextureRef, uv0: Vec2, uv1: Vec2): [number, number, number, number] {
  const tex = scene.textures?.[texRef.textureId];
  if (!tex || tex.width < 1 || tex.height < 1 || tex.rgba.length < tex.width * tex.height * 4) {
    return [1, 1, 1, 1];
  }

  const uv = texRef.texCoord === 1 ? uv1 : uv0;
  const t = texRef.transform;
  const tu0 = t[0] * uv[0] + t[1] * uv[1] + t[2];
  const tv0 = t[3] * uv[0] + t[4] * uv[1] + t[5];
  const u = wrapUv(tu0, texRef.wrapU);
  const v = wrapUv(tv0, texRef.wrapV);
  const x = u * (tex.width - 1);
  const y = (1 - v) * (tex.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(tex.width - 1, x0 + 1);
  const y1 = Math.min(tex.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const data = tex.rgba;

  const idx = (px: number, py: number) => (py * tex.width + px) * 4;
  const i00 = idx(x0, y0);
  const i10 = idx(x1, y0);
  const i01 = idx(x0, y1);
  const i11 = idx(x1, y1);

  const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
  const c0r = lerp(data[i00 + 0], data[i10 + 0], tx);
  const c0g = lerp(data[i00 + 1], data[i10 + 1], tx);
  const c0b = lerp(data[i00 + 2], data[i10 + 2], tx);
  const c0a = lerp(data[i00 + 3], data[i10 + 3], tx);
  const c1r = lerp(data[i01 + 0], data[i11 + 0], tx);
  const c1g = lerp(data[i01 + 1], data[i11 + 1], tx);
  const c1b = lerp(data[i01 + 2], data[i11 + 2], tx);
  const c1a = lerp(data[i01 + 3], data[i11 + 3], tx);

  const r = lerp(c0r, c1r, ty) / 255;
  const g = lerp(c0g, c1g, ty) / 255;
  const b = lerp(c0b, c1b, ty) / 255;
  const a = lerp(c0a, c1a, ty) / 255;

  if (texRef.srgb) {
    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), a];
  }
  return [r, g, b, a];
}

function evaluateSurfaceMaterial(scene: SerializedScene, mat: PbrMaterial, uv0: Vec2, uv1: Vec2): PbrMaterial {
  let baseColor = mat.baseColor;
  let emissive = mat.emissive;
  let metallic = mat.metallic;
  let roughness = mat.roughness;

  if (mat.baseColorTexture) {
    const tex = sampleTextureRgba(scene, mat.baseColorTexture, uv0, uv1);
    baseColor = [
      clamp01(baseColor[0] * tex[0]),
      clamp01(baseColor[1] * tex[1]),
      clamp01(baseColor[2] * tex[2])
    ];
  }

  if (mat.metallicRoughnessTexture) {
    const tex = sampleTextureRgba(scene, mat.metallicRoughnessTexture, uv0, uv1);
    roughness = Math.max(MIN_RAYTRACE_ROUGHNESS, clamp01(roughness * tex[1]));
    metallic = clamp01(metallic * tex[2]);
  }

  if (mat.emissiveTexture) {
    const tex = sampleTextureRgba(scene, mat.emissiveTexture, uv0, uv1);
    emissive = [emissive[0] * tex[0], emissive[1] * tex[1], emissive[2] * tex[2]];
  }

  return {
    baseColor,
    emissive,
    metallic,
    roughness,
    emissiveTexture: mat.emissiveTexture,
    normalTexture: mat.normalTexture,
    normalScale: mat.normalScale
  };
}

function buildEmissiveLights(scene: SerializedScene): { lights: EmissiveLight[]; totalWeight: number } {
  const lights: EmissiveLight[] = [];
  let totalWeight = 0;

  for (const obj of scene.objects) {
    if (obj.type === "sphere") {
      const mat = getMaterial(scene, obj.materialId);
      const power = emissivePower(mat);
      if (power <= 1e-5) {
        continue;
      }
      const area = 4 * PI * obj.radius * obj.radius;
      const weight = area * power;
      lights.push({ type: "sphere", sphere: obj, materialId: obj.materialId, area, weight });
      totalWeight += weight;
      continue;
    }
    if (obj.type === "box") {
      const mat = getMaterial(scene, obj.materialId);
      const power = emissivePower(mat);
      if (power <= 1e-5) {
        continue;
      }
      const sx = obj.halfExtents[0] * 2;
      const sy = obj.halfExtents[1] * 2;
      const sz = obj.halfExtents[2] * 2;
      const area = 2 * (sx * sy + sy * sz + sx * sz);
      const weight = area * power;
      lights.push({ type: "box", box: obj, materialId: obj.materialId, area, weight });
      totalWeight += weight;
      continue;
    }
    if (obj.type === "plane") {
      const mat = getMaterial(scene, obj.materialId);
      const power = emissivePower(mat);
      if (power <= 1e-5) {
        continue;
      }
      const area = 400;
      const weight = area * power;
      lights.push({ type: "plane", plane: obj, materialId: obj.materialId, area, weight });
      totalWeight += weight;
      continue;
    }
    if (obj.type === "triangles") {
      const triCount = Math.floor(obj.indices.length / 3);
      const areas: number[] = [];
      const triIndices: number[] = [];
      let totalArea = 0;
      for (let t = 0; t < triCount; t++) {
        const materialId = obj.materialIds?.[t] ?? obj.materialId ?? 0;
        const mat = getMaterial(scene, materialId);
        const power = emissivePower(mat);
        if (power <= 1e-5) {
          continue;
        }
        const i0 = obj.indices[t * 3 + 0] * 3;
        const i1 = obj.indices[t * 3 + 1] * 3;
        const i2 = obj.indices[t * 3 + 2] * 3;
        const a: Vec3 = [obj.positions[i0 + 0], obj.positions[i0 + 1], obj.positions[i0 + 2]];
        const b: Vec3 = [obj.positions[i1 + 0], obj.positions[i1 + 1], obj.positions[i1 + 2]];
        const c: Vec3 = [obj.positions[i2 + 0], obj.positions[i2 + 1], obj.positions[i2 + 2]];
        const n = cross(sub(b, a), sub(c, a));
        const area = 0.5 * Math.hypot(n[0], n[1], n[2]);
        if (area <= 1e-8) {
          continue;
        }
        const weightedArea = area * power;
        totalArea += weightedArea;
        triIndices.push(t);
        areas.push(totalArea);
      }
      if (triIndices.length) {
        const cdf = new Float32Array(areas);
        const triangleIndices = new Uint32Array(triIndices);
        lights.push({ type: "triangles", mesh: obj, triangleIndices, cdf, totalArea, weight: totalArea });
        totalWeight += totalArea;
      }
    }
  }

  return { lights, totalWeight };
}

function randomUnitVector(rng: Rng): Vec3 {
  const z = rng.next() * 2 - 1;
  const a = rng.next() * 2 * PI;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(a), z, r * Math.sin(a)];
}

function sampleEmissiveLight(
  rng: Rng,
  scene: SerializedScene,
  lights: EmissiveLight[],
  totalWeight: number
): EmissiveLightSample | null {
  if (!lights.length || totalWeight <= 1e-8) {
    return null;
  }
  let pick = rng.next() * totalWeight;
  let light = lights[lights.length - 1];
  for (const candidate of lights) {
    pick -= candidate.weight;
    if (pick <= 0) {
      light = candidate;
      break;
    }
  }

  if (light.type === "sphere") {
    const normal = randomUnitVector(rng);
    const position = add(light.sphere.center, mul(normal, light.sphere.radius));
    const mat = getMaterial(scene, light.materialId);
    return { position, normal, emission: mat.emissive, pdf: Math.max(1e-8, emissivePower(mat) / totalWeight) };
  }

  if (light.type === "box") {
    const hx = light.box.halfExtents[0];
    const hy = light.box.halfExtents[1];
    const hz = light.box.halfExtents[2];
    const faceAreas = [4 * hy * hz, 4 * hy * hz, 4 * hx * hz, 4 * hx * hz, 4 * hx * hy, 4 * hx * hy];
    let facePick = rng.next() * light.area;
    let face = 0;
    for (let i = 0; i < faceAreas.length; i++) {
      facePick -= faceAreas[i];
      if (facePick <= 0) {
        face = i;
        break;
      }
    }
    const u = rng.next() * 2 - 1;
    const v = rng.next() * 2 - 1;
    const c = light.box.center;
    let position: Vec3;
    let normal: Vec3;
    switch (face) {
      case 0:
        position = [c[0] + hx, c[1] + u * hy, c[2] + v * hz];
        normal = [1, 0, 0];
        break;
      case 1:
        position = [c[0] - hx, c[1] + u * hy, c[2] + v * hz];
        normal = [-1, 0, 0];
        break;
      case 2:
        position = [c[0] + u * hx, c[1] + hy, c[2] + v * hz];
        normal = [0, 1, 0];
        break;
      case 3:
        position = [c[0] + u * hx, c[1] - hy, c[2] + v * hz];
        normal = [0, -1, 0];
        break;
      case 4:
        position = [c[0] + u * hx, c[1] + v * hy, c[2] + hz];
        normal = [0, 0, 1];
        break;
      default:
        position = [c[0] + u * hx, c[1] + v * hy, c[2] - hz];
        normal = [0, 0, -1];
        break;
    }
    const mat = getMaterial(scene, light.materialId);
    return { position, normal, emission: mat.emissive, pdf: Math.max(1e-8, emissivePower(mat) / totalWeight) };
  }

  if (light.type === "plane") {
    const n = normalize(light.plane.normal);
    const basis = makeOrthoBasis(n);
    const su = rng.next() * 20 - 10;
    const sv = rng.next() * 20 - 10;
    const anchor = mul(n, -light.plane.d);
    const position = add(anchor, add(mul(basis.t, su), mul(basis.b, sv)));
    const mat = getMaterial(scene, light.materialId);
    return { position, normal: n, emission: mat.emissive, pdf: Math.max(1e-8, emissivePower(mat) / totalWeight) };
  }

  const mesh = light.mesh;
  const triPick = rng.next() * light.totalArea;
  let triSlot = 0;
  while (triSlot < light.cdf.length - 1 && triPick > light.cdf[triSlot]) {
    triSlot += 1;
  }
  const triIndex = light.triangleIndices[triSlot];
  const i0 = mesh.indices[triIndex * 3 + 0];
  const i1 = mesh.indices[triIndex * 3 + 1];
  const i2 = mesh.indices[triIndex * 3 + 2];
  const p0: Vec3 = [mesh.positions[i0 * 3 + 0], mesh.positions[i0 * 3 + 1], mesh.positions[i0 * 3 + 2]];
  const p1: Vec3 = [mesh.positions[i1 * 3 + 0], mesh.positions[i1 * 3 + 1], mesh.positions[i1 * 3 + 2]];
  const p2: Vec3 = [mesh.positions[i2 * 3 + 0], mesh.positions[i2 * 3 + 1], mesh.positions[i2 * 3 + 2]];
  const e1 = sub(p1, p0);
  const e2 = sub(p2, p0);
  const face = cross(e1, e2);
  const normal = normalize(face);
  const su = Math.sqrt(rng.next());
  const b0 = 1 - su;
  const b1 = su * (1 - rng.next());
  const b2 = su * rng.next();
  const position: Vec3 = [
    p0[0] * b0 + p1[0] * b1 + p2[0] * b2,
    p0[1] * b0 + p1[1] * b1 + p2[1] * b2,
    p0[2] * b0 + p1[2] * b1 + p2[2] * b2
  ];
  const uv0: Vec2 = mesh.uvs
    ? [
        (mesh.uvs[i0 * 2 + 0] ?? 0) * b0 + (mesh.uvs[i1 * 2 + 0] ?? 0) * b1 + (mesh.uvs[i2 * 2 + 0] ?? 0) * b2,
        (mesh.uvs[i0 * 2 + 1] ?? 0) * b0 + (mesh.uvs[i1 * 2 + 1] ?? 0) * b1 + (mesh.uvs[i2 * 2 + 1] ?? 0) * b2
      ]
    : [0, 0];
  const uv1: Vec2 = mesh.uv2s
    ? [
        (mesh.uv2s[i0 * 2 + 0] ?? uv0[0]) * b0 + (mesh.uv2s[i1 * 2 + 0] ?? uv0[0]) * b1 + (mesh.uv2s[i2 * 2 + 0] ?? uv0[0]) * b2,
        (mesh.uv2s[i0 * 2 + 1] ?? uv0[1]) * b0 + (mesh.uv2s[i1 * 2 + 1] ?? uv0[1]) * b1 + (mesh.uv2s[i2 * 2 + 1] ?? uv0[1]) * b2
      ]
    : uv0;
  const materialId = mesh.materialIds?.[triIndex] ?? mesh.materialId ?? 0;
  const emission = evaluateSurfaceMaterial(scene, getMaterial(scene, materialId), uv0, uv1).emissive;
  return {
    position,
    normal,
    emission,
    pdf: Math.max(1e-8, luminance(emission) / totalWeight)
  };
}

function applyNormalMap(
  scene: SerializedScene,
  mat: PbrMaterial,
  uv0: Vec2,
  uv1: Vec2,
  nGeom: Vec3,
  tangent: Vec3,
  bitangent: Vec3,
  globalNormalStrength: number
): Vec3 {
  const strength = mat.normalScale * globalNormalStrength;
  if (!mat.normalTexture || strength <= 0) {
    return nGeom;
  }
  const tex = sampleTextureRgba(scene, mat.normalTexture, uv0, uv1);
  let tx = tex[0] * 2 - 1;
  let ty = tex[1] * 2 - 1;
  let tz = tex[2] * 2 - 1;
  tx *= strength;
  ty *= strength;
  const tLen = Math.hypot(tx, ty, tz) || 1;
  tx /= tLen;
  ty /= tLen;
  tz /= tLen;

  let n: Vec3 = [
    tangent[0] * tx + bitangent[0] * ty + nGeom[0] * tz,
    tangent[1] * tx + bitangent[1] * ty + nGeom[1] * tz,
    tangent[2] * tx + bitangent[2] * ty + nGeom[2] * tz
  ];
  const nLen = Math.hypot(n[0], n[1], n[2]) || 1;
  n = [n[0] / nLen, n[1] / nLen, n[2] / nLen];
  if (dot(n, nGeom) < 0) {
    n = mul(n, -1);
  }
  return n;
}

function buildGuides(
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  fullWidth: number,
  fullHeight: number,
  camera: RenderCamera,
  scene: SerializedScene,
  triBvh: TriangleBvh | null
): { depth: Float32Array; normal: Float32Array } {
  const depth = new Float32Array(width * height);
  const normal = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ray = makeRay(x + offsetX, y + offsetY, fullWidth, fullHeight, camera);
      const hit = intersectScene(ray, scene, triBvh);
      const i = y * width + x;
      const i3 = i * 3;
      if (!hit) {
        depth[i] = Number.POSITIVE_INFINITY;
        normal[i3 + 0] = 0;
        normal[i3 + 1] = 0;
        normal[i3 + 2] = 0;
        continue;
      }
      depth[i] = hit.t;
      normal[i3 + 0] = hit.normal[0];
      normal[i3 + 1] = hit.normal[1];
      normal[i3 + 2] = hit.normal[2];
    }
  }
  return { depth, normal };
}

function denoiseAtrous(
  color: Float32Array,
  width: number,
  height: number,
  depth: Float32Array,
  normal: Float32Array,
  iterations = 2
): Float32Array {
  const kernel = [1, 4, 6, 4, 1];
  let src = color;
  let dst = new Float32Array(color.length);

  for (let it = 0; it < iterations; it++) {
    const step = 1 << it;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const centerI = y * width + x;
        const centerI3 = centerI * 3;
        const cd = depth[centerI];
        const cnx = normal[centerI3 + 0];
        const cny = normal[centerI3 + 1];
        const cnz = normal[centerI3 + 2];
        const cc0 = src[centerI3 + 0];
        const cc1 = src[centerI3 + 1];
        const cc2 = src[centerI3 + 2];

        let sumW = 0;
        let sum0 = 0;
        let sum1 = 0;
        let sum2 = 0;

        for (let ky = -2; ky <= 2; ky++) {
          const sy = y + ky * step;
          if (sy < 0 || sy >= height) {
            continue;
          }
          for (let kx = -2; kx <= 2; kx++) {
            const sx = x + kx * step;
            if (sx < 0 || sx >= width) {
              continue;
            }

            const i = sy * width + sx;
            const i3 = i * 3;
            const spatial = kernel[Math.abs(kx)] * kernel[Math.abs(ky)];
            const nd = depth[i];
            const nnx = normal[i3 + 0];
            const nny = normal[i3 + 1];
            const nnz = normal[i3 + 2];
            const nc0 = src[i3 + 0];
            const nc1 = src[i3 + 1];
            const nc2 = src[i3 + 2];

            const ndot = Math.max(0, cnx * nnx + cny * nny + cnz * nnz);
            const normalW = Math.pow(ndot, 32);
            const depthScale = Number.isFinite(cd) ? 0.03 * cd + 1e-3 : 1e9;
            const depthW =
              Number.isFinite(cd) && Number.isFinite(nd) ? Math.exp(-Math.abs(nd - cd) / depthScale) : 1;
            const dc0 = nc0 - cc0;
            const dc1 = nc1 - cc1;
            const dc2 = nc2 - cc2;
            const colorDist = Math.sqrt(dc0 * dc0 + dc1 * dc1 + dc2 * dc2);
            const colorW = Math.exp(-colorDist * 8);
            const w = spatial * (0.001 + normalW) * depthW * colorW;

            sumW += w;
            sum0 += nc0 * w;
            sum1 += nc1 * w;
            sum2 += nc2 * w;
          }
        }

        const invW = 1 / Math.max(1e-8, sumW);
        dst[centerI3 + 0] = sum0 * invW;
        dst[centerI3 + 1] = sum1 * invW;
        dst[centerI3 + 2] = sum2 * invW;
      }
    }

    const tmp = src;
    src = dst;
    dst = tmp;
  }

  return src;
}

function suppressFireflies(
  color: Float32Array,
  width: number,
  height: number,
  maxLum: number,
  neighborBoost = FIREFLY_NEIGHBOR_BOOST
): Float32Array {
  const out = new Float32Array(color.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const i3 = i * 3;
      const c: Vec3 = [color[i3 + 0], color[i3 + 1], color[i3 + 2]];
      const cLum = luminance(c);
      let sumLum = 0;
      let sumW = 0;

      for (let ky = -1; ky <= 1; ky++) {
        const sy = y + ky;
        if (sy < 0 || sy >= height) {
          continue;
        }
        for (let kx = -1; kx <= 1; kx++) {
          const sx = x + kx;
          if (sx < 0 || sx >= width) {
            continue;
          }
          const j = (sy * width + sx) * 3;
          const nLum = luminance([color[j + 0], color[j + 1], color[j + 2]]);
          const w = kx === 0 && ky === 0 ? FIREFLY_CENTER_WEIGHT : 1;
          sumLum += nLum * w;
          sumW += w;
        }
      }

      const localLum = sumLum / Math.max(1e-8, sumW);
      const allowedLum = Math.max(maxLum, localLum * neighborBoost);
      const triggerLum = allowedLum * FIREFLY_TRIGGER_RATIO;
      if (cLum > triggerLum && cLum > 1e-8) {
        const s = allowedLum / cLum;
        out[i3 + 0] = c[0] * s;
        out[i3 + 1] = c[1] * s;
        out[i3 + 2] = c[2] * s;
      } else {
        out[i3 + 0] = c[0];
        out[i3 + 1] = c[1];
        out[i3 + 2] = c[2];
      }
    }
  }
  return out;
}

function killExtremeIsolatedSpikes(color: Float32Array, width: number, height: number, strength: number): Float32Array {
  if (strength <= 0) {
    return color;
  }
  const out = new Float32Array(color);
  const lumSamples = new Float32Array(9);
  const colorSamples = new Float32Array(27);
  const spikeRatio = Math.max(2.5, EXTREME_SPIKE_RATIO / Math.max(0.25, strength));
  const neighborLimit = EXTREME_SPIKE_NEIGHBOR_LIMIT / Math.max(0.5, strength);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const i3 = i * 3;
      const center: Vec3 = [color[i3 + 0], color[i3 + 1], color[i3 + 2]];
      const centerLum = luminance(center);
      if (centerLum <= 0) {
        continue;
      }

      let sampleCount = 0;
      let brightNeighbors = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const j = ((y + ky) * width + (x + kx)) * 3;
          const sr = color[j + 0];
          const sg = color[j + 1];
          const sb = color[j + 2];
          const lum = luminance([sr, sg, sb]);
          lumSamples[sampleCount] = lum;
          colorSamples[sampleCount * 3 + 0] = sr;
          colorSamples[sampleCount * 3 + 1] = sg;
          colorSamples[sampleCount * 3 + 2] = sb;
          if (!(kx === 0 && ky === 0) && lum > centerLum / neighborLimit) {
            brightNeighbors += 1;
          }
          sampleCount += 1;
        }
      }

      if (brightNeighbors > 1) {
        continue;
      }

      const sortedLum = Array.from(lumSamples).sort((a, b) => a - b);
      const medianLum = sortedLum[4];
      if (centerLum <= Math.max(1e-6, medianLum * spikeRatio)) {
        continue;
      }

      const targetLum = sortedLum[5];
      let bestIndex = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let s = 0; s < sampleCount; s++) {
        const dist = Math.abs(lumSamples[s] - targetLum);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = s;
        }
      }

      out[i3 + 0] = colorSamples[bestIndex * 3 + 0];
      out[i3 + 1] = colorSamples[bestIndex * 3 + 1];
      out[i3 + 2] = colorSamples[bestIndex * 3 + 2];
    }
  }

  return out;
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function sobol1D(index: number, scramble: number): number {
  let x = scramble >>> 0;
  let i = index >>> 0;
  let v = 0x80000000;
  while (i !== 0) {
    if ((i & 1) !== 0) {
      x ^= v;
    }
    i >>>= 1;
    v >>>= 1;
  }
  return (x >>> 0) / 4294967296;
}

function radicalInverseBase3(n: number): number {
  let x = 0;
  let inv = 1 / 3;
  let m = n;
  while (m > 0) {
    const d = m % 3;
    x += d * inv;
    m = Math.floor(m / 3);
    inv /= 3;
  }
  return x;
}

function stratifiedSobolJitter(
  px: number,
  py: number,
  sample: number,
  spp: number,
  jobId: number
): { jx: number; jy: number } {
  const grid = Math.max(1, Math.ceil(Math.sqrt(spp)));
  const sx = sample % grid;
  const sy = Math.floor(sample / grid);
  const scrambleX = hash4(px, py, jobId, 0x9e3779b9);
  const scrambleY = hash4(px, py, jobId, 0x7f4a7c15);
  const rotX = (hash4(jobId, 0x1f123bb5, 0x91e10da5, 0x6a09e667) >>> 0) / 4294967296;
  const rotY = (hash4(jobId, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a) >>> 0) / 4294967296;
  const qx = sobol1D(sample + 1, scrambleX);
  const qy = fract(radicalInverseBase3(sample + 1) + (scrambleY >>> 0) / 4294967296);
  const u = fract((sx + qx) / grid + rotX);
  const v = fract((sy + qy) / grid + rotY);
  return { jx: u - 0.5, jy: v - 0.5 };
}

function makeOrthoBasis(n: Vec3): { t: Vec3; b: Vec3 } {
  const helper: Vec3 = Math.abs(n[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
  const t = normalize([
    n[1] * helper[2] - n[2] * helper[1],
    n[2] * helper[0] - n[0] * helper[2],
    n[0] * helper[1] - n[1] * helper[0]
  ]);
  const b = normalize([
    n[1] * t[2] - n[2] * t[1],
    n[2] * t[0] - n[0] * t[2],
    n[0] * t[1] - n[1] * t[0]
  ]);
  return { t, b };
}

function toWorld(local: Vec3, n: Vec3): Vec3 {
  const { t, b } = makeOrthoBasis(n);
  return safeNormalize([
    t[0] * local[0] + n[0] * local[1] + b[0] * local[2],
    t[1] * local[0] + n[1] * local[1] + b[1] * local[2],
    t[2] * local[0] + n[2] * local[1] + b[2] * local[2]
  ]);
}

function sampleCosineHemisphere(rng: Rng): Vec3 {
  const u1 = rng.next();
  const u2 = rng.next();
  const r = Math.sqrt(u1);
  const phi = 2 * PI * u2;
  const x = r * Math.cos(phi);
  const z = r * Math.sin(phi);
  const y = Math.sqrt(Math.max(0, 1 - u1));
  return [x, y, z];
}

function sampleGGXHalfVector(rng: Rng, roughness: number): Vec3 {
  const a = roughness * roughness;
  const a2 = a * a;
  const u1 = rng.next();
  const u2 = rng.next();
  const phi = 2 * PI * u1;
  const cosTheta = Math.sqrt((1 - u2) / (1 + (a2 - 1) * u2));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  return [sinTheta * Math.cos(phi), cosTheta, sinTheta * Math.sin(phi)];
}

function ggxD(noH: number, roughness: number): number {
  const a = roughness * roughness;
  const a2 = a * a;
  const d = noH * noH * (a2 - 1) + 1;
  return a2 / (PI * d * d + 1e-8);
}

function ggxG1(noX: number, roughness: number): number {
  const r = roughness + 1;
  const k = (r * r) / 8;
  return noX / (noX * (1 - k) + k + 1e-8);
}

function fresnelSchlick(cosTheta: number, f0: Vec3): Vec3 {
  const p = Math.pow(Math.max(0, 1 - cosTheta), 5);
  return [f0[0] + (1 - f0[0]) * p, f0[1] + (1 - f0[1]) * p, f0[2] + (1 - f0[2]) * p];
}

function evaluatePbrBrdf(mat: PbrMaterial, n: Vec3, wo: Vec3, wi: Vec3): Vec3 {
  const noV = Math.max(0, dot(n, wo));
  const noL = Math.max(0, dot(n, wi));
  if (noV <= 0 || noL <= 0) {
    return [0, 0, 0];
  }
  const h = safeNormalize(add(wo, wi));
  const noH = Math.max(0, dot(n, h));
  const voH = Math.max(0, dot(wo, h));

  const f0 = mix([0.04, 0.04, 0.04], mat.baseColor, mat.metallic);
  const F = fresnelSchlick(voH, f0);
  const D = ggxD(noH, mat.roughness);
  const G = ggxG1(noV, mat.roughness) * ggxG1(noL, mat.roughness);
  const specScale = (D * G) / Math.max(1e-6, 4 * noV * noL);
  const spec: Vec3 = [F[0] * specScale, F[1] * specScale, F[2] * specScale];
  const kd = mulVec(oneMinus(F), mul([1, 1, 1], 1 - mat.metallic));
  const diff = mul(kd, 1 / PI);
  const diffuse = mulVec(diff, mat.baseColor);
  return add(diffuse, spec);
}

function pdfDiffuse(noL: number): number {
  return Math.max(1e-8, noL / PI);
}

function pdfSpec(mat: PbrMaterial, n: Vec3, wo: Vec3, wi: Vec3): number {
  const h = safeNormalize(add(wo, wi));
  const noH = Math.max(0, dot(n, h));
  const voH = Math.max(0, dot(wo, h));
  if (noH <= 0 || voH <= 0) {
    return 0;
  }
  const D = ggxD(noH, mat.roughness);
  return Math.max(1e-8, (D * noH) / (4 * voH));
}

function chooseSpecProb(mat: PbrMaterial): number {
  const f0 = mix([0.04, 0.04, 0.04], mat.baseColor, mat.metallic);
  const base = luminance(f0);
  const gloss = 1 - mat.roughness;
  return Math.max(0.1, Math.min(0.9, 0.2 + 0.6 * base + 0.2 * gloss));
}

function makeRay(x: number, y: number, width: number, height: number, camera: RenderCamera): Ray {
  const forward = normalize(sub(camera.target, camera.pos));
  const right = normalize([
    forward[1] * camera.up[2] - forward[2] * camera.up[1],
    forward[2] * camera.up[0] - forward[0] * camera.up[2],
    forward[0] * camera.up[1] - forward[1] * camera.up[0]
  ]);
  const up = normalize([
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0]
  ]);
  const aspect = width / height;
  const scale = Math.tan((camera.fovY * PI) / 360);
  const px = (2 * ((x + 0.5) / width) - 1) * aspect * scale;
  const py = (1 - 2 * ((y + 0.5) / height)) * scale;
  const dir = normalize(add(add(forward, mul(right, px)), mul(up, py)));
  return { o: camera.pos, d: dir };
}

function tracePath(
  ray: Ray,
  scene: SerializedScene,
  triBvh: TriangleBvh | null,
  emissiveLights: EmissiveLight[],
  emissiveLightWeight: number,
  rng: Rng,
  maxBounces: number,
  lightIntensity: number,
  shadowDarkness: number,
  maxSampleLuminance: number,
  specularSpikeClamp: number,
  globalNormalStrength: number
): Vec3 {
  let ro = ray.o;
  let rd = ray.d;
  let throughput: Vec3 = [1, 1, 1];
  let radiance: Vec3 = [0, 0, 0];
  const li = Math.max(0, lightIntensity);
  const bounces = Math.max(1, maxBounces);
  const maxThroughputLuminance = Math.max(2, Math.min(MAX_THROUGHPUT, Math.sqrt(maxSampleLuminance) * 1.2));

  for (let bounce = 0; bounce < bounces; bounce++) {
    const hit = intersectScene({ o: ro, d: rd }, scene, triBvh);
    if (!hit) {
      radiance = add(
        radiance,
        clampSecondaryContribution(mulVec(throughput, skyColor), bounce, specularSpikeClamp, maxSampleLuminance)
      );
      break;
    }

    const baseMat = getMaterial(scene, hit.materialId);
    const mat = evaluateSurfaceMaterial(scene, baseMat, hit.uv0, hit.uv1);
    const ng = hit.geomNormal;
    const nTex = applyNormalMap(scene, mat, hit.uv0, hit.uv1, hit.normal, hit.tangent, hit.bitangent, globalNormalStrength);
    const n = dot(nTex, ng) > 0 ? nTex : ng;
    const wo = mul(rd, -1);
    const shadowOrigin = add(hit.p, mul(ng, SHADOW_BIAS));

    if (mat.emissive[0] > 0 || mat.emissive[1] > 0 || mat.emissive[2] > 0) {
      radiance = add(
        radiance,
        clampSecondaryContribution(mulVec(throughput, mat.emissive), bounce, specularSpikeClamp, maxSampleLuminance)
      );
    }

    for (let lightSampleIndex = 0; lightSampleIndex < EMISSIVE_DIRECT_SAMPLES; lightSampleIndex++) {
      const emissiveSample = sampleEmissiveLight(rng, scene, emissiveLights, emissiveLightWeight);
      if (emissiveSample) {
        const toLight = sub(emissiveSample.position, hit.p);
        const dist2 = dot(toLight, toLight);
        if (dist2 > 1e-6) {
          const dist = Math.sqrt(dist2);
          const wiLight = mul(toLight, 1 / dist);
          const noLDirect = Math.max(0, dot(n, wiLight));
          const lightNoL = Math.max(0, dot(emissiveSample.normal, mul(wiLight, -1)));
          if (noLDirect > 0 && lightNoL > 0 && !isOccluded(shadowOrigin, wiLight, scene, triBvh, dist - SHADOW_BIAS * 2)) {
            const brdfE = evaluatePbrBrdf(mat, n, wo, wiLight);
            const geom =
              Math.min(
                EMISSIVE_DIRECT_MAX_GEOM,
                (noLDirect * lightNoL) / Math.max(1e-6, dist2 * emissiveSample.pdf * EMISSIVE_DIRECT_SAMPLES)
              );
            radiance = add(
              radiance,
              clampEmissiveDirectContribution(
                mulScalar(throughput, mulVec(brdfE, emissiveSample.emission), geom),
                specularSpikeClamp,
                maxSampleLuminance
              )
            );
          }
        }
      }
    }

    const visible = !isOccluded(shadowOrigin, lightDir, scene, triBvh);
    const shadowAtten = visible ? 1 : 1 - shadowDarkness;
    if (shadowAtten > 0) {
      const noL = Math.max(0, dot(n, lightDir));
      if (noL > 0) {
        const brdfL = evaluatePbrBrdf(mat, n, wo, lightDir);
        radiance = add(
          radiance,
          clampSecondaryContribution(
            mulVec(throughput, mul(brdfL, noL * li * shadowAtten)),
            bounce,
            specularSpikeClamp,
            maxSampleLuminance
          )
        );
      }
    }
    if (!visible) {
      radiance = add(
        radiance,
        clampSecondaryContribution(
          mulVec(throughput, mul(mat.baseColor, ambient * (1 - mat.metallic))),
          bounce,
          specularSpikeClamp,
          maxSampleLuminance
        )
      );
    }

    const specProb = chooseSpecProb(mat);
    let wi: Vec3;
    if (rng.next() < specProb) {
      const hLocal = sampleGGXHalfVector(rng, mat.roughness);
      const h = toWorld(hLocal, n);
      wi = safeNormalize(sub(mul(h, 2 * dot(wo, h)), wo));
      if (dot(n, wi) <= 0) {
        wi = toWorld(sampleCosineHemisphere(rng), n);
      }
    } else {
      wi = toWorld(sampleCosineHemisphere(rng), n);
    }

    const noL = Math.max(0, dot(n, wi));
    const noV = Math.max(0, dot(n, wo));
    if (noL <= 0 || noV <= 0) {
      break;
    }

    const brdf = evaluatePbrBrdf(mat, n, wo, wi);
    const pdfMix = specProb * pdfSpec(mat, n, wo, wi) + (1 - specProb) * pdfDiffuse(noL);
    const weight = noL / Math.max(1e-3, pdfMix);
    throughput = mulVec(throughput, mul(brdf, weight));
    if (bounce >= 1) {
      throughput = clampLuminance(throughput, specularSpikeClamp);
    }
    throughput = clampThroughput(throughput, maxThroughputLuminance);

    if (bounce >= 3) {
      const p = Math.max(0.1, Math.min(0.95, luminance(throughput)));
      if (rng.next() > p) {
        break;
      }
      throughput = mul(throughput, 1 / p);
    }

    ro = add(hit.p, mul(ng, SHADOW_BIAS));
    rd = wi;
  }

  return clampLuminance(radiance, maxSampleLuminance);
}

export function renderScene(settings: RenderSettings): Uint8ClampedArray {
  const { width, height, spp, scene, camera, shouldCancel, onProgress, maxBounces } = settings;
  const offsetX = Math.max(0, settings.offsetX ?? 0);
  const offsetY = Math.max(0, settings.offsetY ?? 0);
  const regionWidth = Math.max(1, settings.regionWidth ?? width);
  const regionHeight = Math.max(1, settings.regionHeight ?? height);
  const lightIntensity = settings.lightIntensity ?? 1;
  const shadowDarkness = Math.max(0, Math.min(1, settings.shadowDarkness ?? 1));
  const maxSampleLuminance = Math.max(1, settings.fireflyClamp ?? DEFAULT_MAX_SAMPLE_LUMINANCE);
  const fireflySuppression = Math.max(1, Math.min(6, settings.fireflySuppression ?? FIREFLY_NEIGHBOR_BOOST));
  const specularSpikeClamp = Math.max(1, Math.min(12, settings.specularSpikeClamp ?? 4.5));
  const extremeSpikeKill = Math.max(0, Math.min(2, settings.extremeSpikeKill ?? 1));
  const normalStrength = Math.max(0, Math.min(2, settings.normalStrength ?? 1));
  // UI semantics: higher slider value => stronger suppression.
  // Convert to neighbor boost: lower boost means stricter outlier clamp.
  const neighborBoost = 6.5 - fireflySuppression * 0.8;
  const tileSize = Math.max(8, settings.tileSize ?? 32);
  const partialInterval = Math.max(1, settings.partialInterval ?? 4);
  const accum = new Float32Array(regionWidth * regionHeight * 3);
  const triMeshes = scene.objects.filter((o): o is TriangleMesh => o.type === "triangles");
  const triBvh = triMeshes.length ? new TriangleBvh(triMeshes) : null;
  const { lights: emissiveLights, totalWeight: emissiveLightWeight } = buildEmissiveLights(scene);

  for (let sample = 0; sample < spp; sample++) {
    const emitTiles = settings.onTile && (sample === 0 || sample === spp - 1 || (sample + 1) % partialInterval === 0);
    for (let ty = 0; ty < regionHeight; ty += tileSize) {
      for (let tx = 0; tx < regionWidth; tx += tileSize) {
        if (shouldCancel()) {
          throw new Error("cancelled");
        }
        const tw = Math.min(tileSize, regionWidth - tx);
        const th = Math.min(tileSize, regionHeight - ty);
        for (let y = ty; y < ty + th; y++) {
          for (let x = tx; x < tx + tw; x++) {
            const globalX = x + offsetX;
            const globalY = y + offsetY;
            const seed = hash4(globalX, globalY, sample, settings.jobId);
            const rng = new Rng(seed);
            const { jx, jy } = stratifiedSobolJitter(globalX, globalY, sample, spp, settings.jobId);
            const ray = makeRay(globalX + jx, globalY + jy, width, height, camera);
            const color = tracePath(
              ray,
              scene,
              triBvh,
              emissiveLights,
              emissiveLightWeight,
              rng,
              maxBounces,
              lightIntensity,
              shadowDarkness,
              maxSampleLuminance,
              specularSpikeClamp,
              normalStrength
            );
            const i3 = (y * regionWidth + x) * 3;
            accum[i3 + 0] += color[0];
            accum[i3 + 1] += color[1];
            accum[i3 + 2] += color[2];
          }
        }
        if (emitTiles) {
          const tile = new Uint8ClampedArray(tw * th * 4);
          const inv = 1 / (sample + 1);
          let p = 0;
          for (let y = ty; y < ty + th; y++) {
            for (let x = tx; x < tx + tw; x++) {
              const i3 = (y * regionWidth + x) * 3;
              tile[p + 0] = toSrgb8(accum[i3 + 0] * inv);
              tile[p + 1] = toSrgb8(accum[i3 + 1] * inv);
              tile[p + 2] = toSrgb8(accum[i3 + 2] * inv);
              tile[p + 3] = 255;
              p += 4;
            }
          }
          settings.onTile?.(tx + offsetX, ty + offsetY, tw, th, tile);
        }
      }
    }
    onProgress?.(sample + 1, spp);
  }

  const rgba = new Uint8ClampedArray(regionWidth * regionHeight * 4);
  const invSpp = 1 / Math.max(1, spp);
  const linear = new Float32Array(accum.length);
  for (let i = 0; i < accum.length; i++) {
    linear[i] = accum[i] * invSpp;
  }
  const deFireflied = suppressFireflies(linear, regionWidth, regionHeight, maxSampleLuminance, neighborBoost);
  const guides = buildGuides(regionWidth, regionHeight, offsetX, offsetY, width, height, camera, scene, triBvh);
  const denoised = denoiseAtrous(deFireflied, regionWidth, regionHeight, guides.depth, guides.normal, 2);
  const deSpiked = killExtremeIsolatedSpikes(denoised, regionWidth, regionHeight, extremeSpikeKill);

  for (let i = 0, p = 0; i < deSpiked.length; i += 3, p += 4) {
    rgba[p + 0] = toSrgb8(deSpiked[i + 0]);
    rgba[p + 1] = toSrgb8(deSpiked[i + 1]);
    rgba[p + 2] = toSrgb8(deSpiked[i + 2]);
    rgba[p + 3] = 255;
  }
  return rgba;
}
