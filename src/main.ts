import {
  AbstractMesh,
  ArcRotateCamera,
  Color3,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PBRMetallicRoughnessMaterial,
  Scene,
  SceneLoader,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { GLDisplay } from "./gl/glDisplay";
import { createDefaultScene } from "./scene/defaultScene";
import { importGlbIntoScene } from "./scene/glbImport";
import type { SerializedScene } from "./scene/types";
import { createControls } from "./ui/controls";
import type { AppState, ResolutionOption, UiStatus } from "./ui/state";

const previewCanvas = document.getElementById("viewport");
const ui = document.getElementById("ui");
if (!(previewCanvas instanceof HTMLCanvasElement) || !(ui instanceof HTMLDivElement)) {
  throw new Error("Missing required DOM nodes");
}

const style = document.createElement("style");
style.textContent = `
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; font-family: "Segoe UI", sans-serif; background: #111; }
  #viewport { position: fixed; inset: 0; width: 100%; height: 100%; touch-action: none; }
  #ui { position: fixed; top: 12px; left: 12px; color: #f4f4f4; z-index: 10; }
  .panel { display: grid; gap: 6px; width: 220px; padding: 12px; border-radius: 10px; background: rgba(18,20,24,0.9); border: 1px solid rgba(255,255,255,0.12); }
  .panel button, .panel input, .panel select { background: #262b33; color: #f4f4f4; border: 1px solid #4a5260; border-radius: 6px; padding: 6px; }
  .panel button { cursor: pointer; }
  .row-label { font-size: 12px; color: #c4ccd9; }
  .status { margin-top: 2px; font-size: 13px; color: #9ed67c; }
`;
document.head.appendChild(style);

const resultCanvas = document.createElement("canvas");
resultCanvas.style.position = "fixed";
resultCanvas.style.inset = "0";
resultCanvas.style.width = "100%";
resultCanvas.style.height = "100%";
resultCanvas.style.pointerEvents = "none";
resultCanvas.style.zIndex = "2";
resultCanvas.style.display = "none";
resultCanvas.style.opacity = "1";
document.body.appendChild(resultCanvas);

const display = new GLDisplay(resultCanvas);

const engine = new Engine(previewCanvas, true, { preserveDrawingBuffer: true, stencil: true });
const previewScene = new Scene(engine);
previewScene.useRightHandedSystem = true;
previewScene.clearColor.set(0.05, 0.06, 0.08, 1);
const camera = new ArcRotateCamera("camera", 0.25, 1.2, 8, new Vector3(0, 1, 0), previewScene);
camera.attachControl(previewCanvas, true);
camera.lowerRadiusLimit = 1.5;
camera.upperRadiusLimit = 30;
camera.wheelPrecision = 25;
camera.pinchPrecision = 80;
camera.minZ = 0.01;
camera.fov = (45 * Math.PI) / 180;

const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), previewScene);
hemi.intensity = 0.4;
const dir = new DirectionalLight("dir", new Vector3(-1, -2, -1).normalize(), previewScene);
dir.intensity = 0.6;

let previewMeshes: Mesh[] = [];
let importedPreviewMeshes: AbstractMesh[] = [];

function makeMaterial(sceneData: SerializedScene, materialId: number): PBRMetallicRoughnessMaterial {
  const m = new PBRMetallicRoughnessMaterial(`mat-${materialId}-${Math.random().toString(36).slice(2)}`, previewScene);
  const mat = sceneData.materials[materialId];
  const c = mat?.baseColor ?? [0.8, 0.8, 0.8];
  m.baseColor = new Color3(c[0], c[1], c[2]);
  m.metallic = Math.max(0, Math.min(1, mat?.metallic ?? 0));
  m.roughness = Math.max(0.04, Math.min(1, mat?.roughness ?? 0.7));
  return m;
}

function rebuildPreview(sceneData: SerializedScene): void {
  for (const m of previewMeshes) {
    m.material?.dispose();
    m.dispose();
  }
  previewMeshes = [];

  sceneData.objects.forEach((obj, idx) => {
    if (obj.type === "sphere") {
      const mesh = MeshBuilder.CreateSphere(`sphere-${idx}`, { diameter: obj.radius * 2, segments: 24 }, previewScene);
      mesh.position.set(obj.center[0], obj.center[1], obj.center[2]);
      mesh.material = makeMaterial(sceneData, obj.materialId);
      previewMeshes.push(mesh);
      return;
    }

    if (obj.type === "box") {
      const mesh = MeshBuilder.CreateBox(
        `box-${idx}`,
        { width: obj.halfExtents[0] * 2, height: obj.halfExtents[1] * 2, depth: obj.halfExtents[2] * 2 },
        previewScene,
      );
      mesh.position.set(obj.center[0], obj.center[1], obj.center[2]);
      mesh.material = makeMaterial(sceneData, obj.materialId);
      previewMeshes.push(mesh);
      return;
    }

    if (obj.type === "plane") {
      const mesh = MeshBuilder.CreateGround(`plane-${idx}`, { width: 20, height: 20, subdivisions: 1 }, previewScene);
      mesh.material = makeMaterial(sceneData, obj.materialId);
      previewMeshes.push(mesh);
      return;
    }

    if (!importedPreviewMeshes.length) {
      const mesh = new Mesh(`tri-${idx}`, previewScene);
      const vd = new VertexData();
      vd.positions = Array.from(obj.positions);
      vd.indices = Array.from(obj.indices);
      vd.applyToMesh(mesh, true);
      mesh.material = makeMaterial(sceneData, obj.materialId ?? 0);
      previewMeshes.push(mesh);
    }
  });
}

function clearImportedPreviewMeshes(): void {
  for (const m of importedPreviewMeshes) {
    m.dispose(false, true);
  }
  importedPreviewMeshes = [];
}

async function loadGlbPreview(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    const result = await SceneLoader.ImportMeshAsync(undefined, "", url, previewScene, undefined, ".glb");
    const meshes = result.meshes.filter((m) => m.name !== "__root__");
    importedPreviewMeshes.push(...meshes);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function applyPreviewLightIntensity(intensity: number): void {
  hemi.intensity = 0.4 * intensity;
  dir.intensity = 0.6 * intensity;
}

engine.runRenderLoop(() => {
  previewScene.render();
});

window.addEventListener("resize", () => {
  engine.resize();
  display.resizeToClientSize();
});

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".glb,model/gltf-binary";
fileInput.style.display = "none";
document.body.appendChild(fileInput);

const state: AppState = {
  jobId: 0,
  renderingJobId: null,
  status: "Idle",
  resolution: "fullscreen",
  glbMatMapping: true,
  lightIntensity: 0.7,
  shadowDarkness: 0.8,
  fireflyClamp: 40,
  blendMix: 0.5,
  spp: 4,
  maxBounces: 4,
  scene: createDefaultScene(),
  camera: {
    pos: [0, 0, 0],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fovY: 45,
  },
  lastRender: null,
};
rebuildPreview(state.scene);
applyPreviewLightIntensity(state.lightIntensity);

const worker = new Worker(new URL("./workers/rayWorker.ts", import.meta.url), { type: "module" });
worker.postMessage({ type: "init" });

let controls: ReturnType<typeof createControls>;
let controlsFrozen = false;

function setStatus(status: UiStatus): void {
  state.status = status;
  controls.setStatus(status);
}

function parseResolution(value: ResolutionOption): [number, number] {
  if (value === "fullscreen") {
    return [Math.max(1, previewCanvas.width), Math.max(1, previewCanvas.height)];
  }
  const [w, h] = value.split("x").map((v) => Number.parseInt(v, 10));
  return [w, h];
}

function setControlsFrozen(frozen: boolean): void {
  if (controlsFrozen === frozen) {
    return;
  }
  controlsFrozen = frozen;
  if (frozen) {
    camera.detachControl();
  } else {
    camera.attachControl(previewCanvas, true);
  }
}

function syncRayCameraFromPreview(): void {
  const pos = camera.position;
  const target = camera.target;
  state.camera = {
    pos: [pos.x, pos.y, pos.z],
    target: [target.x, target.y, target.z],
    up: [0, 1, 0],
    fovY: (camera.fov * 180) / Math.PI,
  };
}

function sendCancel(withStatus?: UiStatus): void {
  if (state.renderingJobId == null) {
    return;
  }
  worker.postMessage({ type: "cancel", jobId: state.renderingJobId });
  setControlsFrozen(false);
  if (withStatus) {
    setStatus(withStatus);
  }
}

function applyBlendMix(mix: number): void {
  const clamped = Math.max(0, Math.min(1, mix));
  state.blendMix = clamped;
  resultCanvas.style.opacity = clamped.toString();
}

async function importGlbFile(file: File): Promise<void> {
  const bytes = await file.arrayBuffer();
  state.glbMatMapping = controls.getGlbMatMapping();
  state.scene = await importGlbIntoScene(bytes, state.scene, { mapMaterials: state.glbMatMapping });
  try {
    await loadGlbPreview(file);
  } catch (err) {
    console.warn("GLB preview import failed, keeping raytracer import:", err);
  }
  rebuildPreview(state.scene);
  resultCanvas.style.display = "none";
  setControlsFrozen(false);
}

controls = createControls(ui, {
  onRender: () => {
    state.jobId += 1;
    state.renderingJobId = state.jobId;
    state.resolution = controls.getResolution();
    state.lightIntensity = controls.getLightIntensity();
    state.shadowDarkness = controls.getShadowDarkness();
    state.fireflyClamp = controls.getFireflyClamp();
    state.spp = controls.getSpp();
    state.maxBounces = controls.getMaxBounces();
    applyPreviewLightIntensity(state.lightIntensity);
    applyBlendMix(state.blendMix);
    syncRayCameraFromPreview();
    const [width, height] = parseResolution(state.resolution);
    setControlsFrozen(true);
    setStatus("Rendering...");
    resultCanvas.style.display = "block";
    display.beginFrame(width, height);
    display.present();
    worker.postMessage({
      type: "render",
      jobId: state.jobId,
      width,
      height,
      spp: state.spp,
      maxBounces: state.maxBounces,
      lightIntensity: state.lightIntensity,
      shadowDarkness: state.shadowDarkness,
      fireflyClamp: state.fireflyClamp,
      tileSize: 32,
      partialInterval: 4,
      camera: state.camera,
      scene: state.scene,
    });
  },
  onCancel: () => {
    if (state.renderingJobId != null) {
      sendCancel("Cancelled");
      return;
    }
    resultCanvas.style.display = "none";
    setControlsFrozen(false);
    setStatus("Idle");
  },
  onResetScene: () => {
    sendCancel("Cancelled");
    state.scene = createDefaultScene();
    clearImportedPreviewMeshes();
    rebuildPreview(state.scene);
    resultCanvas.style.display = "none";
    setControlsFrozen(false);
    setStatus("Idle");
  },
  onImportGlbClick: () => fileInput.click(),
  onExportPng: () => {
    if (!state.lastRender) {
      return;
    }
    const c = document.createElement("canvas");
    c.width = state.lastRender.width;
    c.height = state.lastRender.height;
    const ctx = c.getContext("2d");
    if (!ctx) {
      return;
    }
    const image = new ImageData(
      new Uint8ClampedArray(state.lastRender.rgba.buffer.slice(0)),
      state.lastRender.width,
      state.lastRender.height,
    );
    ctx.putImageData(image, 0, 0);
    c.toBlob((blob) => {
      if (!blob) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "render.png";
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  },
  onExportMix: () => {
    const w = Math.max(1, previewCanvas.width);
    const h = Math.max(1, previewCanvas.height);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) {
      return;
    }
    previewScene.render();
    ctx.globalAlpha = 1;
    ctx.drawImage(previewCanvas, 0, 0, w, h);
    if (state.lastRender && resultCanvas.style.display !== "none") {
      const rtCanvas = document.createElement("canvas");
      rtCanvas.width = state.lastRender.width;
      rtCanvas.height = state.lastRender.height;
      const rtCtx = rtCanvas.getContext("2d");
      if (!rtCtx) {
        return;
      }
      rtCtx.putImageData(
        new ImageData(
          new Uint8ClampedArray(state.lastRender.rgba.buffer.slice(0)),
          state.lastRender.width,
          state.lastRender.height
        ),
        0,
        0
      );
      ctx.globalAlpha = Math.max(0, Math.min(1, state.blendMix));
      ctx.drawImage(rtCanvas, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    c.toBlob((blob) => {
      if (!blob) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "render-mix.png";
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  },
  onLightIntensityChange: (value) => {
    state.lightIntensity = value;
    applyPreviewLightIntensity(value);
  },
  onShadowDarknessChange: (value) => {
    state.shadowDarkness = value;
  },
  onFireflyClampChange: (value) => {
    state.fireflyClamp = value;
  },
  onBlendMixChange: (value) => {
    applyBlendMix(value);
  },
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    return;
  }
  try {
    await importGlbFile(file);
    setStatus("Idle");
  } catch (err) {
    setStatus("Cancelled");
    console.error(err);
  } finally {
    fileInput.value = "";
  }
});

previewCanvas.addEventListener("dragover", (e) => {
  e.preventDefault();
});

previewCanvas.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.name.toLowerCase().endsWith(".glb")) {
    return;
  }
  try {
    await importGlbFile(file);
    setStatus("Idle");
  } catch (err) {
    console.error(err);
  }
});

camera.onViewMatrixChangedObservable.add(() => {
  if (state.renderingJobId != null && !controlsFrozen) {
    sendCancel("Cancelled (camera changed)");
  }
});

worker.onmessage = (ev: MessageEvent<any>) => {
  const msg = ev.data;
  if (msg.type === "partial") {
    if (msg.jobId !== state.renderingJobId) {
      return;
    }
    const rgba = new Uint8Array(msg.rgba);
    display.updateTile(msg.x, msg.y, msg.width, msg.height, rgba);
    display.present();
    return;
  }
  if (msg.type === "progress") {
    if (msg.jobId === state.renderingJobId) {
      controls.setProgress(msg.sample, msg.spp);
    }
    return;
  }
  if (msg.type === "result") {
    if (msg.jobId !== state.renderingJobId) {
      return;
    }
    const rgba = new Uint8Array(msg.rgba);
    resultCanvas.style.display = "block";
    display.displayRGBA(msg.width, msg.height, rgba);
    state.lastRender = { width: msg.width, height: msg.height, rgba };
    state.renderingJobId = null;
    setControlsFrozen(true);
    setStatus("Done");
    return;
  }
  if (msg.type === "error") {
    if (msg.jobId !== state.renderingJobId) {
      return;
    }
    state.renderingJobId = null;
    setControlsFrozen(false);
    if (msg.message === "cancelled") {
      if (state.status !== "Cancelled (camera changed)") {
        setStatus("Cancelled");
      } else {
        controls.setStatus("Cancelled (camera changed)");
      }
    } else {
      console.error("Render failed:", msg.message);
      setStatus("Cancelled");
    }
  }
};

setStatus("Idle");
