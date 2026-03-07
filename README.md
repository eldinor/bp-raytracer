# WebGL2 Static Ray Tracer

A browser-based static ray tracer built with TypeScript, Vite, Babylon.js, WebGL2, and Web Workers.

The app combines a real-time Babylon.js preview with an on-demand CPU ray tracer. You navigate the scene in the preview, launch a render, and inspect the ray-traced result as a WebGL overlay or as exported images.

## Stack

- TypeScript
- Vite
- Babylon.js for scene preview and GLB loading
- WebGL2 for presenting the ray-traced framebuffer
- Web Workers for parallel CPU rendering

## Getting Started

```bash
npm install
npm run dev
```

Other scripts:

```bash
npm run build
npm run preview
npm run lint
```

## How It Works

1. The Babylon.js viewport is used for camera navigation and scene preview.
2. Press `Render` to serialize the current scene and camera into worker jobs.
3. Workers ray trace horizontal regions in parallel and stream partial tile updates.
4. The final RGBA image is presented through a WebGL2 canvas layered above the preview.
5. The overlay opacity can be adjusted with `Mix (RT overlay)`.

Rendering is static and explicit. There is no continuous progressive render loop after completion.

## Features

- Babylon.js orbit preview with synchronized ray-trace camera
- Multi-worker rendering with selectable worker count
- Tile-based partial updates during rendering
- Default scene with spheres, boxes, cylinders, tori, and wall quads
- GLB import by button or drag-and-drop
- Optional GLB material-to-ray-material mapping
- Texture-aware GLB material import for:
  - base color
  - emissive
  - metallic / roughness
  - normal maps
- PNG export of:
  - pure ray-traced output
  - preview + ray-trace blend
  - side-by-side comparison image
- Compare popup for quick visual inspection
- Render cancellation and scene reset tools

## Controls

Current UI controls:

- `Resolution`: `Fullscreen (Canvas)`, `640x360`, `960x540`, `1280x720`
- `SPP`: samples per pixel
- `Max bounces`: path depth
- `Workers`: number of render workers
- `Camera alpha`: preview orbit angle helper
- `Light intensity`
- `Shadow darkness`
- `Firefly clamp`
- `Firefly mode`: `mild`, `strong`, `brutal`
- `Firefly suppression`
- `Specular spike clamp`
- `Extreme spike kill`
- `Soft cleanup`
- `Mesh emissive min area`
- `Box emissive`
- `Normal strength`
- `Mix (RT overlay)`
- `Mat mapping (GLB)`: preserve imported material properties instead of forcing a default material

Action buttons:

- `Render`
- `Cancel`
- `Reset Scene`
- `Remove sample meshes`
- `Import GLB`
- `Export PNG`
- `Export mix`
- `2Compare`
- `Open`

## GLB Import

The renderer imports `.glb` meshes into the preview scene and converts supported mesh data into serialized triangle geometry for the worker renderer.

Supported material mapping paths include:

- `PBRMetallicRoughnessMaterial`
- `PBRMaterial`
- `StandardMaterial`

Imported data can include:

- world-space triangle positions
- normals
- UV0 / UV1
- per-mesh or per-submesh material assignment
- texture transforms
- wrap modes

If `Mat mapping (GLB)` is disabled, imported geometry is still used, but all imported meshes share one default diffuse-style material in the ray scene.

## Export Modes

- `Export PNG`: saves the pure ray-traced framebuffer as `render.png`
- `Export mix`: saves the current preview and overlay blend as `render-mix.png`
- `2Compare`: saves a side-by-side preview vs mixed-render image as `2compare.png`
- `Open`: opens the comparison image in an in-app popup overlay

## Default Scene

The built-in sample scene includes:

- a ground plane
- multiple spheres with varied metallic/roughness values
- several boxes, including an emissive sample box
- procedurally generated cylinders
- procedurally generated tori
- large quad walls for additional shading variation

## Project Structure

```text
src/
  gl/
    glDisplay.ts
    shaders/
  raytracer/
    bvh.ts
    math.ts
    raytracer.ts
  scene/
    defaultScene.ts
    glbImport.ts
    types.ts
  ui/
    controls.ts
    state.ts
  workers/
    rayWorker.ts
  main.ts
```

## Notes

- Camera controls are detached while a render job is active.
- Cancelling a render stops active worker jobs.
- The result overlay remains visible after a completed render until hidden or replaced.
- Post-processing includes firefly control and cleanup tuned through the UI.
