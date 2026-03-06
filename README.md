# WebGL2 Static Ray Tracer

Interactive Babylon.js preview + CPU path tracer (Web Worker) with WebGL2 overlay display.

## Run

```bash
npm install
npm run dev
```

## Workflow

- Orbit the scene in Babylon preview.
- Click `Render` to start worker path tracing.
- Preview camera controls are frozen during render.
- Progressive tile updates are shown as the render converges.
- Final raytraced image is shown as an overlay over the Babylon preview.

## Controls

- `Resolution`: `Fullscreen (Canvas)`, `640x360`, `960x540`, `1280x720`
- `SPP`: samples per pixel (default `4`)
- `Max bounces`: path depth (default `4`)
- `Light intensity` (default `0.7`)
- `Shadow darkness` (default `0.8`)
- `Firefly clamp` (default `40`)
- `Firefly suppression` (default `3.0`)
- `Normal strength` (default `1.0`)
- `Mix (RT overlay)` (default `0.5`)
- `Mat mapping (GLB)`: when enabled, imported GLB PBR materials are mapped into the ray scene

## Import / Export

- `Import GLB` button or drag-and-drop `.glb` onto the viewport.
- `Export PNG`: exports pure raytraced output (`render.png`).
- `Export mix`: exports current preview + overlay blend (`render-mix.png`).

## GLB Material Support

- Uses the same Babylon-imported meshes for preview and serialized ray scene.
- Preserves per-primitive/per-submesh material assignment.
- Maps PBR factors:
  - `baseColorFactor`
  - `metallicFactor`
  - `roughnessFactor`
- Samples textures in the worker BRDF:
  - base color texture (UV transform + wrap)
  - metallic/roughness texture (G/B channels)
  - normal map (with global `Normal strength` multiplier)

## Notes

- Rendering is static/on-demand (no continuous path tracing loop).
- `Cancel` stops the active worker job.
- Denoising (A-Trous) and firefly suppression are applied after accumulation.
