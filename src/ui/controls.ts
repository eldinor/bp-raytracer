import type { ResolutionOption, UiStatus } from "./state";

type Callbacks = {
  onRender: () => void;
  onCancel: () => void;
  onResetScene: () => void;
  onRemoveSampleMeshes: () => void;
  onImportGlbClick: () => void;
  onExportPng: () => void;
  onExportMix: () => void;
  onCameraAlphaChange: (value: number) => void;
  onLightIntensityChange: (value: number) => void;
  onShadowDarknessChange: (value: number) => void;
  onFireflyClampChange: (value: number) => void;
  onFireflySuppressionChange: (value: number) => void;
  onSpecularSpikeClampChange: (value: number) => void;
  onExtremeSpikeKillChange: (value: number) => void;
  onSampleBoxEmissiveIntensityChange: (value: number) => void;
  onNormalStrengthChange: (value: number) => void;
  onBlendMixChange: (value: number) => void;
};

export type Controls = {
  getResolution: () => ResolutionOption;
  getWorkerCount: () => number;
  getGlbMatMapping: () => boolean;
  getCameraAlpha: () => number;
  getLightIntensity: () => number;
  getShadowDarkness: () => number;
  getFireflyClamp: () => number;
  getFireflySuppression: () => number;
  getSpecularSpikeClamp: () => number;
  getExtremeSpikeKill: () => number;
  getSampleBoxEmissiveIntensity: () => number;
  getNormalStrength: () => number;
  getSpp: () => number;
  getMaxBounces: () => number;
  setStatus: (status: UiStatus) => void;
  setProgress: (sample: number, spp: number) => void;
  setRenderTime: (ms: number | null) => void;
};

function makeLabel(text: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.textContent = text;
  label.className = "row-label";
  return label;
}

export function createControls(root: HTMLElement, callbacks: Callbacks, options?: { maxWorkers?: number }): Controls {
  root.innerHTML = "";
  const maxWorkers = Math.max(1, options?.maxWorkers ?? 8);

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

  const workerLabel = makeLabel("Workers");
  const workerSelect = document.createElement("select");
  for (let i = 1; i <= maxWorkers; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = String(i);
    if (i === Math.min(maxWorkers, 8)) {
      opt.selected = true;
    }
    workerSelect.appendChild(opt);
  }

  const cameraAlphaLabel = makeLabel("Camera alpha");
  const cameraAlphaInput = document.createElement("input");
  cameraAlphaInput.type = "range";
  cameraAlphaInput.min = "-3.14";
  cameraAlphaInput.max = "3.14";
  cameraAlphaInput.step = "0.01";
  cameraAlphaInput.value = "-2.5";
  cameraAlphaLabel.textContent = "Camera alpha: -2.50";
  cameraAlphaInput.addEventListener("input", () => {
    const v = Number.parseFloat(cameraAlphaInput.value);
    cameraAlphaLabel.textContent = `Camera alpha: ${v.toFixed(2)}`;
    callbacks.onCameraAlphaChange(Math.max(-3.14, Math.min(3.14, v)));
  });

  const lightLabel = makeLabel("Light intensity");
  const lightInput = document.createElement("input");
  lightInput.type = "range";
  lightInput.min = "0";
  lightInput.max = "2";
  lightInput.step = "0.05";
  lightInput.value = "0.7";
  lightLabel.textContent = "Light intensity: 0.70";
  lightInput.addEventListener("input", () => {
    const v = Number.parseFloat(lightInput.value);
    lightLabel.textContent = `Light intensity: ${v.toFixed(2)}`;
    callbacks.onLightIntensityChange(Math.max(0, Math.min(2, v)));
  });

  const shadowLabel = makeLabel("Shadow darkness");
  const shadowInput = document.createElement("input");
  shadowInput.type = "range";
  shadowInput.min = "0";
  shadowInput.max = "1";
  shadowInput.step = "0.01";
  shadowInput.value = "0.8";
  shadowLabel.textContent = "Shadow darkness: 0.80";
  shadowInput.addEventListener("input", () => {
    const v = Number.parseFloat(shadowInput.value);
    shadowLabel.textContent = `Shadow darkness: ${v.toFixed(2)}`;
    callbacks.onShadowDarknessChange(Math.max(0, Math.min(1, v)));
  });

  const fireflyLabel = makeLabel("Firefly clamp");
  const fireflyInput = document.createElement("input");
  fireflyInput.type = "range";
  fireflyInput.min = "2";
  fireflyInput.max = "40";
  fireflyInput.step = "1";
  fireflyInput.value = "40";
  fireflyLabel.textContent = "Firefly clamp: 40";
  fireflyInput.addEventListener("input", () => {
    const v = Number.parseFloat(fireflyInput.value);
    fireflyLabel.textContent = `Firefly clamp: ${Math.round(v)}`;
    callbacks.onFireflyClampChange(Math.max(2, Math.min(40, v)));
  });

  const suppressLabel = makeLabel("Firefly suppression");
  const suppressInput = document.createElement("input");
  suppressInput.type = "range";
  suppressInput.min = "1";
  suppressInput.max = "6";
  suppressInput.step = "0.1";
  suppressInput.value = "3.0";
  suppressLabel.textContent = "Firefly suppression: 3.0";
  suppressInput.addEventListener("input", () => {
    const v = Number.parseFloat(suppressInput.value);
    suppressLabel.textContent = `Firefly suppression: ${v.toFixed(1)}`;
    callbacks.onFireflySuppressionChange(Math.max(1, Math.min(6, v)));
  });

  const specularClampLabel = makeLabel("Specular spike clamp");
  const specularClampInput = document.createElement("input");
  specularClampInput.type = "range";
  specularClampInput.min = "1";
  specularClampInput.max = "12";
  specularClampInput.step = "0.25";
  specularClampInput.value = "4.5";
  specularClampLabel.textContent = "Specular spike clamp: 4.50";
  specularClampInput.addEventListener("input", () => {
    const v = Number.parseFloat(specularClampInput.value);
    specularClampLabel.textContent = `Specular spike clamp: ${v.toFixed(2)}`;
    callbacks.onSpecularSpikeClampChange(Math.max(1, Math.min(12, v)));
  });

  const extremeSpikeKillLabel = makeLabel("Extreme spike kill");
  const extremeSpikeKillInput = document.createElement("input");
  extremeSpikeKillInput.type = "range";
  extremeSpikeKillInput.min = "0";
  extremeSpikeKillInput.max = "2";
  extremeSpikeKillInput.step = "0.05";
  extremeSpikeKillInput.value = "1.0";
  extremeSpikeKillLabel.textContent = "Extreme spike kill: 1.00";
  extremeSpikeKillInput.addEventListener("input", () => {
    const v = Number.parseFloat(extremeSpikeKillInput.value);
    extremeSpikeKillLabel.textContent = `Extreme spike kill: ${v.toFixed(2)}`;
    callbacks.onExtremeSpikeKillChange(Math.max(0, Math.min(2, v)));
  });

  const boxEmissiveLabel = makeLabel("Box emissive");
  const boxEmissiveInput = document.createElement("input");
  boxEmissiveInput.type = "range";
  boxEmissiveInput.min = "0";
  boxEmissiveInput.max = "3";
  boxEmissiveInput.step = "0.05";
  boxEmissiveInput.value = "0.5";
  boxEmissiveLabel.textContent = "Box emissive: 0.50";
  boxEmissiveInput.addEventListener("input", () => {
    const v = Number.parseFloat(boxEmissiveInput.value);
    boxEmissiveLabel.textContent = `Box emissive: ${v.toFixed(2)}`;
    callbacks.onSampleBoxEmissiveIntensityChange(Math.max(0, Math.min(3, v)));
  });

  const normalStrengthLabel = makeLabel("Normal strength");
  const normalStrengthInput = document.createElement("input");
  normalStrengthInput.type = "range";
  normalStrengthInput.min = "0";
  normalStrengthInput.max = "2";
  normalStrengthInput.step = "0.05";
  normalStrengthInput.value = "1.0";
  normalStrengthLabel.textContent = "Normal strength: 1.00";
  normalStrengthInput.addEventListener("input", () => {
    const v = Number.parseFloat(normalStrengthInput.value);
    normalStrengthLabel.textContent = `Normal strength: ${v.toFixed(2)}`;
    callbacks.onNormalStrengthChange(Math.max(0, Math.min(2, v)));
  });

  const blendLabel = makeLabel("Mix (RT overlay)");
  const blendInput = document.createElement("input");
  blendInput.type = "range";
  blendInput.min = "0";
  blendInput.max = "1";
  blendInput.step = "0.01";
  blendInput.value = "0.5";
  blendLabel.textContent = "Mix (RT overlay): 0.50";
  blendInput.addEventListener("input", () => {
    const v = Number.parseFloat(blendInput.value);
    blendLabel.textContent = `Mix (RT overlay): ${v.toFixed(2)}`;
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

  const removeSampleMeshesButton = document.createElement("button");
  removeSampleMeshesButton.textContent = "Remove sample meshes";
  removeSampleMeshesButton.onclick = callbacks.onRemoveSampleMeshes;

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
  const statusText = document.createElement("span");
  statusText.textContent = "Idle";
  const renderTime = document.createElement("span");
  renderTime.textContent = "-";
  status.append(statusText, renderTime);

  panel.append(
    resolutionLabel,
    resolution,
    sppLabel,
    sppInput,
    bouncesLabel,
    bouncesInput,
    workerLabel,
    workerSelect,
    cameraAlphaLabel,
    cameraAlphaInput,
    lightLabel,
    lightInput,
    shadowLabel,
    shadowInput,
    fireflyLabel,
    fireflyInput,
    suppressLabel,
    suppressInput,
    specularClampLabel,
    specularClampInput,
    extremeSpikeKillLabel,
    extremeSpikeKillInput,
    boxEmissiveLabel,
    boxEmissiveInput,
    normalStrengthLabel,
    normalStrengthInput,
    blendLabel,
    blendInput,
    renderButton,
    cancelButton,
    resetButton,
    removeSampleMeshesButton,
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
    getWorkerCount: () => Math.max(1, Math.min(maxWorkers, Number.parseInt(workerSelect.value, 10) || 1)),
    getGlbMatMapping: () => glbMapInput.checked,
    getCameraAlpha: () => {
      const v = Number.parseFloat(cameraAlphaInput.value);
      return Number.isFinite(v) ? Math.max(-3.14, Math.min(3.14, v)) : -2.5;
    },
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
    getFireflySuppression: () => {
      const v = Number.parseFloat(suppressInput.value);
      return Number.isFinite(v) ? Math.max(1, Math.min(6, v)) : 3;
    },
    getSpecularSpikeClamp: () => {
      const v = Number.parseFloat(specularClampInput.value);
      return Number.isFinite(v) ? Math.max(1, Math.min(12, v)) : 4.5;
    },
    getExtremeSpikeKill: () => {
      const v = Number.parseFloat(extremeSpikeKillInput.value);
      return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
    },
    getSampleBoxEmissiveIntensity: () => {
      const v = Number.parseFloat(boxEmissiveInput.value);
      return Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 0.5;
    },
    getNormalStrength: () => {
      const v = Number.parseFloat(normalStrengthInput.value);
      return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
    },
    getSpp: () => Math.max(1, Number.parseInt(sppInput.value, 10) || 1),
    getMaxBounces: () => Math.max(1, Number.parseInt(bouncesInput.value, 10) || 1),
    setStatus: (s) => {
      statusText.textContent = s;
    },
    setProgress: (sample, spp) => {
      statusText.textContent = `Sample ${sample} / ${spp}`;
    },
    setRenderTime: (ms) => {
      renderTime.textContent = ms == null ? "-" : `${(ms / 1000).toFixed(2)} s`;
    },
  };
}
