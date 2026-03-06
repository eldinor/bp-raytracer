import type { SerializedScene, Vec3 } from "../scene/types";

export type ResolutionOption = "fullscreen" | "640x360" | "960x540" | "1280x720";
export type UiStatus = "Idle" | "Rendering..." | "Done" | "Cancelled" | "Cancelled (camera changed)";
export type FireflyMode = "mild" | "strong" | "brutal";

export type CameraState = {
  pos: Vec3;
  target: Vec3;
  up: Vec3;
  fovY: number;
};

export type LastRender = {
  width: number;
  height: number;
  rgba: Uint8Array;
} | null;

export type AppState = {
  jobId: number;
  renderingJobId: number | null;
  status: UiStatus;
  resolution: ResolutionOption;
  cameraAlpha: number;
  glbMatMapping: boolean;
  lightIntensity: number;
  shadowDarkness: number;
  fireflyClamp: number;
  fireflyMode: FireflyMode;
  fireflySuppression: number;
  specularSpikeClamp: number;
  extremeSpikeKill: number;
  softCleanup: number;
  emissiveTriangleThreshold: number;
  sampleBoxEmissiveIntensity: number;
  normalStrength: number;
  workerCount: number;
  blendMix: number;
  spp: number;
  maxBounces: number;
  scene: SerializedScene;
  camera: CameraState;
  lastRender: LastRender;
};
