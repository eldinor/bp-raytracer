import type { Box, Plane, SerializedScene, Sphere, TriangleMesh, Vec3 } from "../scene/types";
import { TriangleBvh, type Hit, type Ray } from "./bvh";
import { EPS, Rng, add, clamp01, dot, hash4, mul, normalize, sub } from "./math";

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
  spp: number;
  maxBounces: number;
  lightIntensity?: number;
  shadowDarkness?: number;
  fireflyClamp?: number;
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
  metallic: number;
  roughness: number;
};

const PI = Math.PI;
const lightDir = normalize([1, 2, 1]);
const skyColor: Vec3 = [0.35, 0.4, 0.5];
const ambient = 0.01;
const SHADOW_BIAS = 1e-2;
const MAX_THROUGHPUT = 8.0;
const DEFAULT_MAX_SAMPLE_LUMINANCE = 12.0;

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

function reflect(i: Vec3, n: Vec3): Vec3 {
  return sub(i, mul(n, 2 * dot(i, n)));
}

function safeNormalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

function getMaterial(scene: SerializedScene, materialId: number): PbrMaterial {
  const m = scene.materials[materialId];
  return {
    baseColor: m?.baseColor ?? [1, 1, 1],
    metallic: Math.max(0, Math.min(1, m?.metallic ?? 0)),
    roughness: Math.max(0.04, Math.min(1, m?.roughness ?? 0.7))
  };
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
  return { t, normal: n, materialId: s.materialId };
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
  return { t, normal: den < 0 ? n : mul(n, -1), materialId: p.materialId };
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
  return { t: tNear, normal: n, materialId: b.materialId };
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

function isOccluded(origin: Vec3, dir: Vec3, scene: SerializedScene, triBvh: TriangleBvh | null): boolean {
  const shadowRay: Ray = { o: origin, d: dir };
  return intersectScene(shadowRay, scene, triBvh, 1e6) !== null;
}

function toSrgb8(x: number): number {
  const g = Math.pow(clamp01(x), 1 / 2.2);
  return Math.round(g * 255);
}

function buildGuides(
  width: number,
  height: number,
  camera: RenderCamera,
  scene: SerializedScene,
  triBvh: TriangleBvh | null
): { depth: Float32Array; normal: Float32Array } {
  const depth = new Float32Array(width * height);
  const normal = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ray = makeRay(x, y, width, height, camera);
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
  rng: Rng,
  maxBounces: number,
  lightIntensity: number,
  shadowDarkness: number,
  maxSampleLuminance: number
): Vec3 {
  let ro = ray.o;
  let rd = ray.d;
  let throughput: Vec3 = [1, 1, 1];
  let radiance: Vec3 = [0, 0, 0];
  const li = Math.max(0, lightIntensity);
  const bounces = Math.max(1, maxBounces);

  for (let bounce = 0; bounce < bounces; bounce++) {
    const hit = intersectScene({ o: ro, d: rd }, scene, triBvh);
    if (!hit) {
      radiance = add(radiance, clampLuminance(mulVec(throughput, skyColor), maxSampleLuminance));
      break;
    }

    const mat = getMaterial(scene, hit.materialId);
    const n = hit.normal;
    const wo = mul(rd, -1);

    const shadowOrigin = add(hit.p, mul(n, SHADOW_BIAS));
    const visible = !isOccluded(shadowOrigin, lightDir, scene, triBvh);
    const shadowAtten = visible ? 1 : 1 - shadowDarkness;
    if (shadowAtten > 0) {
      const noL = Math.max(0, dot(n, lightDir));
      if (noL > 0) {
        const brdfL = evaluatePbrBrdf(mat, n, wo, lightDir);
        radiance = add(
          radiance,
          clampLuminance(mulVec(throughput, mul(brdfL, noL * li * shadowAtten)), maxSampleLuminance)
        );
      }
    }
    if (!visible) {
      radiance = add(
        radiance,
        clampLuminance(mulVec(throughput, mul(mat.baseColor, ambient * (1 - mat.metallic))), maxSampleLuminance)
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
    const weight = noL / Math.max(1e-4, pdfMix);
    throughput = mulVec(throughput, mul(brdf, weight));
    throughput = clampVecMax(throughput, MAX_THROUGHPUT);

    if (bounce >= 3) {
      const p = Math.max(0.1, Math.min(0.95, luminance(throughput)));
      if (rng.next() > p) {
        break;
      }
      throughput = mul(throughput, 1 / p);
    }

    ro = add(hit.p, mul(n, SHADOW_BIAS));
    rd = wi;
  }

  return clampLuminance(radiance, maxSampleLuminance);
}

export function renderScene(settings: RenderSettings): Uint8ClampedArray {
  const { width, height, spp, scene, camera, shouldCancel, onProgress, maxBounces } = settings;
  const lightIntensity = settings.lightIntensity ?? 1;
  const shadowDarkness = Math.max(0, Math.min(1, settings.shadowDarkness ?? 1));
  const maxSampleLuminance = Math.max(1, settings.fireflyClamp ?? DEFAULT_MAX_SAMPLE_LUMINANCE);
  const tileSize = Math.max(8, settings.tileSize ?? 32);
  const partialInterval = Math.max(1, settings.partialInterval ?? 4);
  const accum = new Float32Array(width * height * 3);
  const triMeshes = scene.objects.filter((o): o is TriangleMesh => o.type === "triangles");
  const triBvh = triMeshes.length ? new TriangleBvh(triMeshes) : null;

  for (let sample = 0; sample < spp; sample++) {
    const emitTiles = settings.onTile && (sample === 0 || sample === spp - 1 || (sample + 1) % partialInterval === 0);
    for (let ty = 0; ty < height; ty += tileSize) {
      for (let tx = 0; tx < width; tx += tileSize) {
        if (shouldCancel()) {
          throw new Error("cancelled");
        }
        const tw = Math.min(tileSize, width - tx);
        const th = Math.min(tileSize, height - ty);
        for (let y = ty; y < ty + th; y++) {
          for (let x = tx; x < tx + tw; x++) {
            const seed = hash4(x, y, sample, settings.jobId);
            const rng = new Rng(seed);
            const { jx, jy } = stratifiedSobolJitter(x, y, sample, spp, settings.jobId);
            const ray = makeRay(x + jx, y + jy, width, height, camera);
            const color = tracePath(
              ray,
              scene,
              triBvh,
              rng,
              maxBounces,
              lightIntensity,
              shadowDarkness,
              maxSampleLuminance
            );
            const i3 = (y * width + x) * 3;
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
              const i3 = (y * width + x) * 3;
              tile[p + 0] = toSrgb8(accum[i3 + 0] * inv);
              tile[p + 1] = toSrgb8(accum[i3 + 1] * inv);
              tile[p + 2] = toSrgb8(accum[i3 + 2] * inv);
              tile[p + 3] = 255;
              p += 4;
            }
          }
          settings.onTile?.(tx, ty, tw, th, tile);
        }
      }
    }
    onProgress?.(sample + 1, spp);
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const invSpp = 1 / Math.max(1, spp);
  const linear = new Float32Array(accum.length);
  for (let i = 0; i < accum.length; i++) {
    linear[i] = accum[i] * invSpp;
  }
  const guides = buildGuides(width, height, camera, scene, triBvh);
  const denoised = denoiseAtrous(linear, width, height, guides.depth, guides.normal, 2);

  for (let i = 0, p = 0; i < denoised.length; i += 3, p += 4) {
    rgba[p + 0] = toSrgb8(denoised[i + 0]);
    rgba[p + 1] = toSrgb8(denoised[i + 1]);
    rgba[p + 2] = toSrgb8(denoised[i + 2]);
    rgba[p + 3] = 255;
  }
  return rgba;
}
