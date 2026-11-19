// Navidad AR — detecta ventanas, árboles y paredes con segmentación semántica
// (SegFormer entrenado en ADE20K) y los decora con efectos navideños.
import { pipeline, RawImage } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const CONFIG = {
  model: "Xenova/segformer-b0-finetuned-ade-512-512",
  analysisWidth: 256,   // ancho al que se analiza cada fotograma
  inferPause: 40,       // ms de descanso entre inferencias (deja respirar a la CPU/GPU)
  ema: 0.45,            // peso del fotograma nuevo en el suavizado temporal (0..1)
  minArea: 0.004,       // área mínima (fracción de la imagen) para considerar un árbol
  // Etiquetas de ADE20K: "windowpane", "tree", "palm", "wall", "building", "house"
  classes: {
    window: /window/i,
    tree: /^(tree|palm)\b/i,
    wall: /^(wall|building|house)\b/i,
  },
};
const COLORS = { window: [80, 160, 255], tree: [60, 200, 90], wall: [255, 160, 60] };
const LIGHTS = ["#ff3b3b", "#ffd54a", "#4ade80", "#4fc3f7", "#ff7ad9", "#ffffff"];
const BAUBLES = ["#d32f2f", "#ffc107", "#1976d2", "#8e24aa", "#e0e0e0"];

// ---------------------------------------------------------------------------
// Estado y elementos
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const video = $("video"), out = $("out"), ctx = out.getContext("2d");
const statusEl = $("status");
const fx = { window: $("fx-window"), tree: $("fx-tree"), wall: $("fx-wall"), debug: $("fx-debug") };

const mkCanvas = (w = 1, h = 1) => Object.assign(document.createElement("canvas"), { width: w, height: h });
const cap = mkCanvas(), cctx = cap.getContext("2d", { willReadFrequently: true });
const layer = mkCanvas(), lctx = layer.getContext("2d");

let W = 0, H = 0;            // tamaño del vídeo (y del lienzo de salida)
let seg = null, backend = "";
let stream = null, facing = "environment";
let running = false, paused = false;
let inferMs = 0;

const masks = {};            // nombre -> Mask
const scene = { frost: null, trees: [], stars: [], decor: [], wallEdge: [] };

const setStatus = txt => { statusEl.textContent = txt; };

// ---------------------------------------------------------------------------
// Máscaras suavizadas en el tiempo
// ---------------------------------------------------------------------------
class Mask {
  constructor(w, h, color) {
    this.w = w; this.h = h; this.color = color;
    this.v = new Float32Array(w * h);           // probabilidad suavizada 0..1
    this.bin = new Uint8Array(w * h);           // v >= 0.5
    this.cv = mkCanvas(w, h);
    this.cx = this.cv.getContext("2d");
    this.img = this.cx.createImageData(w, h);
    this.px = new Uint32Array(this.img.data.buffer);
    this.coverage = 0;
  }

  update(frame) {                                // frame: Uint8Array 0/1 o null
    const a = CONFIG.ema, b = 1 - a, v = this.v, bin = this.bin;
    let n = 0;
    for (let i = 0; i < v.length; i++) {
      v[i] = v[i] * b + (frame ? frame[i] * a : 0);
      n += bin[i] = v[i] >= 0.5 ? 1 : 0;
    }
    this.coverage = n / v.length;
    // Lienzo coloreado con alfa suave: al escalarlo, los bordes quedan difuminados.
    const [r, g, bl] = this.color, rgb = (bl << 16) | (g << 8) | r;
    for (let i = 0; i < v.length; i++) {
      const s = smoothstep(0.3, 0.7, v[i]);
      this.px[i] = ((s * 255) << 24) | rgb;
    }
    this.cx.putImageData(this.img, 0, 0);
  }

  get active() { return this.coverage > 0.002; }
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// Desenfoque de caja separable (para calcular la distancia aproximada al borde).
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), dst = new Float32Array(w * h), k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * k;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * k;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Análisis de la escena (se ejecuta tras cada inferencia, no en cada fotograma)
// ---------------------------------------------------------------------------

// Ventanas: escarcha más intensa cerca de los bordes del cristal.
function analyzeWindow(m) {
  if (!scene.frost || scene.frost.width !== m.w || scene.frost.height !== m.h) scene.frost = mkCanvas(m.w, m.h);
  const blur = boxBlur(m.v, m.w, m.h, Math.max(2, Math.round(m.w / 40)));
  const c = scene.frost.getContext("2d"), img = c.createImageData(m.w, m.h), px = new Uint32Array(img.data.buffer);
  for (let i = 0; i < blur.length; i++) {
    const inside = smoothstep(0.3, 0.7, m.v[i]);
    const edge = inside * Math.min(1, Math.max(0, (1 - blur[i]) * 2.2));
    px[i] = ((edge * 230) << 24) | 0xfffaf2;     // blanco azulado (ABGR)
  }
  c.putImageData(img, 0, 0);
}

// Árboles: componentes conexas -> estrella por árbol + luces y bolas repartidas.
function analyzeTree(m) {
  const { w, h, bin } = m, labels = new Int32Array(w * h), comps = [];
  const stack = [];
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || labels[i]) continue;
    const id = comps.length + 1;
    const c = { id, area: 0, minX: w, maxX: 0, minY: h, maxY: 0, topSum: 0, topN: 0 };
    stack.push(i); labels[i] = id;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      c.area++;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y > c.maxY) c.maxY = y;
      if (y < c.minY) { c.minY = y; c.topSum = 0; c.topN = 0; }
      if (y <= c.minY + 1) { c.topSum += x; c.topN++; }
      if (x > 0 && bin[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && bin[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && bin[p - w] && !labels[p - w]) { labels[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && bin[p + w] && !labels[p + w]) { labels[p + w] = id; stack.push(p + w); }
    }
    comps.push(c);
  }
  const big = new Set(comps.filter(c => c.area >= CONFIG.minArea * w * h).map(c => c.id));
  scene.trees = comps.filter(c => big.has(c.id));

  // Estrellas: emparejadas con las del análisis anterior para que no salten.
  const prev = scene.stars, next = [];
  for (const c of scene.trees) {
    const x = (c.topSum / c.topN + 0.5) / w, y = (c.minY + 0.5) / h;
    const size = (c.maxX - c.minX + 1) / w;
    let best = null, bd = 0.15;
    for (const s of prev) { const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = s; } }
    next.push(best
      ? { x: best.x * 0.6 + x * 0.4, y: best.y * 0.6 + y * 0.4, size: best.size * 0.7 + size * 0.3, rot: best.rot }
      : { x, y, size, rot: Math.random() * 6 });
  }
  scene.stars = next;

  // Decoraciones en una rejilla con jitter estable: reparto uniforme sin parpadeos.
  const g = Math.max(3, Math.round(w / 36)), decor = [];
  for (let cy = 0; cy * g < h; cy++) for (let cx = 0; cx * g < w; cx++) {
    const hh = hash(cx, cy), x = cx * g + (hh % g), y = cy * g + ((hh >>> 8) % g);
    if (x >= w || y >= h || !big.has(labels[y * w + x])) continue;
    const comp = scene.trees.find(c => c.id === labels[y * w + x]);
    if (y < comp.minY + (comp.maxY - comp.minY) * 0.06) continue;   // deja sitio a la estrella
    const r = (hh >>> 16) % 100;
    const kind = r < 50 ? "light" : r < 66 ? "bauble" : null;
    if (!kind) continue;
    decor.push({ kind, x: (x + 0.5) / w, y: (y + 0.5) / h, c: (hh >>> 4) % 6, p: (hh % 628) / 100 });
  }
  scene.decor = decor;
}

// Paredes: borde superior de la pared, filtrado en el espacio y en el tiempo.
function analyzeWall(m) {
  const { w, h, bin } = m, step = Math.max(2, Math.round(w / 48)), raw = [];
  for (let x = 0; x < w; x += step) {
    let y = -1;
    for (let yy = 0; yy < h - 3; yy++) {
      if (bin[yy * w + x] && bin[(yy + 1) * w + x] && bin[(yy + 2) * w + x] && bin[(yy + 3) * w + x]) { y = yy; break; }
    }
    raw.push(y < 0 || y > h * 0.85 ? null : { x: (x + 0.5) / w, y: y / h });
  }
  // Mediana de 5 para quitar picos.
  const med = raw.map((p, i) => {
    if (!p) return null;
    const ys = raw.slice(Math.max(0, i - 2), i + 3).filter(Boolean).map(q => q.y).sort((a, b) => a - b);
    return { x: p.x, y: ys[ys.length >> 1] };
  });
  const prev = scene.wallEdge;
  scene.wallEdge = med.map((p, i) => {
    if (!p) return null;
    const q = prev.length === med.length ? prev[i] : null;
    return q ? { x: p.x, y: q.y * 0.6 + p.y * 0.4 } : p;
  });
}

// ---------------------------------------------------------------------------
// Sprites pre-renderizados (mucho más rápidos que shadowBlur en móviles)
// ---------------------------------------------------------------------------
const SPR = 64;
function glowSprite(color) {
  const c = mkCanvas(SPR, SPR), x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "#fff"); g.addColorStop(0.15, color); g.addColorStop(0.4, color + "88"); g.addColorStop(1, color + "00");
  x.fillStyle = g; x.fillRect(0, 0, SPR, SPR); return c;
}
function baubleSprite(color) {
  const c = mkCanvas(SPR, SPR), x = c.getContext("2d");
  const g = x.createRadialGradient(24, 22, 2, 32, 34, 28);
  g.addColorStop(0, "#fff"); g.addColorStop(0.25, color); g.addColorStop(1, "#000");
  x.fillStyle = g; x.beginPath(); x.arc(32, 36, 24, 0, 7); x.fill();
  x.fillStyle = "#c9a227"; x.fillRect(27, 6, 10, 8);
  return c;
}
function starSprite() {
  const c = mkCanvas(128, 128), x = c.getContext("2d");
  const halo = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  halo.addColorStop(0, "rgba(255,230,120,.9)"); halo.addColorStop(0.35, "rgba(255,200,60,.35)"); halo.addColorStop(1, "rgba(255,200,60,0)");
  x.fillStyle = halo; x.fillRect(0, 0, 128, 128);
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 16 : 40, a = -Math.PI / 2 + i * Math.PI / 5;
    x.lineTo(64 + r * Math.cos(a), 64 + r * Math.sin(a));
  }
  x.closePath();
  const g = x.createLinearGradient(30, 24, 98, 104);
  g.addColorStop(0, "#fff6c2"); g.addColorStop(0.5, "#ffd54a"); g.addColorStop(1, "#e09b00");
  x.fillStyle = g; x.fill(); x.strokeStyle = "#fff3"; x.lineWidth = 2; x.stroke();
  return c;
}
function flakeSprite(crystal) {
  const c = mkCanvas(SPR, SPR), x = c.getContext("2d");
  if (!crystal) {
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "#fff"); g.addColorStop(0.5, "rgba(255,255,255,.8)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, SPR, SPR); return c;
  }
  x.strokeStyle = "#fff"; x.lineWidth = 3; x.lineCap = "round"; x.translate(32, 32);
  for (let i = 0; i < 6; i++) {
    x.beginPath(); x.moveTo(0, 0); x.lineTo(0, -26);
    x.moveTo(0, -14); x.lineTo(-7, -21); x.moveTo(0, -14); x.lineTo(7, -21); x.stroke();
    x.rotate(Math.PI / 3);
  }
  return c;
}
function bowSprite() {
  const c = mkCanvas(SPR, SPR), x = c.getContext("2d");
  x.fillStyle = "#d32f2f"; x.strokeStyle = "#7f0000"; x.lineWidth = 2;
  x.beginPath(); x.moveTo(32, 26); x.lineTo(6, 12); x.lineTo(8, 40); x.closePath(); x.fill(); x.stroke();
  x.beginPath(); x.moveTo(32, 26); x.lineTo(58, 12); x.lineTo(56, 40); x.closePath(); x.fill(); x.stroke();
  x.beginPath(); x.moveTo(30, 28); x.lineTo(20, 60); x.lineTo(28, 56); x.lineTo(32, 30); x.fill();
  x.beginPath(); x.moveTo(34, 28); x.lineTo(44, 60); x.lineTo(36, 56); x.lineTo(32, 30); x.fill();
  x.beginPath(); x.arc(32, 27, 7, 0, 7); x.fill(); x.stroke();
  return c;
}
const SPRITES = {
  glow: LIGHTS.map(glowSprite),
  bauble: BAUBLES.map(baubleSprite),
  star: starSprite(),
  flake: [flakeSprite(false), flakeSprite(true)],
  bow: bowSprite(),
};

const flakes = Array.from({ length: 160 }, () => ({
  x: Math.random(), y: Math.random(), r: 0.6 + Math.random() ** 2 * 3,
  v: 0.04 + Math.random() * 0.12, p: Math.random() * 6, crystal: Math.random() < 0.18,
}));

// ---------------------------------------------------------------------------
// Dibujo (cada fotograma de pantalla)
// ---------------------------------------------------------------------------
let lastT = 0;
function drawLoop(t = 0) {
  const dt = Math.min(0.1, (t - lastT) / 1000 || 0); lastT = t;
  ctx.clearRect(0, 0, W, H);
  const u = Math.min(W, H) / 100;   // unidad de tamaño relativa a la imagen

  if (fx.window.checked && masks.window?.active) drawWindows(t, dt, u);
  if (fx.wall.checked && masks.wall?.active) drawWall(t, u);
  if (fx.tree.checked && masks.tree?.active) drawTrees(t, u);

  if (fx.debug.checked) {
    ctx.globalAlpha = 0.5;
    for (const name in masks) ctx.drawImage(masks[name].cv, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  if (running) requestAnimationFrame(drawLoop);
}

function drawWindows(t, dt, u) {
  lctx.globalCompositeOperation = "source-over";
  lctx.clearRect(0, 0, W, H);
  const tint = lctx.createLinearGradient(0, 0, 0, H);
  tint.addColorStop(0, "rgba(190,225,255,.22)"); tint.addColorStop(1, "rgba(235,245,255,.32)");
  lctx.fillStyle = tint; lctx.fillRect(0, 0, W, H);
  if (scene.frost) lctx.drawImage(scene.frost, 0, 0, W, H);
  for (const f of flakes) {
    f.y += f.v * dt; if (f.y > 1.02) { f.y = -0.02; f.x = Math.random(); }
    const s = f.r * u * (f.crystal ? 2.2 : 1.6), x = (f.x + Math.sin(t / 1200 + f.p) * 0.012) * W;
    lctx.globalAlpha = f.crystal ? 0.85 : 0.95;
    lctx.drawImage(SPRITES.flake[f.crystal ? 1 : 0], x - s / 2, f.y * H - s / 2, s, s);
  }
  lctx.globalAlpha = 1;
  lctx.globalCompositeOperation = "destination-in";
  lctx.drawImage(masks.window.cv, 0, 0, W, H);
  lctx.globalCompositeOperation = "source-over";
  ctx.drawImage(layer, 0, 0);
}

function drawTrees(t, u) {
  for (const d of scene.decor) {
    if (d.kind !== "bauble") continue;
    const s = u * 3.2;
    ctx.drawImage(SPRITES.bauble[d.c % BAUBLES.length], d.x * W - s / 2, d.y * H - s / 2, s, s);
  }
  ctx.globalCompositeOperation = "lighter";
  for (const d of scene.decor) {
    if (d.kind !== "light") continue;
    const tw = 0.5 + 0.5 * Math.sin(t / 380 + d.p * 3);
    const s = u * (2.2 + 1.6 * tw);
    ctx.globalAlpha = 0.35 + 0.65 * tw;
    ctx.drawImage(SPRITES.glow[d.c], d.x * W - s / 2, d.y * H - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  for (const st of scene.stars) {
    const s = Math.min(Math.max(st.size * W * 0.35, u * 7), u * 22) * (1 + 0.06 * Math.sin(t / 300));
    ctx.save();
    ctx.translate(st.x * W, st.y * H - s * 0.15);
    ctx.rotate(Math.sin(t / 1500 + st.rot) * 0.12);
    ctx.drawImage(SPRITES.star, -s / 2, -s / 2, s, s);
    ctx.restore();
  }
}

function drawWall(t, u) {
  // Separa el borde en tramos continuos y cuelga guirnaldas en forma de festón.
  const segs = []; let cur = [];
  for (const p of scene.wallEdge) {
    if (p) cur.push({ x: p.x * W, y: p.y * H + u * 2 });
    else if (cur.length) { segs.push(cur); cur = []; }
  }
  if (cur.length) segs.push(cur);

  let li = 0;
  for (const pts of segs) {
    if (pts.length < 3) continue;
    const anchors = pts.filter((_, i) => i % 5 === 0 || i === pts.length - 1);
    const curves = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i], b = anchors[i + 1];
      const sag = Math.hypot(b.x - a.x, b.y - a.y) * 0.28;
      curves.push([a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + sag }, b]);
    }
    // Guirnalda: trazo grueso + textura discontinua.
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const [w, col, dash] of [[u * 2.2, "#0f3d17", []], [u * 1.4, "#2e7d32", [u * 0.6, u * 0.9]], [u * 0.5, "#66bb6a", [u * 0.3, u * 1.6]]]) {
      ctx.lineWidth = w; ctx.strokeStyle = col; ctx.setLineDash(dash); ctx.beginPath();
      for (const [a, c, b] of curves) { ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Luces repartidas a lo largo de cada curva, con efecto de "persecución".
    ctx.globalCompositeOperation = "lighter";
    for (const [a, c, b] of curves) {
      const n = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / (u * 4)));
      for (let k = 1; k < n; k++, li++) {
        const s = k / n, is = 1 - s;
        const x = is * is * a.x + 2 * is * s * c.x + s * s * b.x;
        const y = is * is * a.y + 2 * is * s * c.y + s * s * b.y + u * 0.8;
        const on = 0.5 + 0.5 * Math.sin(li * 1.1 - t / 220);
        const sz = u * (2 + 1.5 * on);
        ctx.globalAlpha = 0.4 + 0.6 * on;
        ctx.drawImage(SPRITES.glow[li % LIGHTS.length], x - sz / 2, y - sz / 2, sz, sz);
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    const bs = u * 5;
    for (const a of anchors) ctx.drawImage(SPRITES.bow, a.x - bs / 2, a.y - bs * 0.45, bs, bs);
  }
}

// ---------------------------------------------------------------------------
// Inferencia (a pocos FPS, en paralelo al dibujo)
// ---------------------------------------------------------------------------
function resize() {
  W = out.width = layer.width = video.videoWidth;
  H = out.height = layer.height = video.videoHeight;
  cap.width = CONFIG.analysisWidth;
  cap.height = Math.round(CONFIG.analysisWidth * H / W);
  for (const k in masks) delete masks[k];
  scene.wallEdge = []; scene.stars = []; scene.decor = [];
}

async function inferOnce() {
  if (video.videoWidth !== W || video.videoHeight !== H) resize();
  cctx.drawImage(video, 0, 0, cap.width, cap.height);
  const t0 = performance.now();
  const res = await seg(RawImage.fromCanvas(cap));
  inferMs = inferMs ? inferMs * 0.8 + (performance.now() - t0) * 0.2 : performance.now() - t0;

  // Une todas las etiquetas que corresponden a cada clase (p. ej. "tree" + "palm").
  const frames = {}; let mw = cap.width, mh = cap.height;
  for (const r of res) {
    for (const [name, re] of Object.entries(CONFIG.classes)) {
      if (!re.test(r.label)) continue;
      const { width, height, data } = r.mask; mw = width; mh = height;
      const f = frames[name] ||= new Uint8Array(width * height);
      for (let i = 0; i < data.length; i++) if (data[i] > 127) f[i] = 1;
    }
  }
  for (const name of Object.keys(CONFIG.classes)) {
    if (!frames[name] && !masks[name]) continue;
    let m = masks[name];
    if (!m || m.w !== mw || m.h !== mh) m = masks[name] = new Mask(mw, mh, COLORS[name]);
    m.update(frames[name] || null);
    if (!m.active) continue;
    if (name === "window") analyzeWindow(m);
    else if (name === "tree") analyzeTree(m);
    else if (name === "wall") analyzeWall(m);
  }
}

async function inferLoop() {
  while (running) {
    if (paused || document.hidden || video.readyState < 2) { await sleep(200); continue; }
    try {
      await inferOnce();
      const found = Object.entries(masks).filter(([, m]) => m.active).map(([n]) => ({ window: "ventana", tree: "árbol", wall: "pared" })[n]);
      setStatus(`${backend} · ${Math.round(inferMs)} ms/análisis · ${found.length ? "Detectado: " + found.join(", ") : "Apunta a una ventana, un árbol o una pared."}`);
    } catch (e) {
      console.error(e);
      setStatus("Error al analizar: " + e.message);
      await sleep(1000);
    }
    await sleep(CONFIG.inferPause);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Cámara, modelo y botones
// ---------------------------------------------------------------------------
async function openCamera() {
  stream?.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
  });
  video.srcObject = stream;
  await video.play();
  // El vídeo de la cámara frontal se ve mejor en espejo.
  const mirror = facing === "user" ? "scaleX(-1)" : "";
  video.style.transform = out.style.transform = mirror;
  resize();
}

async function loadModel() {
  const progress = $("progress"), bar = $("bar"), files = {};
  progress.hidden = false;
  const progress_callback = p => {
    if (p.status === "progress" && p.total) {
      files[p.file] = [p.loaded, p.total];
      const [l, tt] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      bar.style.width = (100 * l / tt).toFixed(1) + "%";
      setStatus(`Descargando modelo… ${Math.round(100 * l / tt)} % (solo la primera vez)`);
    }
  };
  const warm = async s => { cctx.fillRect(0, 0, cap.width, cap.height); await s(RawImage.fromCanvas(cap)); return s; };
  if (navigator.gpu) {
    try {
      seg = await warm(await pipeline("image-segmentation", CONFIG.model, { device: "webgpu", progress_callback }));
      backend = "WebGPU";
    } catch (e) { console.warn("WebGPU no disponible, se usa WASM:", e); seg = null; }
  }
  if (!seg) {
    seg = await warm(await pipeline("image-segmentation", CONFIG.model, { progress_callback }));
    backend = "WASM";
  }
  progress.hidden = true;
}

$("start").onclick = async () => {
  const btn = $("start");
  btn.disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("este navegador no permite usar la cámara aquí (hace falta https o localhost)");
    setStatus("Abriendo cámara…");
    await openCamera();
    setStatus("Cargando modelo…");
    await loadModel();
    btn.hidden = true;
    $("actions").hidden = false;
    running = true;
    inferLoop();
    requestAnimationFrame(drawLoop);
  } catch (e) {
    console.error(e);
    const msg = e.name === "NotAllowedError" ? "Permiso de cámara denegado." :
                e.name === "NotFoundError" ? "No se ha encontrado ninguna cámara." : e.message;
    setStatus("Error: " + msg);
    $("progress").hidden = true;
    btn.disabled = false;
  }
};

$("flip").onclick = async () => {
  facing = facing === "environment" ? "user" : "environment";
  try { await openCamera(); } catch (e) { setStatus("No se pudo cambiar de cámara: " + e.message); }
};

$("pause").onclick = () => {
  paused = !paused;
  paused ? video.pause() : video.play();
  $("pause").textContent = paused ? "▶️" : "⏸️";
};

$("photo").onclick = () => {
  const snap = mkCanvas(W, H), s = snap.getContext("2d");
  if (facing === "user") { s.translate(W, 0); s.scale(-1, 1); }
  s.drawImage(video, 0, 0, W, H);
  s.drawImage(out, 0, 0);
  const flash = document.createElement("div"); flash.className = "flash";
  document.body.append(flash); setTimeout(() => flash.remove(), 400);
  snap.toBlob(async blob => {
    const name = `navidad-ar-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    const file = new File([blob], name, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Navidad AR" }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
};
