export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type SceneTexture = {
  width: number;
  height: number;
  rgba: Uint8Array;
};

export type MaterialTextureRef = {
  textureId: number;
  texCoord: 0 | 1;
  wrapU: number;
  wrapV: number;
  transform: [number, number, number, number, number, number];
  srgb: boolean;
};

export type DiffuseMaterial = {
  baseColor: Vec3;
  emissive?: Vec3;
  metallic?: number;
  roughness?: number;
  baseColorTexture?: MaterialTextureRef;
  emissiveTexture?: MaterialTextureRef;
  metallicRoughnessTexture?: MaterialTextureRef;
  normalTexture?: MaterialTextureRef;
  normalScale?: number;
};

export type Sphere = {
  type: "sphere";
  center: Vec3;
  radius: number;
  materialId: number;
};

export type Box = {
  type: "box";
  center: Vec3;
  halfExtents: Vec3;
  materialId: number;
};

export type Plane = {
  type: "plane";
  normal: Vec3;
  d: number;
  materialId: number;
};

export type TriangleMesh = {
  type: "triangles";
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
  uv2s?: Float32Array;
  materialIds?: Uint16Array;
  materialId?: number;
};

export type SceneObject = Sphere | Box | Plane | TriangleMesh;

export type SerializedScene = {
  materials: DiffuseMaterial[];
  textures?: SceneTexture[];
  objects: SceneObject[];
};
