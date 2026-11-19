// Web Worker: ejecuta el modelo de segmentación fuera del hilo principal para que la
// animación no se congele. Devuelve, para cada grupo de clases, un mapa de probabilidad.
//
// Optimizaciones:
//  · fp16 en WebGPU / cuantizado (q8) en CPU, con alternativa a fp32 si no está disponible.
//  · Preprocesado propio: la imagen llega ya al tamaño de entrada y con su proporción
//    real (sin aplastarla a 512×512), así se calcula menos y se detecta mejor.
//  · Opción de analizar la imagen en espejo (se alterna en cada análisis y se fusiona).
import { TRANSFORMERS_URL, GROUPS } from "./config.js";

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
let T, model, groupIdx, backend, dtype;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") await load(data);
    else if (data.type === "infer") await infer(data);
  } catch (e) {
    // ONNX Runtime a veces lanza solo un número (código interno): se añade contexto.
    const msg = e?.message || (typeof e === "number" ? `error interno del motor de IA (${e})` : String(e));
    self.postMessage({ type: "error", id: data.id, message: msg, during: data.type });
  }
};

// Carga UNA configuración (modelo + dispositivo + precisión). Si falla, el hilo principal
// cierra este worker y prueba la siguiente en uno nuevo: así un fallo (p. ej. de WebGPU)
// no deja el motor de inferencia bloqueado para los siguientes intentos.
async function load({ model: id, device, dtype: dt }) {
  T = await import(TRANSFORMERS_URL);
  const progress_callback = p => { if (p.status === "progress") self.postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: p.total }); };
  model = await T.AutoModelForSemanticSegmentation.from_pretrained(id, { device, dtype: dt, progress_callback });
  buildGroups();
  await infer({ id: -1, width: 128, height: 96, buffer: new Uint8ClampedArray(128 * 96 * 4).buffer }, true);
  backend = device === "webgpu" ? "WebGPU" : "WASM"; dtype = dt;
  self.postMessage({ type: "ready", backend, dtype, model: id });
}

function buildGroups() {
  const labels = model.config.id2label;
  groupIdx = {};
  for (const [name, re] of Object.entries(GROUPS)) {
    groupIdx[name] = Object.entries(labels).filter(([, l]) => re.test(l.trim())).map(([i]) => +i);
  }
}

async function infer({ id, epoch, width: w, height: h, buffer, flip }, warmup = false) {
  const t0 = performance.now();
  // RGBA → tensor planar normalizado [1, 3, h, w].
  const px = new Uint8ClampedArray(buffer), N0 = w * h, x = new Float32Array(3 * N0);
  for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) {
    const s = (y * w + (flip ? w - 1 - i : i)) * 4, d = y * w + i;
    x[d] = (px[s] / 255 - MEAN[0]) / STD[0];
    x[N0 + d] = (px[s + 1] / 255 - MEAN[1]) / STD[1];
    x[2 * N0 + d] = (px[s + 2] / 255 - MEAN[2]) / STD[2];
  }
  const { logits } = await model({ pixel_values: new T.Tensor("float32", x, [1, 3, h, w]) });
  const [, C, gh, gw] = logits.dims, N = gw * gh;
  let L = logits.data;
  if (!(L instanceof Float32Array)) L = Float32Array.from(L);      // fp16 → fp32
  if (warmup) return;

  // Softmax por píxel y suma de probabilidades de cada grupo.
  const names = Object.keys(groupIdx), maps = {};
  const mx = new Float32Array(N).fill(-Infinity), sum = new Float32Array(N);
  for (let c = 0; c < C; c++) { const o = c * N; for (let i = 0; i < N; i++) if (L[o + i] > mx[i]) mx[i] = L[o + i]; }
  for (let c = 0; c < C; c++) { const o = c * N; for (let i = 0; i < N; i++) sum[i] += Math.exp(L[o + i] - mx[i]); }
  for (const n of names) {
    const m = new Float32Array(N);
    for (const c of groupIdx[n]) { const o = c * N; for (let i = 0; i < N; i++) m[i] += Math.exp(L[o + i] - mx[i]); }
    if (flip) {                                    // deshace el espejo
      for (let y = 0; y < gh; y++) { const r = y * gw; for (let i = 0; i < gw >> 1; i++) { const a = m[r + i]; m[r + i] = m[r + gw - 1 - i]; m[r + gw - 1 - i] = a; } }
      for (let y = 0; y < gh; y++) { const r = y * gw; for (let i = 0; i < gw; i++) m[r + i] /= sum[r + gw - 1 - i]; }
    } else for (let i = 0; i < N; i++) m[i] /= sum[i];
    maps[n] = m;
  }
  self.postMessage({ type: "result", id, epoch, gw, gh, maps, ms: performance.now() - t0 }, names.map(n => maps[n].buffer));
}
