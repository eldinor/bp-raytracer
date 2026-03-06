# WebGL2 Static Ray Tracer

Single-shot CPU ray tracer in a Worker with WebGL2 display upload.

## Run

```bash
npm install
npm run dev
```

## Notes

- Click `Render` to compute the image (no continuous rendering loop).
- The scene is visible interactively before rendering via Babylon.js preview.
- `Cancel` stops the current worker job.
- `Export PNG` saves the most recent render as `render.png`.
- Drag and drop a `.glb` file onto the viewport (or use `Import GLB`).
