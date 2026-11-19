// Web Worker: ejecuta el modelo de segmentación fuera del hilo principal para que la
// animación no se congele. Devuelve, para cada grupo de clases, un mapa de probabilidad.
//
// Optimizaciones:
//  · fp16 en WebGPU / cuantizado (q8) en CPU, con alternativa a fp32 si no está disponible.
//  · Preprocesado propio: la imagen llega ya al tamaño de entrada y con su proporción
//    real (sin aplastarla a 512×512), así se calcula menos y se detecta mejor.
//  · Opción de analizar la imagen en espejo (se alterna en cada análisis y se fusiona).
import { TRANSFORMERS_URL, GROUPS, TEACH_CLASSES } from "./config.js";

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
let T, model, groupIdx, backend, dtype;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") await load(data);
    else if (data.type === "infer") await infer(data);
    else await handleTeach(data);
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

// ---------------------------------------------------------------------------
// Aprendizaje del usuario ("Enseñar")
// Para cada celda de la rejilla del modelo, las características son las 150
// log-probabilidades del modelo más el color; un clasificador lineal (regresión
// logística multiclase) aprende a traducirlas a las clases que pinta el usuario.
// ---------------------------------------------------------------------------
const K = TEACH_CLASSES.length, MAX_SAMPLES = 8000;
let D = 0;                         // dimensión de las características (C + 3 colores + sesgo)
let adapter = null, useAdapter = true, teachFrame = null;
let samples = { X: new Float32Array(0), y: new Int8Array(0), n: 0 };

function feature(logp, C, N, i, x, N0, w, gx, gy, out, o) {
  for (let c = 0; c < C; c++) out[o + c] = Math.max(-12, logp[c * N + i]) / 4;
  const s = (gy * 4 + 2) * w + gx * 4 + 2;
  out[o + C] = x[s] * 0.5; out[o + C + 1] = x[N0 + s] * 0.5; out[o + C + 2] = x[2 * N0 + s] * 0.5;
  out[o + C + 3] = 1;
}

function train() {
  const { X, y, n } = samples;
  if (!n) { adapter = null; return { n: 0 }; }
  // Pesos por clase (las clases con pocos trazos cuentan más).
  const cnt = new Array(K).fill(0); for (let i = 0; i < n; i++) cnt[y[i]]++;
  const present = cnt.filter(c => c).length, cw = cnt.map(c => c ? n / (present * c) : 0);
  const Wt = new Float32Array(K * D), m = new Float32Array(K * D), v = new Float32Array(K * D), g = new Float32Array(K * D);
  const lr = 0.05, l2 = 1e-3, b1 = 0.9, b2 = 0.999, z = new Float32Array(K);
  for (let ep = 1; ep <= 160; ep++) {
    g.fill(0);
    for (let i = 0; i < n; i++) {
      const o = i * D;
      let mx = -Infinity;
      for (let k = 0; k < K; k++) { let s = 0; const ok = k * D; for (let d = 0; d < D; d++) s += Wt[ok + d] * X[o + d]; z[k] = s; if (s > mx) mx = s; }
      let sum = 0; for (let k = 0; k < K; k++) { z[k] = Math.exp(z[k] - mx); sum += z[k]; }
      const wgt = cw[y[i]] / n;
      for (let k = 0; k < K; k++) {
        const e = (z[k] / sum - (k === y[i] ? 1 : 0)) * wgt, ok = k * D;
        if (e !== 0) for (let d = 0; d < D; d++) g[ok + d] += e * X[o + d];
      }
    }
    for (let j = 0; j < Wt.length; j++) {
      const gj = g[j] + l2 * Wt[j];
      m[j] = b1 * m[j] + (1 - b1) * gj; v[j] = b2 * v[j] + (1 - b2) * gj * gj;
      Wt[j] -= lr * (m[j] / (1 - b1 ** ep)) / (Math.sqrt(v[j] / (1 - b2 ** ep)) + 1e-8);
    }
    if (ep % 40 === 0) self.postMessage({ type: "trainprogress", progress: ep / 160 });
  }
  // Acierto sobre las muestras (orientativo).
  let ok = 0;
  for (let i = 0; i < n; i++) {
    let best = 0, bv = -Infinity;
    for (let k = 0; k < K; k++) { let s = 0; for (let d = 0; d < D; d++) s += Wt[k * D + d] * X[i * D + d]; if (s > bv) { bv = s; best = k; } }
    if (best === y[i]) ok++;
  }
  adapter = Wt;
  return { n, acc: ok / n, counts: cnt };
}

function addSamples(labels) {
  const f = teachFrame; if (!f) throw new Error("no hay foto para enseñar");
  const idx = []; for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) idx.push(i);
  let { X, y, n } = samples;
  const nn = n + idx.length, X2 = new Float32Array(nn * D), y2 = new Int8Array(nn);
  X2.set(X.subarray(0, n * D)); y2.set(y.subarray(0, n));
  idx.forEach((i, j) => { X2.set(f.F.subarray(i * D, (i + 1) * D), (n + j) * D); y2[n + j] = labels[i]; });
  samples = { X: X2, y: y2, n: nn };
  if (nn > MAX_SAMPLES) {                       // submuestreo aleatorio
    const keep = new Uint32Array(nn).map((_, i) => i);
    for (let i = nn - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [keep[i], keep[j]] = [keep[j], keep[i]]; }
    const X3 = new Float32Array(MAX_SAMPLES * D), y3 = new Int8Array(MAX_SAMPLES);
    for (let j = 0; j < MAX_SAMPLES; j++) { X3.set(X2.subarray(keep[j] * D, (keep[j] + 1) * D), j * D); y3[j] = y2[keep[j]]; }
    samples = { X: X3, y: y3, n: MAX_SAMPLES };
  }
  return idx.length;
}

async function handleTeach(data) {
  if (data.type === "train") {
    const added = addSamples(data.labels);
    const r = train();
    self.postMessage({ type: "trained", added, ...r, D, X: samples.X.slice(0, samples.n * D), y: samples.y.slice(0, samples.n) });
  } else if (data.type === "adapter") {             // restaurar lo aprendido guardado
    if (data.D !== D) { self.postMessage({ type: "adapterloaded", ok: false }); return; }
    samples = { X: data.X, y: data.y, n: data.y.length };
    const r = train();
    self.postMessage({ type: "adapterloaded", ok: true, ...r });
  } else if (data.type === "forget") { samples = { X: new Float32Array(0), y: new Int8Array(0), n: 0 }; adapter = null; }
  else if (data.type === "useAdapter") useAdapter = data.on;
}

async function infer({ id, epoch, width: w, height: h, buffer, flip, teach }, warmup = false) {
  const t0 = performance.now();
  if (teach) flip = false;
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
  D = C + 4;
  if (warmup) return;

  // Log-softmax por píxel.
  const mx = new Float32Array(N).fill(-Infinity), lse = new Float32Array(N);
  for (let c = 0; c < C; c++) { const o = c * N; for (let i = 0; i < N; i++) if (L[o + i] > mx[i]) mx[i] = L[o + i]; }
  for (let c = 0; c < C; c++) { const o = c * N; for (let i = 0; i < N; i++) lse[i] += Math.exp(L[o + i] - mx[i]); }
  for (let i = 0; i < N; i++) lse[i] = mx[i] + Math.log(lse[i]);
  const logp = L;                                   // se reutiliza el buffer
  for (let c = 0; c < C; c++) { const o = c * N; for (let i = 0; i < N; i++) logp[o + i] -= lse[i]; }

  // Probabilidad de cada grupo (en el espacio del modelo, quizá en espejo).
  const names = Object.keys(groupIdx), maps = {};
  for (const n of names) {
    const m = new Float32Array(N);
    for (const c of groupIdx[n]) { const o = c * N; for (let i = 0; i < N; i++) m[i] += Math.exp(logp[o + i]); }
    maps[n] = m;
  }

  // Foto para enseñar: se guardan las características de cada celda.
  if (teach) {
    const F = new Float32Array(N * D);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) { const i = gy * gw + gx; feature(logp, C, N, i, x, N0, w, gx, gy, F, i * D); }
    teachFrame = { F, gw, gh };
  }

  // Lo aprendido se combina con el modelo.
  if (adapter && useAdapter) {
    const f = new Float32Array(D), z = new Float32Array(K), A = TEACH_CLASSES.map(() => new Float32Array(N));
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      feature(logp, C, N, i, x, N0, w, gx, gy, f, 0);
      let zm = -Infinity;
      for (let k = 0; k < K; k++) { let s = 0; const o = k * D; for (let d = 0; d < D; d++) s += adapter[o + d] * f[d]; z[k] = s; if (s > zm) zm = s; }
      let sum = 0; for (let k = 0; k < K; k++) { z[k] = Math.exp(z[k] - zm); sum += z[k]; }
      for (let k = 0; k < K; k++) A[k][i] = z[k] / sum;
    }
    for (let k = 0; k < K - 1; k++) {
      const m = maps[TEACH_CLASSES[k]], a = A[k];
      if (m) for (let i = 0; i < N; i++) m[i] = 0.25 * m[i] + 0.75 * a[i];
    }
  }

  if (flip) for (const n of names) {               // deshace el espejo
    const m = maps[n];
    for (let y = 0; y < gh; y++) { const r = y * gw; for (let i = 0; i < gw >> 1; i++) { const a = m[r + i]; m[r + i] = m[r + gw - 1 - i]; m[r + gw - 1 - i] = a; } }
  }
  self.postMessage({ type: "result", id, epoch, gw, gh, maps, teach: !!teach, ms: performance.now() - t0 }, names.map(n => maps[n].buffer));
}
