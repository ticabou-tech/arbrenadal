// Navidad AR — bucle principal: cámara, seguimiento de movimiento, análisis con IA
// (en un Web Worker) y dibujo de la decoración y la nieve.
import { CONFIG, MODELS, DTYPES, SIZES, START_SIZE, TARGET_MS } from "./config.js";
import { I, compose, scaleOf } from "./geom.js";
import { Tracker } from "./tracker.js";
import { Scene } from "./scene.js";
import { Snow } from "./snow.js";
import { drawWindows, drawTrees, drawWall, updateSwing } from "./decor.js";
import { mkCanvas } from "./sprites.js";
import { savePhoto, chooseFolder, folderSupported, folderName, listPhotos, deletePhoto, exportPhoto } from "./photos.js";

const $ = id => document.getElementById(id);
const video = $("video"), out = $("out"), ctx = out.getContext("2d");
const opt = id => $(id).checked;
const setStatus = txt => { $("status").textContent = txt; };

const tracker = new Tracker(CONFIG.trackWidth);
const scene = new Scene();
const snow = new Snow();
const cap = mkCanvas(), cctx = cap.getContext("2d", { willReadFrequently: true });
const decorCv = mkCanvas(), shadowCv = mkCanvas(), emitCv = mkCanvas();
const SHADOW_K = 0.25;              // las sombras se dibujan a 1/4 de resolución: así salen difuminadas

// Luz de la escena estimada a partir de la imagen: brillo, tono y de qué lado viene.
const light = { lum: 0.6, tint: [1, 1, 1], dir: [0, -1] };
let vel = 0, accel = 0;             // velocidad/aceleración horizontal de la cámara (px/s)

let W = 0, H = 0, G = I();          // G: mundo → pantalla (píxeles de vídeo)
let stream = null, facing = "environment";
let worker = null, workerReady = false, busy = false, pendingG = null, pendingGray = null, inferMs = 0, backend = "", modelName = "", dtype = "";
let sizeIdx = SIZES.indexOf(START_SIZE.fast), flip = false, sizeCooldown = 0;
let running = false, paused = false, lastT = 0, epoch = 0;

// ---------------------------------------------------------------------------
// Cámara
// ---------------------------------------------------------------------------
async function openCamera() {
  stream?.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false,
  });
  video.srcObject = stream;
  await video.play();
  const mirror = facing === "user" ? "scaleX(-1)" : "";
  video.style.transform = out.style.transform = mirror;
  resize();
}

function resize() {
  W = out.width = decorCv.width = emitCv.width = video.videoWidth; H = out.height = decorCv.height = emitCv.height = video.videoHeight;
  shadowCv.width = Math.round(W * SHADOW_K); shadowCv.height = Math.round(H * SHADOW_K);
  G = I(); epoch++;                 // descarta análisis en curso de la vista anterior
  tracker.reset(); scene.reset(W, H); snow.resize(W, H);
}

// Seguimiento: una vez por fotograma de la cámara.
function onVideoFrame() {
  if (running && !paused && W) {
    if (video.videoWidth !== W || video.videoHeight !== H) resize();
    const M = tracker.update(video, W, H);
    G = compose(M, G);
    snow.onMotion(M);
    const now = performance.now(), fdt = Math.max(0.01, (now - (onVideoFrame.t || now - 33)) / 1000); onVideoFrame.t = now;
    const v = -M.tx / fdt;          // el mundo se mueve al revés que la cámara
    accel = accel * 0.5 + ((v - vel) / fdt) * 0.5; vel = v;
    // Si el zoom acumulado se dispara (se ha caminado mucho), se reinicia el mundo.
    const s = scaleOf(G);
    if (s > 4 || s < 0.25) resize();
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onVideoFrame);
}
let lastVideoTime = -1;
function pollVideoFrame() {          // alternativa si no existe requestVideoFrameCallback
  if (video.currentTime !== lastVideoTime) { lastVideoTime = video.currentTime; onVideoFrame(); }
}

// ---------------------------------------------------------------------------
// Modelo (Web Worker)
// ---------------------------------------------------------------------------
// ¿Hay de verdad una GPU utilizable? (navigator.gpu puede existir sin adaptador.)
async function probeGPU() {
  try {
    const a = await navigator.gpu?.requestAdapter();
    return a ? { gpu: true, f16: a.features.has("shader-f16") } : { gpu: false };
  } catch { return { gpu: false }; }
}

// Prueba configuraciones de mejor a peor, cada una en un worker nuevo.
async function startWorker(quality, noGPU = false) {
  worker?.terminate(); worker = null;
  workerReady = false; busy = false;
  const { gpu, f16 } = noGPU ? { gpu: false } : await probeGPU();
  const models = quality === "precise" ? [MODELS.precise, MODELS.fast] : [MODELS.fast];
  const tries = [];
  for (const model of models) {
    if (gpu) for (const dtype of DTYPES.webgpu) if (dtype !== "fp16" || f16) tries.push({ model, device: "webgpu", dtype });
    for (const dtype of DTYPES.wasm) tries.push({ model, device: "wasm", dtype });
  }
  let lastErr;
  for (const cfg of tries) {
    try { await loadWorker(cfg, quality); return; }
    catch (e) { lastErr = e; console.warn(`No se pudo usar ${cfg.model} (${cfg.device}, ${cfg.dtype}):`, e.message); worker?.terminate(); worker = null; }
  }
  throw new Error("no se pudo cargar el modelo de IA" + (lastErr ? ` (${lastErr.message})` : ""));
}

function loadWorker(cfg, quality) {
  const w = worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const files = {}, bar = $("bar"), progress = $("progress");
  progress.hidden = false;
  return new Promise((resolve, reject) => {
    w.onmessage = ({ data }) => {
      if (w !== worker) return;
      if (data.type === "progress" && data.total) {
        files[data.file] = [data.loaded, data.total];
        const [l, tt] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
        bar.style.width = (100 * l / tt).toFixed(1) + "%";
        setStatus(`Descargando modelo… ${Math.round(100 * l / tt)} % (solo la primera vez)`);
      } else if (data.type === "ready") {
        workerReady = true; backend = data.backend; dtype = data.dtype; inferMs = 0;
        modelName = data.model.includes("b2") ? "preciso" : "rápido";
        sizeIdx = SIZES.indexOf(START_SIZE[data.model.includes("b2") ? "precise" : "fast"]);
        if (quality === "precise" && !data.model.includes("b2")) setTimeout(() => toast("El modelo preciso no está disponible en este dispositivo: se usa el rápido"), 500);
        progress.hidden = true; resolve();
      } else if (data.type === "result") {
        busy = false;
        if (data.epoch !== epoch) return;
        inferMs = inferMs ? inferMs * 0.8 + data.ms * 0.2 : data.ms;
        adaptSize(data.ms); inferErrors = 0;
        scene.ingest(data, pendingG, pendingGray);
      } else if (data.type === "error") {
        busy = false;
        if (data.during === "load") { progress.hidden = true; reject(new Error(data.message)); }
        else onInferError(data.message);
      }
    };
    w.onerror = e => { e.preventDefault?.(); progress.hidden = true; reject(new Error(e.message || "no se pudo iniciar el worker")); };
    setStatus(`Cargando modelo (${cfg.device === "webgpu" ? "GPU" : "CPU"}, ${cfg.dtype})…`);
    w.postMessage({ type: "load", ...cfg });
  });
}

// Si el análisis falla varias veces seguidas (p. ej. falta de memoria con una entrada
// grande), se baja la resolución; si aun así falla, se recarga el modelo con otra configuración.
let inferErrors = 0;
function onInferError(msg) {
  console.error(msg);
  inferErrors++;
  if (sizeIdx > 0) { sizeIdx--; sizeCooldown = 20; }
  setStatus("Error al analizar: " + msg + " — reintentando");
  if (inferErrors >= 4) {
    inferErrors = 0;
    startWorker($("quality").value).catch(e => setStatus("Error: " + e.message));
  }
}

// Resolución adaptativa: sube o baja el tamaño de entrada para mantener ~TARGET_MS por
// análisis. Con el seguimiento de movimiento, la animación va fluida aunque el modelo
// sea lento; esto mantiene además la detección al día.
let slowCount = 0;
function adaptSize(ms) {
  // Muy lento: baja ya, sin esperar. Si con la entrada mínima la GPU sigue siendo muy
  // lenta (GPU débil), se cambia a la CPU.
  if (ms > TARGET_MS * 4 && sizeIdx > 0) { sizeIdx--; sizeCooldown = 3; return; }
  if (backend === "WebGPU" && sizeIdx === 0 && ms > 1200) {
    if (++slowCount >= 3) {
      slowCount = 0; toast("La GPU de este dispositivo es lenta: se usa la CPU");
      startWorker($("quality").value, true).catch(e => setStatus("Error: " + e.message));
    }
    return;
  }
  slowCount = 0;
  if (--sizeCooldown > 0) return;
  if (ms > TARGET_MS * 1.35 && sizeIdx > 0) { sizeIdx--; sizeCooldown = 6; }
  else if (inferMs < TARGET_MS * 0.6 && sizeIdx < SIZES.length - 1) { sizeIdx++; sizeCooldown = 10; }
}

function requestInference() {
  if (!workerReady || busy || paused || document.hidden || video.readyState < 2) return;
  busy = true;
  const w = SIZES[sizeIdx], h = Math.max(128, Math.round(w * H / W / 32) * 32);
  if (cap.width !== w || cap.height !== h) { cap.width = w; cap.height = h; }
  cctx.drawImage(video, 0, 0, w, h);
  const img = cctx.getImageData(0, 0, w, h);
  pendingG = { ...G };              // posición de la cámara en el momento de la captura
  // Copia en grises para ajustar los bordes de ventanas y paredes a las líneas de la imagen.
  const gray = new Uint8Array(w * h), d = img.data;
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  pendingGray = { w, h, data: gray };
  estimateLight(img);
  flip = !flip;                     // alterna imagen normal / espejo: se fusionan en el tiempo
  const e = epoch;
  worker.postMessage({ type: "infer", id: e, epoch: e, width: w, height: h, flip, buffer: img.data.buffer }, [img.data.buffer]);
}

function estimateLight({ data, width: w, height: h }) {
  let r = 0, g = 0, b = 0, L = 0, Rr = 0, T = 0, Bt = 0, n = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    const i = (y * w + x) * 4, l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    if (x < w / 2) L += l; else Rr += l;
    if (y < h / 2) T += l; else Bt += l;
  }
  const lum = (r * 0.299 + g * 0.587 + b * 0.114) / n / 255, m = (r + g + b) / 3 || 1;
  const k = 0.15;
  light.lum += (lum - light.lum) * k;
  light.tint = light.tint.map((v, i) => v + ([r, g, b][i] / m - v) * k);
  // La luz viene del lado más brillante (con preferencia por "desde arriba").
  const dx = (Rr - L) / (Rr + L + 1), dy = (Bt - T) / (Bt + T + 1) - 0.25, d = Math.hypot(dx, dy) || 1;
  light.dir = [light.dir[0] + (dx / d - light.dir[0]) * k, light.dir[1] + (dy / d - light.dir[1]) * k];
}

// Ajusta la exposición y el tono de los adornos "materiales" a la luz de la escena.
function grade(c) {
  const night = opt("fx-night");
  const amb = Math.min(1, Math.max(0.3, (light.lum - 0.05) * 1.7)) * (night ? 0.6 : 1);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = "source-atop";
  c.fillStyle = `rgba(0,0,0,${(1 - amb).toFixed(3)})`; c.fillRect(0, 0, W, H);
  const [tr, tg, tb] = light.tint.map(v => Math.round(Math.min(255, 200 * v)));
  c.fillStyle = `rgba(${tr},${tg},${tb},0.10)`; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = "source-over";
}

// ---------------------------------------------------------------------------
// Dibujo
// ---------------------------------------------------------------------------
function frame(t) {
  if (!running) return;
  requestAnimationFrame(frame);
  if (!video.requestVideoFrameCallback) pollVideoFrame();
  requestInference();
  const dt = Math.min(0.1, (t - lastT) / 1000 || 0); lastT = t;
  if (paused) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, W, H);

  const indoor = scene.indoor > 0.5, outdoor = scene.ready && !indoor;
  const opts = { warm: opt("fx-warm"), outdoor, windowLights: true };

  if (opt("fx-night")) { ctx.fillStyle = "rgba(4,10,28,.45)"; ctx.fillRect(0, 0, W, H); }

  if (opt("fx-snow")) { snow.update(dt, t, scene, G, outdoor); snow.drawFar(ctx, scene, G, indoor); }
  if (scene.ready) {
    // Capas: adornos (d), sombras (s) y luz emitida (e).
    const d = decorCv.getContext("2d"), sh = shadowCv.getContext("2d"), e = emitCv.getContext("2d");
    d.setTransform(1, 0, 0, 1, 0, 0); d.clearRect(0, 0, W, H);
    e.setTransform(1, 0, 0, 1, 0, 0); e.globalAlpha = 1; e.globalCompositeOperation = "source-over"; e.clearRect(0, 0, W, H);
    e.globalCompositeOperation = "lighter";                // la luz se suma
    sh.setTransform(1, 0, 0, 1, 0, 0); sh.globalCompositeOperation = "source-over"; sh.clearRect(0, 0, shadowCv.width, shadowCv.height);
    sh.setTransform(SHADOW_K, 0, 0, SHADOW_K, 0, 0); sh.fillStyle = sh.strokeStyle = "#000";
    const u = Math.min(W, H) / 100, dark = Math.min(1, Math.max(0, (0.45 - light.lum) * 2.5) + (opt("fx-night") ? 0.6 : 0));
    const R = { d, s: sh, e, sh: [-light.dir[0] * u * 1.6, -light.dir[1] * u * 1.6 + u * 0.6], lightDir: light.dir, dark };
    updateSwing(dt, accel);
    if (opt("fx-wall")) drawWall(R, scene, G, t, opts);
    if (opt("fx-window")) drawWindows(R, scene, G, t, opts);
    if (opt("fx-tree")) drawTrees(R, scene, G, t, dt, opts);
    // Componer: sombras (difuminadas) → adornos con la luz de la escena → luz emitida encima.
    sh.setTransform(1, 0, 0, 1, 0, 0); sh.globalCompositeOperation = "source-in"; sh.globalAlpha = 1;
    sh.fillStyle = "rgb(10,14,30)"; sh.fillRect(0, 0, shadowCv.width, shadowCv.height);
    grade(d);
    ctx.globalAlpha = 0.42 + 0.25 * (1 - light.lum); ctx.drawImage(shadowCv, 0, 0, W, H); ctx.globalAlpha = 1;
    ctx.drawImage(decorCv, 0, 0);
    ctx.globalCompositeOperation = "lighter"; ctx.drawImage(emitCv, 0, 0); ctx.globalCompositeOperation = "source-over";
  }
  if (opt("fx-snow")) snow.drawNear(ctx, scene, G, indoor);

  if (opt("fx-debug") && scene.ready) {
    ctx.save(); ctx.globalAlpha = 0.45; ctx.setTransform(...scene.gridMatrix(G));
    for (const n of ["sky", "solid", "tree", "window"]) ctx.drawImage(scene.cv[n], 0, 0);
    ctx.restore();
    ctx.strokeStyle = "#4fc3f7"; ctx.lineWidth = 3;
    for (const w of scene.windows) {
      ctx.beginPath();
      w.pts.forEach(([x, y], i) => { const px = G.a * x - G.b * y + G.tx, py = G.b * x + G.a * y + G.ty; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.closePath(); ctx.stroke();
    }
  }
  updateStatus(t);
}

let lastStatus = 0;
function updateStatus(t) {
  if (t - lastStatus < 500) return;
  lastStatus = t;
  if (!scene.ready) { setStatus(`${backend} · analizando…`); return; }
  const c = scene.coverage, found = [];
  if (scene.windows.some(w => !w.miss)) found.push("ventana"); else if (c.window > 0.01) found.push("ventana (?)");
  if (scene.trees.some(tr => !tr.miss)) found.push("árbol");
  if (scene.garland.size) found.push("pared");
  const where = scene.indoor > 0.5 ? "interior" : "exterior";
  const track = tracker.quality > 0.25 ? "seguimiento OK" : "poca textura para seguir";
  setStatus(`${backend} ${dtype} (${modelName}, ${SIZES[sizeIdx]} px) · ${Math.round(inferMs)} ms · ${where} · ${track} · ${found.length ? found.join(", ") : "apunta a una ventana, un árbol o una pared"}`);
}

// ---------------------------------------------------------------------------
// Botones
// ---------------------------------------------------------------------------
$("start").onclick = async () => {
  const btn = $("start");
  btn.disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("este navegador no permite usar la cámara aquí (hace falta https o localhost)");
    setStatus("Abriendo cámara…");
    await openCamera();
    setStatus("Cargando modelo…");
    await startWorker($("quality").value);
    btn.hidden = true;
    $("actions").hidden = false;
    running = true;
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onVideoFrame);
    requestAnimationFrame(frame);
  } catch (e) {
    console.error(e);
    const msg = e.name === "NotAllowedError" ? "Permiso de cámara denegado." :
                e.name === "NotFoundError" ? "No se ha encontrado ninguna cámara." : e.message;
    setStatus("Error: " + msg);
    btn.disabled = false;
  }
};

$("quality").onchange = async () => {
  if (!running) return;
  setStatus("Cambiando de modelo…");
  try { await startWorker($("quality").value); } catch (e) { setStatus("Error: " + e.message); }
};

$("flip").onclick = async () => {
  facing = facing === "environment" ? "user" : "environment";
  try { await openCamera(); } catch (e) { setStatus("No se pudo cambiar de cámara: " + e.message); }
};

$("pause").onclick = () => {
  paused = !paused;
  if (paused) video.pause(); else { video.play(); tracker.reset(); }
  $("pause").textContent = paused ? "▶️" : "⏸️";
};

// La imagen se codifica de forma síncrona para que el guardado empiece dentro del
// mismo toque del usuario (los navegadores solo dejan pedir permisos durante el toque).
function dataURLToBlob(url) {
  const [head, b64] = url.split(","), bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: head.match(/:(.*?);/)[1] });
}

$("photo").onclick = async () => {
  const snap = mkCanvas(W, H), s = snap.getContext("2d");
  if (facing === "user") { s.translate(W, 0); s.scale(-1, 1); }
  s.drawImage(video, 0, 0, W, H);
  s.drawImage(out, 0, 0);
  const blob = dataURLToBlob(snap.toDataURL("image/jpeg", 0.92));
  const flash = document.createElement("div"); flash.className = "flash";
  document.body.append(flash); setTimeout(() => flash.remove(), 400);
  try { toast(await savePhoto(blob)); }
  catch (e) { console.error(e); toast("No se pudo guardar la foto: " + e.message); }
};

// Galería de fotos guardadas en la app.
$("gallery").onclick = () => openGallery();
$("gallery-close").onclick = () => { $("gallery-view").hidden = true; };
let galleryUrls = [];
async function openGallery() {
  const grid = $("gallery-grid");
  galleryUrls.forEach(u => URL.revokeObjectURL(u)); galleryUrls = [];
  grid.replaceChildren();
  const photos = await listPhotos();
  $("gallery-empty").hidden = photos.length > 0;
  for (const { name, file } of photos) {
    const url = URL.createObjectURL(file); galleryUrls.push(url);
    const fig = document.createElement("figure");
    const img = Object.assign(document.createElement("img"), { src: url, alt: name, loading: "lazy" });
    const save = Object.assign(document.createElement("button"), { textContent: "💾 Guardar", title: "Guardar en el dispositivo" });
    const del = Object.assign(document.createElement("button"), { textContent: "🗑️", title: "Borrar de la galería" });
    save.onclick = async () => { try { const w = await exportPhoto(file, name); if (w) toast(`Foto guardada ${w}`); } catch (e) { toast("No se pudo guardar: " + e.message); } };
    del.onclick = async () => { await deletePhoto(name); fig.remove(); if (!grid.children.length) $("gallery-empty").hidden = false; };
    const bar = document.createElement("div"); bar.append(save, del);
    fig.append(img, bar); grid.append(fig);
  }
  $("gallery-view").hidden = false;
}

$("folder").onclick = async () => {
  try { const name = await chooseFolder(); if (name) toast(`Las fotos se guardarán en «${name}»`); }
  catch (e) { if (e.name !== "AbortError") toast("No se pudo usar la carpeta: " + e.message); }
};
if (!folderSupported) $("folder").hidden = true;
else folderName().then(n => { if (n) $("folder").title = `Carpeta de fotos: ${n}`; });

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) tracker.reset(); });
