import type { SerializedScene, TriangleMesh, Vec3 } from "./types";

type GlbChunk = { type: number; data: Uint8Array };

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function toVec3(arr: ArrayLike<number>, offset = 0): Vec3 {
  return [arr[offset], arr[offset + 1], arr[offset + 2]];
}

function readAccessor(
  gltf: any,
  accessorIndex: number,
  bin: Uint8Array
): ArrayBufferView {
  const accessor = gltf.accessors[accessorIndex];
  const bufferView = gltf.bufferViews[accessor.bufferView];
  const compType = accessor.componentType;
  const count = accessor.count;
  const type = accessor.type;
  const elemsPerType =
    type === "SCALAR"
      ? 1
      : type === "VEC2"
      ? 2
      : type === "VEC3"
      ? 3
      : type === "VEC4"
      ? 4
      : 1;
  const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const byteLength = count * elemsPerType;
  const start = bin.byteOffset + byteOffset;
  const stride = bufferView.byteStride ?? 0;

  if (stride && stride !== elemsPerType * (compType === 5126 ? 4 : 2)) {
    throw new Error("Unsupported interleaved accessor layout");
  }

  if (compType === 5126) {
    return new Float32Array(bin.buffer, start, byteLength);
  }
  if (compType === 5125) {
    return new Uint32Array(bin.buffer, start, byteLength);
  }
  if (compType === 5123) {
    return new Uint16Array(bin.buffer, start, byteLength);
  }
  throw new Error(`Unsupported accessor component type: ${compType}`);
}

function parseChunks(buffer: ArrayBuffer): GlbChunk[] {
  const dv = new DataView(buffer);
  const magic = dv.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new Error("File is not a valid GLB");
  }
  const version = dv.getUint32(4, true);
  if (version !== 2) {
    throw new Error(`Unsupported GLB version: ${version}`);
  }
  const length = dv.getUint32(8, true);
  if (length !== buffer.byteLength) {
    throw new Error("GLB length mismatch");
  }
  const chunks: GlbChunk[] = [];
  let offset = 12;
  while (offset < length) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    chunks.push({ type: chunkType, data: new Uint8Array(buffer, dataStart, chunkLength) });
    offset = dataEnd;
  }
  return chunks;
}

function multiplyMat4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function composeNodeWorldMatrix(node: any, parent?: number[]): number[] {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    const local = node.matrix.map((v: unknown) => Number(v));
    return parent ? multiplyMat4(parent, local) : local;
  }

  const t = node.translation ?? [0, 0, 0];
  const s = node.scale ?? [1, 1, 1];
  const r = node.rotation ?? [0, 0, 0, 1];

  const [x, y, z, w] = r;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  const m = [
    (1 - 2 * (yy + zz)) * s[0],
    (2 * (xy + wz)) * s[0],
    (2 * (xz - wy)) * s[0],
    0,
    (2 * (xy - wz)) * s[1],
    (1 - 2 * (xx + zz)) * s[1],
    (2 * (yz + wx)) * s[1],
    0,
    (2 * (xz + wy)) * s[2],
    (2 * (yz - wx)) * s[2],
    (1 - 2 * (xx + yy)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1
  ];

  if (!parent) {
    return m;
  }
  return multiplyMat4(parent, m);
}

function transformPoint(m: number[], p: Vec3): Vec3 {
  return [
    p[0] * m[0] + p[1] * m[4] + p[2] * m[8] + m[12],
    p[0] * m[1] + p[1] * m[5] + p[2] * m[9] + m[13],
    p[0] * m[2] + p[1] * m[6] + p[2] * m[10] + m[14]
  ];
}

function gatherNodes(gltf: any, sceneIndex: number): number[] {
  const scene = gltf.scenes?.[sceneIndex] ?? gltf.scenes?.[0];
  if (!scene?.nodes?.length) {
    return [];
  }
  return scene.nodes;
}

function glbToTriangles(buffer: ArrayBuffer, materialId: number): TriangleMesh[] {
  const chunks = parseChunks(buffer);
  const jsonChunk = chunks.find((c) => c.type === JSON_CHUNK);
  const binChunk = chunks.find((c) => c.type === BIN_CHUNK);
  if (!jsonChunk || !binChunk) {
    throw new Error("GLB missing JSON or BIN chunk");
  }
  const gltf = JSON.parse(new TextDecoder().decode(jsonChunk.data));
  const roots = gatherNodes(gltf, gltf.scene ?? 0);
  const meshes: TriangleMesh[] = [];

  const walk = (nodeIndex: number, parent?: number[]) => {
    const node = gltf.nodes[nodeIndex];
    if (!node) {
      return;
    }
    const world = composeNodeWorldMatrix(node, parent);
    if (typeof node.mesh === "number") {
      const mesh = gltf.meshes[node.mesh];
      for (const primitive of mesh.primitives ?? []) {
        const positionAccessor = primitive.attributes?.POSITION;
        if (typeof positionAccessor !== "number") {
          continue;
        }
        const positionsRaw = readAccessor(gltf, positionAccessor, binChunk.data);
        if (!(positionsRaw instanceof Float32Array)) {
          continue;
        }
        const indicesAccessor = primitive.indices;
        let indicesRaw: Uint32Array;
        if (typeof indicesAccessor === "number") {
          const idx = readAccessor(gltf, indicesAccessor, binChunk.data);
          if (idx instanceof Uint32Array) {
            indicesRaw = idx;
          } else if (idx instanceof Uint16Array) {
            indicesRaw = new Uint32Array(idx.length);
            for (let i = 0; i < idx.length; i++) {
              indicesRaw[i] = idx[i];
            }
          } else {
            throw new Error("Unsupported GLB index type");
          }
        } else {
          const vc = positionsRaw.length / 3;
          indicesRaw = new Uint32Array(vc);
          for (let i = 0; i < vc; i++) {
            indicesRaw[i] = i;
          }
        }

        const positions = new Float32Array(positionsRaw.length);
        for (let i = 0; i < positionsRaw.length; i += 3) {
          const p = toVec3(positionsRaw, i);
          const tp = transformPoint(world, p);
          positions[i] = tp[0];
          positions[i + 1] = tp[1];
          positions[i + 2] = tp[2];
        }

        meshes.push({
          type: "triangles",
          positions,
          indices: new Uint32Array(indicesRaw),
          materialId
        });
      }
    }
    for (const child of node.children ?? []) {
      walk(child, world);
    }
  };

  for (const root of roots) {
    walk(root);
  }
  return meshes;
}

export async function importGlbIntoScene(
  glbBuffer: ArrayBuffer,
  current: SerializedScene
): Promise<SerializedScene> {
  const importMaterialId = current.materials.length;
  const meshes = glbToTriangles(glbBuffer, importMaterialId);
  if (!meshes.length) {
    throw new Error("No supported mesh primitives found in GLB");
  }
  return {
    materials: [...current.materials, { baseColor: [0.8, 0.8, 0.8], metallic: 0.0, roughness: 0.7 }],
    objects: [...current.objects, ...meshes]
  };
}
