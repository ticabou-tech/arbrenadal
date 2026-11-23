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
  self.postMessage({ type: "ready", backend, dtype, model: id, D });
}

function buildGroups() {
  const labels = model.config.id2label;
  groupIdx = {};
  for (const [name, re] of Object.entries(GROUPS)) {
    groupIdx[name] = Object.entries(labels).filter(([, l]) => re.test(l.trim())).map(([i]) => +i);
  }
}

// ---------------------------------------------------------------------------
// Aprendizaje del usuario por ZONAS ("Enseñar")
// Para cada celda de la rejilla del modelo, las características son las 150
// log-probabilidades del modelo más el color; por cada zona, un clasificador lineal
// (regresión logística multiclase) aprende a traducirlas a las clases que pinta el
// usuario. Cada zona guarda además "huellas" de sus fotos (qué clases hay en cada parte
// de la imagen y sus colores) para reconocer automáticamente en qué zona estamos.
// ---------------------------------------------------------------------------
const K = TEACH_CLASSES.length, MAX_SAMPLES = 8000, TAU0 = 0.09;
let D = 0;                         // dimensión de las características (C + 3 colores + sesgo)
let teachFrame = null, zones = [], zoneMode = "auto", onlyZones = false;
const zoneDist = new Map();        // distancia suavizada de la vista actual a cada zona

function feature(logp, C, N, i, x, N0, w, gx, gy, out, o) {
  for (let c = 0; c < C; c++) out[o + c] = Math.max(-12, logp[c * N + i]) / 4;
  const s = (gy * 4 + 2) * w + gx * 4 + 2;
  out[o + C] = x[s] * 0.5; out[o + C + 1] = x[N0 + s] * 0.5; out[o + C + 2] = x[2 * N0 + s] * 0.5;
  out[o + C + 3] = 1;
}

// Huella de la imagen: 3×3 zonas × (raíz de la probabilidad media de cada clase + color medio).
function descriptor(logp, C, N, gw, gh, x, N0, w, flip) {
  const L = C + 3, out = new Float32Array(9 * L), cnt = new Float32Array(9);
  for (let gy = 0; gy < gh; gy += 2) for (let gx = 0; gx < gw; gx += 2) {
    let cx = Math.min(2, (gx * 3 / gw) | 0); if (flip) cx = 2 - cx;
    const cell = Math.min(2, (gy * 3 / gh) | 0) * 3 + cx, o = cell * L, i = gy * gw + gx;
    for (let c = 0; c < C; c++) out[o + c] += Math.exp(logp[c * N + i]);
    const sidx = (gy * 4 + 2) * w + gx * 4 + 2;
    for (let k = 0; k < 3; k++) out[o + C + k] += Math.min(1, Math.max(0, x[k * N0 + sidx] * STD[k] + MEAN[k]));
    cnt[cell]++;
  }
  for (let cell = 0; cell < 9; cell++) {
    const o = cell * L, n = cnt[cell] || 1;
    for (let c = 0; c < C; c++) out[o + c] = Math.sqrt(out[o + c] / n);
    for (let k = 0; k < 3; k++) out[o + C + k] /= n;
  }
  return out;
}

const dist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s / a.length); };

// Umbral de reconocimiento de una zona: según lo distintas que son sus propias fotos.
function zoneTau(descs) {
  if (descs.length < 2) return TAU0;
  let s = 0, n = 0;
  for (let i = 0; i < descs.length; i++) for (let j = i + 1; j < descs.length; j++) { s += dist(descs[i], descs[j]); n++; }
  return Math.max(TAU0, 1.8 * s / n);
}

function train(X, y, n) {
  if (!n) return null;
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
  let ok = 0;
  for (let i = 0; i < n; i++) {
    let best = 0, bv = -Infinity;
    for (let k = 0; k < K; k++) { let s = 0; for (let d = 0; d < D; d++) s += Wt[k * D + d] * X[i * D + d]; if (s > bv) { bv = s; best = k; } }
    if (best === y[i]) ok++;
  }
  return { W: Wt, acc: ok / n };
}

// Añade a las muestras de una zona las celdas pintadas de la foto congelada.
function addSamples(X, y, labels) {
  const f = teachFrame; if (!f) throw new Error("no hay foto para enseñar");
  const idx = []; for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) idx.push(i);
  const n = y.length, nn = n + idx.length, X2 = new Float32Array(nn * D), y2 = new Int8Array(nn);
  X2.set(X.subarray(0, n * D)); y2.set(y);
  idx.forEach((i, j) => { X2.set(f.F.subarray(i * D, (i + 1) * D), (n + j) * D); y2[n + j] = labels[i]; });
  if (nn <= MAX_SAMPLES) return { X: X2, y: y2, added: idx.length };
  const keep = new Uint32Array(nn).map((_, i) => i);                 // submuestreo aleatorio
  for (let i = nn - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [keep[i], keep[j]] = [keep[j], keep[i]]; }
  const X3 = new Float32Array(MAX_SAMPLES * D), y3 = new Int8Array(MAX_SAMPLES);
  for (let j = 0; j < MAX_SAMPLES; j++) { X3.set(X2.subarray(keep[j] * D, (keep[j] + 1) * D), j * D); y3[j] = y2[keep[j]]; }
  return { X: X3, y: y3, added: idx.length };
}

async function handleTeach(data) {
  if (data.type === "train") {                       // { zoneId, labels, X, y }
    const X0 = data.X?.length === data.y.length * D ? data.X : new Float32Array(0), y0 = X0.length ? data.y : new Int8Array(0);
    const { X, y, added } = addSamples(X0, y0, data.labels);
    const r = train(X, y, y.length);
    self.postMessage({ type: "trained", zoneId: data.zoneId, added, n: y.length, acc: r.acc, D, W: r.W, X, y, desc: teachFrame.desc });
  } else if (data.type === "retrain") {             // reentrenar con muestras guardadas (migración)
    const r = data.D === D ? train(data.X, data.y, data.y.length) : null;
    self.postMessage({ type: "retrained", zoneId: data.zoneId, ok: !!r, W: r?.W, acc: r?.acc, D });
  } else if (data.type === "zones") {               // [{ id, D, W, descs }]
    zones = data.zones.filter(z => z.D === D && z.W?.length === K * D).map(z => ({ ...z, tau: zoneTau(z.descs || []) }));
    zoneDist.clear();
  } else if (data.type === "zoneMode") { zoneMode = data.mode; onlyZones = data.only; }
}

// Elige la zona activa para la vista actual. Devuelve { zone, d, tau } o null.
function pickZone(desc) {
  if (zoneMode === "none" || !zones.length) return null;
  const cand = zoneMode === "auto" ? zones : zones.filter(z => z.id === zoneMode);
  let best = null;
  for (const z of cand) {
    const d = z.descs?.length ? Math.min(...z.descs.map(e => dist(e, desc))) : 0;
    const e = zoneDist.has(z.id) ? zoneDist.get(z.id) * 0.6 + d * 0.4 : d;
    zoneDist.set(z.id, e);
    if (!best || e < best.d) best = { zone: z, d: e, tau: z.tau };
  }
  if (!best) return null;
  best.match = zoneMode !== "auto" || !best.zone.descs?.length || best.d < best.tau;
  return best;
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

  const desc = descriptor(logp, C, N, gw, gh, x, N0, w, flip);

  // Foto para enseñar: se guardan las características de cada celda y su huella.
  if (teach) {
    const F = new Float32Array(N * D);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) { const i = gy * gw + gx; feature(logp, C, N, i, x, N0, w, gx, gy, F, i * D); }
    teachFrame = { F, gw, gh, desc };
  }

  // Zona: si la vista corresponde a una zona entrenada, su clasificador se combina con
  // el modelo. Con "solo en mis zonas", fuera de ellas no se decora nada.
  const pz = pickZone(desc), zone = pz?.match ? pz.zone : null;
  if (zone) {
    const Wz = zone.W, f = new Float32Array(D), z = new Float32Array(K), A = TEACH_CLASSES.map(() => new Float32Array(N));
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      feature(logp, C, N, i, x, N0, w, gx, gy, f, 0);
      let zm = -Infinity;
      for (let k = 0; k < K; k++) { let s = 0; const o = k * D; for (let d = 0; d < D; d++) s += Wz[o + d] * f[d]; z[k] = s; if (s > zm) zm = s; }
      let sum = 0; for (let k = 0; k < K; k++) { z[k] = Math.exp(z[k] - zm); sum += z[k]; }
      for (let k = 0; k < K; k++) A[k][i] = z[k] / sum;
    }
    for (let k = 0; k < K - 1; k++) {
      const m = maps[TEACH_CLASSES[k]], a = A[k];
      if (m) for (let i = 0; i < N; i++) m[i] = 0.2 * m[i] + 0.8 * a[i];
    }
  } else if (onlyZones && zones.length) {
    for (const n of ["window", "wall", "onwall", "tree"]) maps[n]?.fill(0);
  }
  const zoneInfo = pz ? { id: pz.zone.id, match: pz.match, d: pz.d, tau: pz.tau } : null;

  if (flip) for (const n of names) {               // deshace el espejo
    const m = maps[n];
    for (let y = 0; y < gh; y++) { const r = y * gw; for (let i = 0; i < gw >> 1; i++) { const a = m[r + i]; m[r + i] = m[r + gw - 1 - i]; m[r + gw - 1 - i] = a; } }
  }
  self.postMessage({ type: "result", id, epoch, gw, gh, maps, zone: zoneInfo, teach: !!teach, ms: performance.now() - t0 }, names.map(n => maps[n].buffer));
}
