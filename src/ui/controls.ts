import type { ResolutionOption, UiStatus } from "./state";

type Callbacks = {
  onRender: () => void;
  onCancel: () => void;
  onResetScene: () => void;
  onImportGlbClick: () => void;
  onExportPng: () => void;
  onExportMix: () => void;
  onLightIntensityChange: (value: number) => void;
  onShadowDarknessChange: (value: number) => void;
  onFireflyClampChange: (value: number) => void;
  onBlendMixChange: (value: number) => void;
};

export type Controls = {
  getResolution: () => ResolutionOption;
  getGlbMatMapping: () => boolean;
  getLightIntensity: () => number;
  getShadowDarkness: () => number;
  getFireflyClamp: () => number;
  getSpp: () => number;
  getMaxBounces: () => number;
  setStatus: (status: UiStatus) => void;
  setProgress: (sample: number, spp: number) => void;
};

function makeLabel(text: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.textContent = text;
  label.className = "row-label";
  return label;
}

export function createControls(root: HTMLElement, callbacks: Callbacks): Controls {
  root.innerHTML = "";

  const panel = document.createElement("div");
  panel.className = "panel";

  const resolutionLabel = makeLabel("Resolution");
  const resolution = document.createElement("select");
  for (const value of ["fullscreen", "640x360", "960x540", "1280x720"] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value === "fullscreen" ? "Fullscreen (Canvas)" : value;
    if (value === "fullscreen") {
      opt.selected = true;
    }
    resolution.appendChild(opt);
  }

  const sppLabel = makeLabel("SPP");
  const sppInput = document.createElement("input");
  sppInput.type = "number";
  sppInput.min = "1";
  sppInput.step = "1";
  sppInput.value = "4";

  const bouncesLabel = makeLabel("Max bounces");
  const bouncesInput = document.createElement("input");
  bouncesInput.type = "number";
  bouncesInput.min = "1";
  bouncesInput.step = "1";
  bouncesInput.value = "4";

  const lightLabel = makeLabel("Light intensity");
  const lightInput = document.createElement("input");
  lightInput.type = "range";
  lightInput.min = "0";
  lightInput.max = "2";
  lightInput.step = "0.05";
  lightInput.value = "0.7";
  const lightValue = document.createElement("div");
  lightValue.className = "row-label";
  lightValue.textContent = "0.70";
  lightInput.addEventListener("input", () => {
    const v = Number.parseFloat(lightInput.value);
    lightValue.textContent = v.toFixed(2);
    callbacks.onLightIntensityChange(Math.max(0, Math.min(2, v)));
  });

  const shadowLabel = makeLabel("Shadow darkness");
  const shadowInput = document.createElement("input");
  shadowInput.type = "range";
  shadowInput.min = "0";
  shadowInput.max = "1";
  shadowInput.step = "0.01";
  shadowInput.value = "0.8";
  const shadowValue = document.createElement("div");
  shadowValue.className = "row-label";
  shadowValue.textContent = "0.80";
  shadowInput.addEventListener("input", () => {
    const v = Number.parseFloat(shadowInput.value);
    shadowValue.textContent = v.toFixed(2);
    callbacks.onShadowDarknessChange(Math.max(0, Math.min(1, v)));
  });

  const fireflyLabel = makeLabel("Firefly clamp");
  const fireflyInput = document.createElement("input");
  fireflyInput.type = "range";
  fireflyInput.min = "2";
  fireflyInput.max = "40";
  fireflyInput.step = "1";
  fireflyInput.value = "40";
  const fireflyValue = document.createElement("div");
  fireflyValue.className = "row-label";
  fireflyValue.textContent = "40";
  fireflyInput.addEventListener("input", () => {
    const v = Number.parseFloat(fireflyInput.value);
    fireflyValue.textContent = String(Math.round(v));
    callbacks.onFireflyClampChange(Math.max(2, Math.min(40, v)));
  });

  const blendLabel = makeLabel("Mix (RT overlay)");
  const blendInput = document.createElement("input");
  blendInput.type = "range";
  blendInput.min = "0";
  blendInput.max = "1";
  blendInput.step = "0.01";
  blendInput.value = "0.5";
  const blendValue = document.createElement("div");
  blendValue.className = "row-label";
  blendValue.textContent = "0.50";
  blendInput.addEventListener("input", () => {
    const v = Number.parseFloat(blendInput.value);
    blendValue.textContent = v.toFixed(2);
    callbacks.onBlendMixChange(Math.max(0, Math.min(1, v)));
  });

  const renderButton = document.createElement("button");
  renderButton.textContent = "Render";
  renderButton.onclick = callbacks.onRender;

  const cancelButton = document.createElement("button");
  cancelButton.textContent = "Cancel";
  cancelButton.onclick = callbacks.onCancel;

  const resetButton = document.createElement("button");
  resetButton.textContent = "Reset Scene";
  resetButton.onclick = callbacks.onResetScene;

  const importButton = document.createElement("button");
  importButton.textContent = "Import GLB";
  importButton.onclick = callbacks.onImportGlbClick;

  const glbMapLabel = makeLabel("Mat mapping (GLB)");
  const glbMapInput = document.createElement("input");
  glbMapInput.type = "checkbox";
  glbMapInput.checked = true;

  const exportButton = document.createElement("button");
  exportButton.textContent = "Export PNG";
  exportButton.onclick = callbacks.onExportPng;

  const exportMixButton = document.createElement("button");
  exportMixButton.textContent = "Export mix";
  exportMixButton.onclick = callbacks.onExportMix;

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "Idle";

  panel.append(
    resolutionLabel,
    resolution,
    sppLabel,
    sppInput,
    bouncesLabel,
    bouncesInput,
    lightLabel,
    lightInput,
    lightValue,
    shadowLabel,
    shadowInput,
    shadowValue,
    fireflyLabel,
    fireflyInput,
    fireflyValue,
    blendLabel,
    blendInput,
    blendValue,
    renderButton,
    cancelButton,
    resetButton,
    importButton,
    glbMapLabel,
    glbMapInput,
    exportButton,
    exportMixButton,
    status
  );
  root.appendChild(panel);

  return {
    getResolution: () => resolution.value as ResolutionOption,
    getGlbMatMapping: () => glbMapInput.checked,
    getLightIntensity: () => {
      const v = Number.parseFloat(lightInput.value);
      return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
    },
    getShadowDarkness: () => {
      const v = Number.parseFloat(shadowInput.value);
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
    },
    getFireflyClamp: () => {
      const v = Number.parseFloat(fireflyInput.value);
      return Number.isFinite(v) ? Math.max(2, Math.min(40, v)) : 40;
    },
    getSpp: () => Math.max(1, Number.parseInt(sppInput.value, 10) || 1),
    getMaxBounces: () => Math.max(1, Number.parseInt(bouncesInput.value, 10) || 1),
    setStatus: (s) => {
      status.textContent = s;
    },
    setProgress: (sample, spp) => {
      status.textContent = `Sample ${sample} / ${spp}`;
    }
  };
}
