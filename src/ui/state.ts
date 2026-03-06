import type { SerializedScene, Vec3 } from "../scene/types";

export type ResolutionOption = "fullscreen" | "640x360" | "960x540" | "1280x720";
export type UiStatus = "Idle" | "Rendering..." | "Done" | "Cancelled" | "Cancelled (camera changed)";

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
  glbMatMapping: boolean;
  lightIntensity: number;
  shadowDarkness: number;
  fireflyClamp: number;
  blendMix: number;
  spp: number;
  maxBounces: number;
  scene: SerializedScene;
  camera: CameraState;
  lastRender: LastRender;
};
