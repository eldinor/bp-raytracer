import type { SerializedScene } from "./types";

export function createDefaultScene(): SerializedScene {
  return {
    materials: [
      { baseColor: [0.9, 0.2, 0.2], metallic: 0.1, roughness: 0.35 },
      { baseColor: [0.2, 0.9, 0.2], metallic: 0.0, roughness: 0.6 },
      { baseColor: [0.2, 0.2, 0.9], metallic: 0.85, roughness: 0.2 },
      { baseColor: [0.9, 0.9, 0.2], metallic: 0.85, roughness: 0.2 },
      { baseColor: [0.75, 0.75, 0.75], metallic: 0.0, roughness: 0.9 },
    ],
    objects: [
      { type: "plane", normal: [0, 1, 0], d: 0, materialId: 4 },
      { type: "sphere", center: [-2, 1, 0], radius: 1, materialId: 0 },
      { type: "sphere", center: [0, 1, 1], radius: 1, materialId: 1 },
      { type: "sphere", center: [2, 1, -1], radius: 1, materialId: 2 },
      {
        type: "box",
        center: [0, 0.5, -3],
        halfExtents: [0.75, 0.5, 0.75],
        materialId: 3,
      },
    ],
  };
}
