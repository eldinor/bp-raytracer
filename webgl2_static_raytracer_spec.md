# WebGL2 Static Ray Tracer (Workers) — Ultra-Clear Implementation Spec

This document is designed to be handed to an AI coding agent.  
Follow it **exactly**. The goal is a **single-shot** (on-demand) ray-traced render in the browser using **WebGL2 for display** and a **Worker for CPU ray tracing**.

---

## 1) Requirements Summary

### Must have
- **WebGL2** app (TypeScript + Vite)
- Default scene on load: **basic primitives** (spheres/box/plane)
- Optional **GLB import** (drag/drop + button)
- Ray tracing does **NOT** run every frame
- User clicks **Render** → worker computes → **one final static result**
- **Cancel** rendering
- **Export PNG** of last result

### Must NOT
- Use WebGPU
- Continuously render / accumulate when idle
- Read pixels from GPU each frame (only upload final pixels to GPU texture)

---

## 2) Project Structure (exact)

```
/index.html
/src/main.ts
/src/ui/controls.ts
/src/ui/state.ts

/src/gl/glDisplay.ts
/src/gl/shaders/fullscreen.vert
/src/gl/shaders/fullscreen.frag

/src/scene/defaultScene.ts
/src/scene/types.ts
/src/scene/glbImport.ts

/src/workers/rayWorker.ts
/src/raytracer/raytracer.ts
/src/raytracer/bvh.ts
/src/raytracer/math.ts

/vite.config.ts
/package.json
/README.md
```

No additional folders.

---

## 3) Runtime Architecture (exact)

### Main thread
- DOM + UI + camera controls
- Creates WebGL2 context
- Sends **scene + camera + settings** to a Worker as a render job
- Receives `rgba` pixels and displays them via WebGL2 fullscreen quad

### Worker
- CPU ray tracing only
- Builds BVH for triangles if needed
- Computes full image at requested resolution and spp
- Sends final pixels back (and optional progress)

### WebGL2
- Only used to display a `RGBA8` texture.
- No ray tracing in shaders for v1.

---

## 4) HTML requirements

`index.html` must contain:

```html
<canvas id="viewport"></canvas>
<div id="ui"></div>
```

---

## 5) Default Initial Scene (required, exact)

On load, build the scene:

- **Plane**: y = 0, normal (0,1,0), size 20 (in ray tracer: infinite plane is fine)
- **Sphere A**: center (-2,1,0), radius 1, color (0.9,0.2,0.2)
- **Sphere B**: center (0,1,1), radius 1, color (0.2,0.9,0.2)
- **Sphere C**: center (2,1,-1), radius 1, color (0.2,0.2,0.9)
- **Box**: center (0,0.5,-3), half-extents (0.75,0.5,0.75), color (0.9,0.9,0.2)

Materials: diffuse only (Lambert).

Lighting (v1):
- Directional light direction = normalize((-1, -2, -1))
- Sky color = (0.7,0.8,1.0) * 0.5
- Ambient term allowed (e.g. 0.05)

---

## 6) GLB Import (optional)

- Button “Import GLB” + drag/drop.
- After import, scene behavior must be consistent:
  - Choose one:
    1) Replace default scene, OR
    2) Add imported mesh to default scene
- v1 geometry requirements for GLB:
  - triangle positions (world space or object space but consistent)
  - indices
  - baseColor approximation (diffuse)

Allowed: use Babylon.js in `/src/scene/glbImport.ts` for GLB parsing only.

---

## 7) UI requirements (exact)

Controls (in `/src/ui/controls.ts`):

- Resolution dropdown: `{ 640×360, 960×540, 1280×720 }` default `960×540`
- SPP target: integer input default `200`
- Max bounces: integer input default `4` (v1 may only do 1 bounce; keep field)
- Render button
- Cancel button
- Reset Scene button (restore default primitives)
- Import GLB button
- Export PNG button
- Status text: `Idle | Rendering… | Done | Cancelled`
- If progress messages implemented: `Sample i / spp`

Camera controls (main thread):
- Orbit: left drag
- Zoom: wheel
- Any camera change while rendering:
  - MUST cancel current job and set status “Cancelled (camera changed)”

---

## 8) Worker Message Protocol (exact)

### Main → Worker

#### init
```ts
{ type: "init" }
```

#### render
```ts
{
  type: "render",
  jobId: number,
  width: number,
  height: number,
  spp: number,
  maxBounces: number,
  camera: {
    pos: [number,number,number],
    target: [number,number,number],
    up: [number,number,number],
    fovY: number
  },
  scene: SerializedScene
}
```

#### cancel
```ts
{ type: "cancel", jobId: number }
```

### Worker → Main

#### progress (optional but recommended)
```ts
{ type: "progress", jobId: number, sample: number, spp: number }
```

#### result
```ts
{
  type: "result",
  jobId: number,
  width: number,
  height: number,
  rgba: ArrayBuffer
}
```

The `rgba` buffer is `Uint8ClampedArray` with length `width * height * 4`.

#### error
```ts
{ type: "error", jobId: number, message: string }
```

Cancellation may be reported as `error` with message `"cancelled"`.

---

## 9) Scene Serialization (exact)

File: `/src/scene/types.ts`

```ts
export type Vec3 = [number, number, number];

export type DiffuseMaterial = { baseColor: Vec3 };

export type Sphere = { type: "sphere"; center: Vec3; radius: number; materialId: number };
export type Box = { type: "box"; center: Vec3; halfExtents: Vec3; materialId: number };
export type Plane = { type: "plane"; normal: Vec3; d: number; materialId: number }; // dot(n,p)+d=0

export type TriangleMesh = {
  type: "triangles";
  positions: Float32Array; // xyz * vertexCount
  indices: Uint32Array;    // 3 * triCount
  materialIds?: Uint16Array; // optional per-triangle material
  materialId?: number;       // single material for all
};

export type SceneObject = Sphere | Box | Plane | TriangleMesh;

export type SerializedScene = {
  materials: DiffuseMaterial[];
  objects: SceneObject[];
};
```

Rules:
- Default scene uses Sphere/Box/Plane.
- GLB import produces TriangleMesh (can be merged).

---

## 10) WebGL2 Display Contract (exact)

File: `/src/gl/glDisplay.ts`

Implement:
- Create WebGL2 context from `#viewport`
- Compile shaders in `/src/gl/shaders/fullscreen.vert|frag`
- Create one `RGBA8` texture
- Function `displayRGBA(width, height, rgba: Uint8Array)`:
  - `gl.texImage2D(..., gl.RGBA, gl.UNSIGNED_BYTE, rgba)`
  - draw fullscreen triangle/quad
- No continuous animation loop required.

---

## 11) Ray Tracer Requirements (v1)

### Algorithm
In worker, for each pixel:
- for sample = 0..spp-1:
  - jitter inside pixel (optional)
  - cast ray
  - intersect primitives + triangles
  - if miss: sky color
  - if hit: Lambert shading with directional light
    - optional hard shadow: cast shadow ray; if occluded, only ambient
  - accumulate
- write final color to RGBA8

### Deterministic RNG (required)
- seed = hash(x, y, sample, jobId)
- Use an LCG or xorshift; must produce stable results per job.

### Bounces
- v1 may implement only direct lighting (bounce=1).
- The `maxBounces` parameter must be accepted even if ignored.

---

## 12) Triangle Acceleration Structure (required if GLB triangles exist)

File: `/src/raytracer/bvh.ts`

- Build BVH once per render job (worker)
- Median split BVH is sufficient
- BVH traversal must be iterative (stack) to avoid recursion depth issues

---

## 13) Cancellation Rules (exact)

- Worker maintains `activeJobId` and `cancelledJobId`.
- During rendering, check cancellation at least every:
  - scanline, OR
  - every 4096 pixels
- If cancelled:
  - abort quickly
  - send `{ type:"error", jobId, message:"cancelled" }`
  - do not send result

---

## 14) Render Button Behavior (exact)

- When user clicks Render:
  1) increment `jobId`
  2) send `render` message with current settings
  3) set status “Rendering…”
- When `result` arrives:
  1) upload pixels to WebGL texture
  2) display
  3) set status “Done”
- When `error: cancelled` arrives:
  - status “Cancelled”

Ray tracing must not run again until user clicks Render again.

---

## 15) Export PNG (exact)

Main thread keeps last `width/height/rgba`.

Export flow:
1. Create a temporary 2D canvas at width/height
2. Create `ImageData` from `Uint8ClampedArray`
3. `putImageData`
4. `toBlob("image/png")`
5. Trigger download filename `render.png`

---

## 16) Acceptance Tests (must pass)

1. App loads and shows UI; status is Idle.
2. Default scene exists (primitives present).
3. Clicking Render produces a final image and status becomes Done.
4. CPU usage is low when idle (no render loop).
5. Cancel stops rendering and status becomes Cancelled.
6. Import GLB then Render produces an image.
7. Export downloads PNG of last render.

---

# End of Spec
