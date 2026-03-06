import type { SerializedScene, TriangleMesh } from "./types";

function createCylinderMesh(
  center: [number, number, number],
  radius: number,
  height: number,
  radialSegments: number,
  materialId: number
): TriangleMesh {
  const [cx, cy, cz] = center;
  const halfHeight = height * 0.5;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= radialSegments; i++) {
    const t = (i / radialSegments) * Math.PI * 2;
    const x = Math.cos(t);
    const z = Math.sin(t);
    positions.push(cx + x * radius, cy - halfHeight, cz + z * radius);
    positions.push(cx + x * radius, cy + halfHeight, cz + z * radius);
    normals.push(x, 0, z);
    normals.push(x, 0, z);
  }

  for (let i = 0; i < radialSegments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c);
    indices.push(c, b, d);
  }

  const bottomCenterIndex = positions.length / 3;
  positions.push(cx, cy - halfHeight, cz);
  normals.push(0, -1, 0);
  const topCenterIndex = positions.length / 3;
  positions.push(cx, cy + halfHeight, cz);
  normals.push(0, 1, 0);

  for (let i = 0; i <= radialSegments; i++) {
    const t = (i / radialSegments) * Math.PI * 2;
    const x = Math.cos(t);
    const z = Math.sin(t);
    positions.push(cx + x * radius, cy - halfHeight, cz + z * radius);
    normals.push(0, -1, 0);
    positions.push(cx + x * radius, cy + halfHeight, cz + z * radius);
    normals.push(0, 1, 0);
  }

  const capStart = topCenterIndex + 1;
  for (let i = 0; i < radialSegments; i++) {
    const bottomA = capStart + i * 2;
    const bottomB = bottomA + 2;
    const topA = bottomA + 1;
    const topB = topA + 2;
    indices.push(bottomCenterIndex, bottomB, bottomA);
    indices.push(topCenterIndex, topA, topB);
  }

  return {
    type: "triangles",
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    materialId,
  };
}

function createTorusMesh(
  center: [number, number, number],
  majorRadius: number,
  minorRadius: number,
  radialSegments: number,
  tubularSegments: number,
  materialId: number
): TriangleMesh {
  const [cx, cy, cz] = center;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= radialSegments; j++) {
    const v = (j / radialSegments) * Math.PI * 2;
    const cosV = Math.cos(v);
    const sinV = Math.sin(v);

    for (let i = 0; i <= tubularSegments; i++) {
      const u = (i / tubularSegments) * Math.PI * 2;
      const cosU = Math.cos(u);
      const sinU = Math.sin(u);

      const ring = majorRadius + minorRadius * cosV;
      const px = cx + ring * cosU;
      const py = cy + minorRadius * sinV;
      const pz = cz + ring * sinU;

      const nx = cosV * cosU;
      const ny = sinV;
      const nz = cosV * sinU;

      positions.push(px, py, pz);
      normals.push(nx, ny, nz);
    }
  }

  for (let j = 0; j < radialSegments; j++) {
    for (let i = 0; i < tubularSegments; i++) {
      const a = j * (tubularSegments + 1) + i;
      const b = a + tubularSegments + 1;
      const c = a + 1;
      const d = b + 1;
      indices.push(a, b, c);
      indices.push(c, b, d);
    }
  }

  return {
    type: "triangles",
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    materialId,
  };
}

export function createDefaultScene(): SerializedScene {
  return {
    materials: [
      { baseColor: [0.9, 0.18, 0.18], metallic: 0.08, roughness: 0.36 },
      { baseColor: [0.18, 0.88, 0.26], metallic: 0.0, roughness: 0.58 },
      { baseColor: [0.18, 0.32, 0.94], metallic: 0.88, roughness: 0.18 },
      { baseColor: [0.9, 0.9, 0.2], emissive: [0.6, 0.5, 0.175], metallic: 0.85, roughness: 0.2 },
      { baseColor: [0.75, 0.75, 0.75], metallic: 0.0, roughness: 0.9 },
      { baseColor: [0.92, 0.9, 0.82], metallic: 1.0, roughness: 0.04 },
      { baseColor: [0.64, 0.79, 0.9], metallic: 1.0, roughness: 0.22 },
      { baseColor: [0.96, 0.52, 0.14], metallic: 0.0, roughness: 0.1 },
      { baseColor: [0.34, 0.38, 0.44], metallic: 0.82, roughness: 0.76 },
      { baseColor: [0.94, 0.36, 0.74], metallic: 1.0, roughness: 0.08 },
      { baseColor: [0.18, 0.88, 0.82], metallic: 1.0, roughness: 0.32 },
    ],
    objects: [
      { type: "plane", normal: [0, 1, 0], d: 0, materialId: 4 },
      { type: "sphere", center: [-5.2, 1, -0.8], radius: 1, materialId: 0 },
      { type: "sphere", center: [-2.1, 1, 1.3], radius: 1, materialId: 1 },
      { type: "sphere", center: [1.2, 1, -1.4], radius: 1, materialId: 2 },
      { type: "sphere", center: [5.2, 0.8, 1.8], radius: 0.8, materialId: 5 },
      { type: "sphere", center: [8.1, 0.9, -0.6], radius: 0.9, materialId: 9 },
      {
        type: "box",
        center: [0, 0.5, -4.6],
        halfExtents: [0.75, 0.5, 0.75],
        materialId: 3,
      },
      {
        type: "box",
        center: [-8, 0.55, 2.6],
        halfExtents: [0.6, 0.55, 0.6],
        materialId: 6,
      },
      {
        type: "box",
        center: [7.1, 0.3, -4.1],
        halfExtents: [1.05, 0.3, 1.05],
        materialId: 7,
      },
      {
        type: "box",
        center: [2.9, 1.3, 4.8],
        halfExtents: [0.42, 1.3, 0.42],
        materialId: 8,
      },
      createCylinderMesh([-8.7, 1.1, -4.8], 0.7, 2.2, 32, 10),
      createTorusMesh([8.8, 1.2, 4.7], 1.1, 0.32, 24, 36, 9),
      createCylinderMesh([4.6, 0.85, 5.6], 0.5, 1.7, 28, 6),
      createTorusMesh([-4.7, 1.05, 4.8], 0.9, 0.22, 20, 30, 10),
    ],
  };
}
