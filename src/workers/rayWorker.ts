/// <reference lib="webworker" />

import { renderScene } from "../raytracer/raytracer";
import type { SerializedScene, Vec3 } from "../scene/types";

type InitMsg = { type: "init" };
type RenderMsg = {
  type: "render";
  jobId: number;
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
  regionWidth?: number;
  regionHeight?: number;
  spp: number;
  maxBounces: number;
  lightIntensity?: number;
  shadowDarkness?: number;
  fireflyClamp?: number;
  fireflySuppression?: number;
  specularSpikeClamp?: number;
  normalStrength?: number;
  tileSize?: number;
  partialInterval?: number;
  camera: {
    pos: Vec3;
    target: Vec3;
    up: Vec3;
    fovY: number;
  };
  scene: SerializedScene;
};
type CancelMsg = { type: "cancel"; jobId: number };

type MainToWorker = InitMsg | RenderMsg | CancelMsg;

let activeJobId = -1;
let cancelledJobId = -1;
const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    return;
  }

  if (msg.type === "cancel") {
    cancelledJobId = msg.jobId;
    return;
  }

  activeJobId = msg.jobId;
  cancelledJobId = -1;

  try {
    const rgba = renderScene({
      ...msg,
      shouldCancel: () => cancelledJobId === msg.jobId || activeJobId !== msg.jobId,
      onProgress: (sample, spp) => {
        ctx.postMessage({ type: "progress", jobId: msg.jobId, sample, spp });
      },
      onTile: (x, y, width, height, rgbaTile) => {
        ctx.postMessage(
          {
            type: "partial",
            jobId: msg.jobId,
            x,
            y,
            width,
            height,
            rgba: rgbaTile.buffer
          },
          [rgbaTile.buffer]
        );
      }
    });

    if (cancelledJobId === msg.jobId || activeJobId !== msg.jobId) {
      ctx.postMessage({
        type: "error",
        jobId: msg.jobId,
        message: "cancelled"
      });
      return;
    }

    ctx.postMessage(
      {
        type: "result",
        jobId: msg.jobId,
        width: msg.width,
        height: msg.height,
        offsetX: msg.offsetX ?? 0,
        offsetY: msg.offsetY ?? 0,
        regionWidth: msg.regionWidth ?? msg.width,
        regionHeight: msg.regionHeight ?? msg.height,
        rgba: rgba.buffer
      },
      [rgba.buffer]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "worker error";
    ctx.postMessage({
      type: "error",
      jobId: msg.jobId,
      message
    });
  } finally {
    if (activeJobId === msg.jobId) {
      activeJobId = -1;
    }
  }
};
