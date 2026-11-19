// Web Worker: ejecuta el modelo de segmentación fuera del hilo principal para que la
// animación no se congele. Devuelve, para cada grupo de clases, un mapa de probabilidad.
import { TRANSFORMERS_URL, GROUPS } from "./config.js";

let T, model, processor, groupIdx, backend;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") await load(data);
    else if (data.type === "infer") await infer(data);
  } catch (e) {
    self.postMessage({ type: "error", id: data.id, message: e?.message || String(e), during: data.type });
  }
};

async function load({ models }) {
  T = await import(TRANSFORMERS_URL);
  const progress_callback = p => { if (p.status === "progress") self.postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: p.total }); };
  const devices = ("gpu" in navigator) ? ["webgpu", "wasm"] : ["wasm"];
  let lastErr;
  for (const id of models) {
    for (const device of devices) {
      try {
        processor = await T.AutoProcessor.from_pretrained(id, { progress_callback });
        model = await T.AutoModelForSemanticSegmentation.from_pretrained(id, { device, progress_callback });
        backend = device === "webgpu" ? "WebGPU" : "WASM";
        buildGroups();
        await infer({ id: -1, width: 64, height: 48, buffer: new Uint8ClampedArray(64 * 48 * 4).buffer }, true);
        self.postMessage({ type: "ready", backend, model: id });
        return;
      } catch (e) { lastErr = e; console.warn(`No se pudo cargar ${id} con ${device}:`, e); }
    }
  }
  throw lastErr || new Error("no se pudo cargar el modelo");
}

function buildGroups() {
  const labels = model.config.id2label;
  groupIdx = {};
  for (const [name, re] of Object.entries(GROUPS)) {
    groupIdx[name] = Object.entries(labels).filter(([, l]) => re.test(l)).map(([i]) => +i);
  }
}

async function infer({ id, epoch, width, height, buffer }, warmup = false) {
  const rgba = new Uint8ClampedArray(buffer), rgb = new Uint8ClampedArray(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  const image = new T.RawImage(rgb, width, height, 3);
  const t0 = performance.now();
  const inputs = await processor(image);
  const { logits } = await model({ pixel_values: inputs.pixel_values });
  const [, C, gh, gw] = logits.dims, L = logits.data, N = gw * gh;
  if (warmup) return;

  // Softmax por píxel y suma de probabilidades de cada grupo.
  const names = Object.keys(groupIdx), maps = {};
  for (const n of names) maps[n] = new Float32Array(N);
  const mx = new Float32Array(N).fill(-Infinity), sum = new Float32Array(N);
  for (let c = 0; c < C; c++) { const o = c * N; for (let i = 0; i < N; i++) if (L[o + i] > mx[i]) mx[i] = L[o + i]; }
  for (let c = 0; c < C; c++) { const o = c * N; for (let i = 0; i < N; i++) sum[i] += Math.exp(L[o + i] - mx[i]); }
  for (const n of names) {
    const m = maps[n];
    for (const c of groupIdx[n]) { const o = c * N; for (let i = 0; i < N; i++) m[i] += Math.exp(L[o + i] - mx[i]); }
    for (let i = 0; i < N; i++) m[i] /= sum[i];
  }
  self.postMessage({ type: "result", id, epoch, gw, gh, maps, ms: performance.now() - t0 }, names.map(n => maps[n].buffer));
}
