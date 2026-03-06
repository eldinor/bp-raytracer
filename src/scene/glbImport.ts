import {
  BaseTexture,
  Material,
  Matrix,
  Mesh,
  MultiMaterial,
  PBRMaterial,
  PBRMetallicRoughnessMaterial,
  StandardMaterial,
  Texture,
  Vector3,
  VertexBuffer,
  type AbstractMesh
} from "@babylonjs/core";
import type { DiffuseMaterial, MaterialTextureRef, SceneTexture, SerializedScene, TriangleMesh, Vec3 } from "./types";

type GlbImportOptions = {
  mapMaterials?: boolean;
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function vec3FromColor(color: { r: number; g: number; b: number } | null | undefined, fallback: Vec3): Vec3 {
  if (!color) {
    return fallback;
  }
  return [clamp01(color.r), clamp01(color.g), clamp01(color.b)];
}

function toUvTransform(m: Matrix): [number, number, number, number, number, number] {
  const mm = m.m;
  return [mm[0], mm[4], mm[12], mm[1], mm[5], mm[13]];
}

function toUint8Rgba(src: ArrayBufferView, pixelCount: number): Uint8Array {
  const needed = pixelCount * 4;
  if (src instanceof Uint8Array) {
    if (src.length >= needed) {
      return new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + needed));
    }
    const out = new Uint8Array(needed);
    out.set(src.subarray(0, Math.min(src.length, needed)));
    return out;
  }
  if (src instanceof Uint8ClampedArray) {
    return new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + Math.min(src.byteLength, needed)));
  }
  if (src instanceof Float32Array) {
    const out = new Uint8Array(needed);
    for (let i = 0; i < needed; i++) {
      out[i] = Math.max(0, Math.min(255, Math.round(src[i] * 255)));
    }
    return out;
  }
  const bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  if (bytes.length >= needed) {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + needed));
  }
  const out = new Uint8Array(needed);
  out.set(bytes.subarray(0, bytes.length));
  return out;
}

async function buildTextureEntry(
  tex: BaseTexture,
  sceneTextures: SceneTexture[],
  textureMap: Map<number, number>
): Promise<number | null> {
  const key = tex.uniqueId;
  const cached = textureMap.get(key);
  if (cached != null) {
    return cached;
  }

  const maybeTexture = tex as Texture & { readPixels?: () => Promise<ArrayBufferView | null> };
  if (typeof maybeTexture.readPixels !== "function") {
    return null;
  }

  const size = tex.getSize();
  const width = Math.max(1, size.width | 0);
  const height = Math.max(1, size.height | 0);
  let raw: ArrayBufferView | null = null;
  try {
    raw = await maybeTexture.readPixels();
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }

  const rgba = toUint8Rgba(raw, width * height);
  const id = sceneTextures.length;
  sceneTextures.push({ width, height, rgba });
  textureMap.set(key, id);
  return id;
}

async function buildTextureRef(
  tex: BaseTexture | null | undefined,
  srgb: boolean,
  sceneTextures: SceneTexture[],
  textureMap: Map<number, number>
): Promise<MaterialTextureRef | undefined> {
  if (!tex) {
    return undefined;
  }
  const textureId = await buildTextureEntry(tex, sceneTextures, textureMap);
  if (textureId == null) {
    return undefined;
  }
  const uvIndex = ((tex.coordinatesIndex ?? 0) | 0) === 1 ? 1 : 0;
  return {
    textureId,
    texCoord: uvIndex,
    wrapU: tex.wrapU ?? Texture.WRAP_ADDRESSMODE,
    wrapV: tex.wrapV ?? Texture.WRAP_ADDRESSMODE,
    transform: toUvTransform(tex.getTextureMatrix()),
    srgb
  };
}

async function buildSceneMaterial(
  mat: Material | null | undefined,
  sceneTextures: SceneTexture[],
  textureMap: Map<number, number>
): Promise<DiffuseMaterial> {
  if (mat instanceof PBRMetallicRoughnessMaterial) {
    return {
      baseColor: vec3FromColor(mat.baseColor, [1, 1, 1]),
      metallic: clamp01(mat.metallic ?? 1),
      roughness: Math.max(0.04, clamp01(mat.roughness ?? 1)),
      baseColorTexture: await buildTextureRef(mat.baseTexture, true, sceneTextures, textureMap),
      metallicRoughnessTexture: await buildTextureRef(mat.metallicRoughnessTexture, false, sceneTextures, textureMap)
    };
  }

  if (mat instanceof PBRMaterial) {
    return {
      baseColor: vec3FromColor(mat.albedoColor, [1, 1, 1]),
      metallic: clamp01(mat.metallic ?? 1),
      roughness: Math.max(0.04, clamp01(mat.roughness ?? 1)),
      baseColorTexture: await buildTextureRef(mat.albedoTexture, true, sceneTextures, textureMap),
      metallicRoughnessTexture: await buildTextureRef(mat.metallicTexture, false, sceneTextures, textureMap)
    };
  }

  if (mat instanceof StandardMaterial) {
    return {
      baseColor: vec3FromColor(mat.diffuseColor, [0.8, 0.8, 0.8]),
      metallic: 0,
      roughness: 0.8,
      baseColorTexture: await buildTextureRef(mat.diffuseTexture, true, sceneTextures, textureMap)
    };
  }

  return { baseColor: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.7 };
}

async function meshToTriangles(
  mesh: Mesh,
  getMaterialId: (mat: Material | null | undefined) => Promise<number>,
  sharedMaterialId: number | null
): Promise<TriangleMesh | null> {
  const positionsRaw = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indicesRaw = mesh.getIndices();
  if (!positionsRaw || !indicesRaw || indicesRaw.length < 3 || positionsRaw.length < 3) {
    return null;
  }

  mesh.computeWorldMatrix(true);
  const world = mesh.getWorldMatrix();
  const outPositions = new Float32Array(positionsRaw.length);
  const tmp = new Vector3();
  for (let i = 0; i < positionsRaw.length; i += 3) {
    Vector3.TransformCoordinatesFromFloatsToRef(
      positionsRaw[i + 0],
      positionsRaw[i + 1],
      positionsRaw[i + 2],
      world,
      tmp
    );
    outPositions[i + 0] = tmp.x;
    outPositions[i + 1] = tmp.y;
    outPositions[i + 2] = tmp.z;
  }

  const indices = new Uint32Array(indicesRaw.length);
  for (let i = 0; i < indicesRaw.length; i++) {
    indices[i] = indicesRaw[i];
  }

  const uv0Raw = mesh.getVerticesData(VertexBuffer.UVKind);
  const uv1Raw = mesh.getVerticesData(VertexBuffer.UV2Kind);
  const uvs = uv0Raw && uv0Raw.length >= (positionsRaw.length / 3) * 2 ? new Float32Array(uv0Raw) : undefined;
  const uv2s = uv1Raw && uv1Raw.length >= (positionsRaw.length / 3) * 2 ? new Float32Array(uv1Raw) : undefined;

  const triCount = Math.floor(indices.length / 3);
  if (sharedMaterialId != null) {
    return {
      type: "triangles",
      positions: outPositions,
      indices,
      uvs,
      uv2s,
      materialId: sharedMaterialId
    };
  }

  const subMeshes = mesh.subMeshes ?? [];
  if (!subMeshes.length || !(mesh.material instanceof MultiMaterial)) {
    const matId = await getMaterialId(mesh.material);
    return {
      type: "triangles",
      positions: outPositions,
      indices,
      uvs,
      uv2s,
      materialId: matId
    };
  }

  const materialIds = new Uint16Array(triCount);
  const defaultId = await getMaterialId(mesh.material);
  materialIds.fill(defaultId);

  const multi = mesh.material as MultiMaterial;
  for (const sm of subMeshes) {
    const subMat = multi.getSubMaterial(sm.materialIndex);
    const matId = await getMaterialId(subMat);
    const triStart = Math.max(0, Math.floor(sm.indexStart / 3));
    const triEnd = Math.min(triCount, Math.ceil((sm.indexStart + sm.indexCount) / 3));
    for (let t = triStart; t < triEnd; t++) {
      materialIds[t] = matId;
    }
  }

  return {
    type: "triangles",
    positions: outPositions,
    indices,
    uvs,
    uv2s,
    materialIds
  };
}

export async function importGlbIntoScene(
  importedMeshes: AbstractMesh[],
  current: SerializedScene,
  options?: GlbImportOptions
): Promise<SerializedScene> {
  const mapMaterials = options?.mapMaterials ?? true;
  const sceneTextures: SceneTexture[] = [...(current.textures ?? [])];
  const textureMap = new Map<number, number>();
  const sceneMaterials: DiffuseMaterial[] = [...current.materials];
  const materialMap = new Map<number, number>();
  const defaultMaterialId = sceneMaterials.length;
  const defaultMaterial: DiffuseMaterial = { baseColor: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.7 };

  if (!mapMaterials) {
    sceneMaterials.push(defaultMaterial);
  }

  const getMaterialId = async (mat: Material | null | undefined): Promise<number> => {
    if (!mapMaterials) {
      return defaultMaterialId;
    }
    if (!mat) {
      return defaultMaterialId;
    }
    const cached = materialMap.get(mat.uniqueId);
    if (cached != null) {
      return cached;
    }
    const id = sceneMaterials.length;
    sceneMaterials.push(await buildSceneMaterial(mat, sceneTextures, textureMap));
    materialMap.set(mat.uniqueId, id);
    return id;
  };

  if (mapMaterials) {
    sceneMaterials.push(defaultMaterial);
  }

  const sharedMaterialId = mapMaterials ? null : defaultMaterialId;
  const objects: TriangleMesh[] = [];
  for (const abs of importedMeshes) {
    if (!(abs instanceof Mesh)) {
      continue;
    }
    const tri = await meshToTriangles(abs, getMaterialId, sharedMaterialId);
    if (tri) {
      if (tri.materialId == null && !tri.materialIds) {
        tri.materialId = defaultMaterialId;
      }
      objects.push(tri);
    }
  }

  if (!objects.length) {
    throw new Error("No supported mesh primitives found in GLB");
  }

  return {
    materials: sceneMaterials,
    textures: sceneTextures,
    objects: [...current.objects, ...objects]
  };
}
