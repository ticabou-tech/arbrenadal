// Modo "Enseñar": el usuario pinta sobre una foto qué es cada cosa y la IA aprende a
// reconocer mejor los elementos de ese sitio. El entrenamiento se hace en el worker;
// aquí está la interfaz de pintar, el paso de la pintura a etiquetas y la persistencia.
import { TEACH_UI } from "./config.js";
import { kv } from "./store.js";

const $ = id => document.getElementById(id);
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const PALETTE = TEACH_UI.map(c => hex(c.color));

export class Teacher {
  // api: { post(msg, transfer), capture(): Promise<{ image, gw, gh }>, toast(msg), done() }
  constructor(api) {
    this.api = api;
    this.cls = 0; this.eraser = false; this.strokes = []; this.cur = null;
    this.photo = $("teach-photo"); this.paint = $("teach-paint");
    this.buildPalette();
    $("teach").onclick = () => this.open();
    $("teach-cancel").onclick = () => this.close();
    $("teach-undo").onclick = () => { this.strokes.pop(); this.redraw(); };
    $("teach-eraser").onclick = () => this.setEraser(!this.eraser);
    $("teach-train").onclick = () => this.train();
    $("teach-forget").onclick = () => this.forget();
    $("fx-learned").onchange = e => this.api.post({ type: "useAdapter", on: e.target.checked });
    this.bindPaint();
    addEventListener("resize", () => this.fit());
  }

  buildPalette() {
    const pal = $("teach-palette");
    TEACH_UI.forEach((c, i) => {
      const b = document.createElement("button");
      b.innerHTML = `<span class="dot" style="background:${c.color}"></span>${c.name}`;
      b.onclick = () => { this.cls = i; this.setEraser(false); };
      pal.append(b);
    });
    this.setEraser(false);
  }

  setEraser(on) {
    this.eraser = on;
    $("teach-eraser").classList.toggle("on", on);
    [...$("teach-palette").children].forEach((b, i) => b.classList.toggle("on", !on && i === this.cls));
  }

  async open() {
    if (this.busy) return;
    this.busy = true;
    $("teach").disabled = true;
    try {
      const { image, gw, gh } = await this.api.capture();
      this.grid = { gw, gh };
      for (const c of [this.photo, this.paint]) { c.width = image.width; c.height = image.height; }
      this.photo.getContext("2d").drawImage(image, 0, 0);
      this.strokes = []; this.redraw();
      $("teach-view").hidden = false;
      this.fit();
    } catch (e) {
      this.api.toast("No se pudo preparar la foto: " + e.message);
      this.api.done();
    } finally { this.busy = false; $("teach").disabled = false; }
  }

  close() { $("teach-view").hidden = true; this.api.done(); }

  // Ajusta el tamaño en pantalla de los lienzos manteniendo la proporción.
  fit() {
    if ($("teach-view").hidden) return;
    const st = $("teach-stage").getBoundingClientRect(), k = Math.min(st.width / this.photo.width, st.height / this.photo.height);
    for (const c of [this.photo, this.paint]) { c.style.width = this.photo.width * k + "px"; c.style.height = this.photo.height * k + "px"; }
  }

  bindPaint() {
    const pos = e => {
      const r = this.paint.getBoundingClientRect();
      return [(e.clientX - r.left) * this.paint.width / r.width, (e.clientY - r.top) * this.paint.height / r.height];
    };
    this.paint.addEventListener("pointerdown", e => {
      this.paint.setPointerCapture(e.pointerId);
      const k = this.paint.width / this.paint.getBoundingClientRect().width;
      this.cur = { cls: this.cls, eraser: this.eraser, size: +$("teach-size").value * k * 0.5, pts: [pos(e)] };
      this.strokes.push(this.cur); this.drawStroke(this.cur);
    });
    this.paint.addEventListener("pointermove", e => {
      if (!this.cur) return;
      this.cur.pts.push(pos(e)); this.drawStroke(this.cur, true);
    });
    const end = () => { this.cur = null; };
    this.paint.addEventListener("pointerup", end); this.paint.addEventListener("pointercancel", end);
  }

  drawStroke(s, last = false) {
    const c = this.paint.getContext("2d"), p = s.pts;
    c.globalCompositeOperation = s.eraser ? "destination-out" : "source-over";
    c.strokeStyle = c.fillStyle = TEACH_UI[s.cls].color;
    c.lineWidth = s.size; c.lineCap = c.lineJoin = "round";
    c.beginPath();
    if (p.length === 1) { c.arc(p[0][0], p[0][1], s.size / 2, 0, 7); c.fill(); }
    else {
      const a = last ? p[p.length - 2] : p[0];
      c.moveTo(...a);
      for (const q of last ? [p[p.length - 1]] : p.slice(1)) c.lineTo(...q);
      c.stroke();
    }
    c.globalCompositeOperation = "source-over";
  }

  redraw() {
    this.paint.getContext("2d").clearRect(0, 0, this.paint.width, this.paint.height);
    for (const s of this.strokes) this.drawStroke(s);
  }

  // Pintura → una etiqueta por celda de la rejilla del modelo (voto de 9 puntos).
  labels() {
    const { gw, gh } = this.grid, W = this.paint.width, H = this.paint.height;
    const px = this.paint.getContext("2d").getImageData(0, 0, W, H).data;
    const out = new Int8Array(gw * gh).fill(-1);
    let n = 0;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const votes = new Array(PALETTE.length).fill(0);
      for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.2, 0.5, 0.8]) {
        const x = Math.min(W - 1, ((gx + fx) * W / gw) | 0), y = Math.min(H - 1, ((gy + fy) * H / gh) | 0), i = (y * W + x) * 4;
        if (px[i + 3] < 200) continue;
        let best = -1, bd = 80 * 80;
        PALETTE.forEach(([r, g, b], k) => { const d = (px[i] - r) ** 2 + (px[i + 1] - g) ** 2 + (px[i + 2] - b) ** 2; if (d < bd) { bd = d; best = k; } });
        if (best >= 0) votes[best]++;
      }
      const k = votes.indexOf(Math.max(...votes));
      if (votes[k] >= 5) { out[gy * gw + gx] = k; n++; }
    }
    return { labels: out, n };
  }

  async train() {
    const { labels, n } = this.labels();
    if (n < 10) { this.api.toast("Pinta un poco más (unos trazos en cada elemento)"); return; }
    $("teach-train").disabled = true; $("teach-train").textContent = "Entrenando…";
    this.api.post({ type: "train", labels }, [labels.buffer]);
  }

  // Mensajes del worker relacionados con el aprendizaje.
  onMessage(data, modelId) {
    if (data.type === "trainprogress") $("teach-train").textContent = `Entrenando… ${Math.round(data.progress * 100)} %`;
    else if (data.type === "trained") {
      $("teach-train").disabled = false; $("teach-train").textContent = "Entrenar";
      kv("adapter:" + modelId, { D: data.D, X: data.X, y: data.y });
      $("learned-chip").hidden = false; $("fx-learned").checked = true;
      this.api.post({ type: "useAdapter", on: true });
      this.api.toast(`Aprendido: ${Math.round(data.acc * 100)} % de acierto con ${data.n} muestras. Puedes enseñarle más fotos.`);
      this.close();
    } else if (data.type === "adapterloaded" && data.ok) {
      $("learned-chip").hidden = false;
      this.api.post({ type: "useAdapter", on: $("fx-learned").checked });
      this.api.toast(`Usando lo aprendido (${data.n} muestras)`);
    }
  }

  onError(msg) {
    $("teach-train").disabled = false; $("teach-train").textContent = "Entrenar";
    this.api.toast("No se pudo entrenar: " + msg);
  }

  // Al cargar un modelo, restaura lo aprendido para ese modelo (si lo hay).
  async restore(modelId) {
    $("learned-chip").hidden = true;
    const a = await kv("adapter:" + modelId);
    if (a?.y?.length) this.api.post({ type: "adapter", D: a.D, X: a.X, y: a.y });
  }

  async forget() {
    if (!confirm("¿Olvidar todo lo que ha aprendido la IA en este dispositivo?")) return;
    this.api.post({ type: "forget" });
    await kv("adapter:" + this.api.modelId(), null);
    $("learned-chip").hidden = true;
    this.api.toast("Se ha olvidado lo aprendido");
    this.close();
  }
}
