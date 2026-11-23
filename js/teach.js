// Modo "Enseñar" por ZONAS: el usuario pinta sobre fotos qué es cada cosa en cada uno
// de sus sitios (patio, fachada, salón…). Cada zona tiene su propio clasificador y sus
// huellas; la app reconoce sola en qué zona está y usa su entrenamiento. Opcionalmente
// solo decora dentro de las zonas entrenadas. El entrenamiento se guarda en el
// dispositivo y se puede compartir (enlace, archivo, o publicado en la web).
import { TEACH_UI, TEACH_CLASSES } from "./config.js";
import { kv } from "./store.js";
import { buildPackage, readPackage, toLinkData, fromLinkData, packZone, unpackZone, packSamples, unpackSamples } from "./share.js";
import * as cloud from "./cloud.js";

const $ = id => document.getElementById(id);
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const PALETTE = TEACH_UI.map(c => hex(c.color));
const K = TEACH_CLASSES.length, MAX_DESCS = 12, NEW = "__new__";
const newId = () => "z" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };

export class Teacher {
  // api: { post(msg, transfer), capture(): Promise<{ image, gw, gh }>, toast(msg), modelId(), done() }
  constructor(api) {
    this.api = api;
    this.zones = []; this.info = null; this.D = 0;
    this.cls = 0; this.eraser = false; this.strokes = []; this.cur = null;
    this.photo = $("teach-photo"); this.paint = $("teach-paint");
    this.buildPalette();
    $("teach").onclick = () => this.open();
    $("teach-cancel").onclick = () => this.close();
    $("teach-undo").onclick = () => { this.strokes.pop(); this.redraw(); };
    $("teach-eraser").onclick = () => this.setEraser(!this.eraser);
    $("teach-train").onclick = () => this.train();
    $("teach-zone-del").onclick = () => this.deleteZone();
    $("share-link").onclick = () => this.shareLink();
    $("share-export").onclick = () => this.exportFile();
    $("share-import").onchange = e => this.importFile(e.target.files[0]);
    $("zone-mode").onchange = () => this.sendMode();
    $("only-zones").onchange = () => this.sendMode();
    $("only-zones").checked = pref("onlyZones") === "1";
    this.initCloud();
    this.bindPaint();
    addEventListener("resize", () => this.fit());
  }

  // ---------------------------------------------------------------- zonas
  modelZones() { return this.zones.filter(z => z.model === this.api.modelId()); }
  zoneName(id) { return this.zones.find(z => z.id === id)?.name; }
  async save() { await kv("zones", this.zones); }

  // Envía al worker las zonas del modelo actual y refresca los selectores.
  sync() {
    const zs = this.modelZones();
    this.api.post({ type: "zones", zones: zs.filter(z => z.W).map(z => ({ id: z.id, D: z.D, W: z.W, descs: z.descs || [] })) });
    const sel = $("zone-mode"), prev = sel.value || pref("zoneMode") || "auto";
    sel.replaceChildren(new Option("Automática", "auto"), ...zs.map(z => new Option(z.name, z.id)), new Option("Sin entrenamiento", "none"));
    sel.value = [...sel.options].some(o => o.value === prev) ? prev : "auto";
    $("zone-chip").hidden = $("only-chip").hidden = zs.length === 0;
    this.sendMode();
  }

  sendMode() {
    const mode = $("zone-mode").value || "auto", only = $("only-zones").checked;
    pref("zoneMode", mode); pref("onlyZones", only ? "1" : "0");
    this.api.post({ type: "zoneMode", mode, only });
  }

  onZone(info) { this.info = info; }

  statusText() {
    if (!this.modelZones().length) return "";
    if ($("zone-mode").value === "none") return "sin entrenamiento";
    if (this.info?.match) return `zona: ${this.zoneName(this.info.id) || "?"}`;
    return $("only-zones").checked ? "fuera de tus zonas (no se decora)" : "fuera de tus zonas";
  }

  // Al cargar un modelo: zonas guardadas + migración + entrenamiento compartido.
  async restore(modelId, D) {
    this.D = D;
    this.zones = (await kv("zones")) || [];
    // Migración desde la versión con un solo entrenamiento por modelo.
    const old = await kv("adapter:" + modelId);
    if (old?.y?.length) {
      const z = { id: newId(), name: "Mi zona", model: modelId, D: old.D, X: old.X, y: old.y, descs: [], updated: new Date().toISOString(), n: old.y.length };
      this.zones.push(z); await kv("adapter:" + modelId, null);
      this.api.post({ type: "retrain", zoneId: z.id, D: z.D, X: z.X, y: z.y });
    }
    // Enlace compartido (#entreno=…).
    const m = location.hash.match(/entreno=([^&]+)/);
    if (m) {
      try { const n = await this.merge(readPackage(await fromLinkData(decodeURIComponent(m[1])))); this.api.toast(`Entrenamiento recibido: ${n} zona(s)`); }
      catch (e) { this.api.toast("No se pudo leer el enlace de entrenamiento: " + e.message); }
      history.replaceState(null, "", location.pathname + location.search);
    }
    // Entrenamiento publicado con la web (entrenamiento.json en el repositorio).
    try {
      const r = await fetch("entrenamiento.json", { cache: "no-cache" });
      if (r.ok) {
        const pkg = await r.json();
        if (pkg.created && pkg.created !== await kv("siteStamp")) {
          const n = await this.merge(readPackage(pkg));
          await kv("siteStamp", pkg.created);
          if (n) this.api.toast(`Cargado el entrenamiento compartido: ${n} zona(s)`);
        }
      }
    } catch { /* no hay entrenamiento publicado */ }
    await this.save();
    this.sync();
    await this.pull(true);
  }

  // ---------------------------------------------------------------- nube
  initCloud() {
    $("cloud-row").hidden = !cloud.cloudEnabled;
    if (!cloud.cloudEnabled) return;
    $("cloud-login").onsubmit = async e => {
      e.preventDefault();
      try {
        await cloud.signIn($("cloud-email").value.trim(), $("cloud-pass").value);
        $("cloud-pass").value = ""; this.cloudUI();
        this.api.toast("Sesión de entrenador iniciada: lo que entrenes se publica para todos");
      } catch (err) { this.api.toast("No se pudo iniciar sesión: " + err.message); }
    };
    $("cloud-logout").onclick = () => { cloud.signOut(); this.cloudUI(); this.api.toast("Sesión de entrenador cerrada"); };
    $("cloud-publish").onclick = () => this.publishAll();
    this.cloudUI();
    // Las novedades de otros entrenadores llegan solas.
    setInterval(() => this.pull(false), 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.pull(false); });
  }

  cloudUI() {
    const who = cloud.trainer();
    $("cloud-who").textContent = who ? `Entrenador: ${who}` : "Entrenador: sin iniciar sesión (lo que entrenes se queda en este móvil)";
    $("cloud-login").hidden = !!who;
    $("cloud-logout").hidden = $("cloud-publish").hidden = !who;
  }

  // Descarga las zonas compartidas (para todos los visitantes).
  async pull(first) {
    const model = this.api.modelId();
    if (!cloud.cloudEnabled || !model) return;
    try {
      const rows = await cloud.fetchZones(model);
      const ids = new Set(rows.map(r => r.id));
      // Zonas compartidas que un entrenador ha borrado.
      const before = this.zones.length;
      this.zones = this.zones.filter(z => !(z.cloud && z.model === model && !ids.has(z.id)));
      let n = 0;
      for (const r of rows) {
        const z = { ...unpackZone(r.paquete, r.actualizada), name: r.nombre, updated: r.actualizada, cloud: true };
        const i = this.zones.findIndex(o => o.id === z.id);
        if (i < 0) { this.zones.push(z); n++; }
        else if ((z.updated || "") > (this.zones[i].updated || "")) { this.zones[i] = { ...this.zones[i], ...z, X: this.zones[i].X, y: this.zones[i].y }; n++; }
        else this.zones[i].cloud = true;
      }
      if (n || this.zones.length !== before) {
        await this.save(); this.sync();
        if (!first || n) this.api.toast(`Entrenamiento compartido actualizado (${rows.length} zona(s))`);
      }
    } catch (e) { console.warn("No se pudo descargar el entrenamiento compartido:", e.message); }
  }

  async publish(z) {
    await cloud.publishZone(
      { id: z.id, nombre: z.name, modelo: z.model, dim: z.D, paquete: packZone(z, K), actualizada: z.updated },
      z.X && z.y ? packSamples(z) : null);
    z.cloud = true; await this.save();
  }

  async publishAll() {
    const zs = this.modelZones().filter(z => z.W);
    if (!zs.length) { this.api.toast("No hay zonas entrenadas que publicar"); return; }
    try { for (const z of zs) await this.publish(z); this.api.toast(`Publicadas ${zs.length} zona(s) para todos`); }
    catch (e) { this.api.toast("No se pudo publicar: " + e.message); }
  }

  // Une zonas recibidas con las propias (la versión más reciente de cada zona gana).
  async merge({ zones }) {
    let n = 0;
    for (const z of zones) {
      const i = this.zones.findIndex(o => o.id === z.id);
      if (i < 0) { this.zones.push(z); n++; }
      else if ((z.updated || "") >= (this.zones[i].updated || "")) { this.zones[i] = { ...this.zones[i], ...z, X: z.X || this.zones[i].X, y: z.y || this.zones[i].y }; n++; }
    }
    await this.save();
    return n;
  }

  async deleteZone() {
    const id = $("teach-zone").value;
    if (id === NEW) return;
    const z = this.zones.find(o => o.id === id);
    if (z?.cloud && !cloud.trainer()) { this.api.toast("Es una zona compartida: solo un entrenador con sesión iniciada puede borrarla"); return; }
    if (!confirm(`¿Borrar la zona «${this.zoneName(id)}» y lo aprendido en ella${z?.cloud ? " (para todos)" : ""}?`)) return;
    if (z?.cloud) { try { await cloud.deleteZone(id); } catch (e) { this.api.toast("No se pudo borrar en la nube: " + e.message); return; } }
    this.zones = this.zones.filter(o => o.id !== id);
    await this.save(); this.sync(); this.fillZoneSelect();
    this.api.toast("Zona borrada");
  }

  // ---------------------------------------------------------------- compartir
  async shareLink() {
    const zs = this.modelZones().filter(z => z.W);
    if (!zs.length) { this.api.toast("Todavía no hay zonas entrenadas"); return; }
    const url = location.origin + location.pathname + "#entreno=" + await toLinkData(buildPackage(zs, K, false));
    try {
      if (navigator.share) await navigator.share({ title: "Entrenamiento de Navidad AR", text: "Abre este enlace para usar mi entrenamiento de Navidad AR", url });
      else { await navigator.clipboard.writeText(url); this.api.toast("Enlace copiado: envíalo a quien quieras"); }
    } catch (e) {
      if (e.name === "AbortError") return;
      try { await navigator.clipboard.writeText(url); this.api.toast("Enlace copiado: envíalo a quien quieras"); }
      catch { prompt("Copia este enlace:", url); }
    }
  }

  exportFile() {
    const zs = this.zones.filter(z => z.W);
    if (!zs.length) { this.api.toast("Todavía no hay zonas entrenadas"); return; }
    const blob = new Blob([JSON.stringify(buildPackage(zs, K, true))], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "entrenamiento.json" });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    this.api.toast("Guardado «entrenamiento.json». Súbelo al repositorio para que lo use todo el mundo");
  }

  async importFile(file) {
    if (!file) return;
    try { const n = await this.merge(readPackage(JSON.parse(await file.text()))); this.sync(); this.fillZoneSelect(); this.api.toast(`Importadas ${n} zona(s)`); }
    catch (e) { this.api.toast("No se pudo importar: " + e.message); }
    $("share-import").value = "";
  }

  // ---------------------------------------------------------------- pintar
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

  fillZoneSelect() {
    const sel = $("teach-zone"), zs = this.modelZones();
    const cur = this.info?.match ? this.info.id : ($("zone-mode").value !== "auto" && $("zone-mode").value !== "none" ? $("zone-mode").value : zs[0]?.id);
    sel.replaceChildren(...zs.map(z => new Option(z.name, z.id)), new Option("➕ Nueva zona…", NEW));
    sel.value = zs.some(z => z.id === cur) ? cur : NEW;
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
      this.strokes = []; this.redraw(); this.fillZoneSelect();
      $("teach-view").hidden = false;
      this.fit();
    } catch (e) {
      this.api.toast("No se pudo preparar la foto: " + e.message);
      this.api.done();
    } finally { this.busy = false; $("teach").disabled = false; }
  }

  close() { $("teach-view").hidden = true; this.api.done(); }

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
    this.paint.addEventListener("pointermove", e => { if (this.cur) { this.cur.pts.push(pos(e)); this.drawStroke(this.cur, true); } });
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
      c.moveTo(...(last ? p[p.length - 2] : p[0]));
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
    let id = $("teach-zone").value, z;
    if (id === NEW) {
      const name = (prompt("Nombre de la zona (p. ej. Patio, Fachada, Salón):", `Zona ${this.modelZones().length + 1}`) || "").trim();
      if (!name) return;
      z = { id: newId(), name, model: this.api.modelId(), D: this.D, descs: [] };
      this.zones.push(z); id = z.id;
    } else z = this.zones.find(o => o.id === id);
    $("teach-train").disabled = true; $("teach-train").textContent = "Entrenando…";
    // Zona compartida entrenada en otro móvil: se recuperan sus muestras para ampliarla.
    if (z.cloud && !z.X && cloud.trainer()) {
      try { const m = await cloud.fetchSamples(z.id); if (m) Object.assign(z, unpackSamples(m)); }
      catch (e) { console.warn("No se pudieron recuperar las muestras:", e.message); }
    }
    const X = z.X && z.D === this.D ? z.X.slice() : new Float32Array(0), y = X.length ? z.y.slice() : new Int8Array(0);
    this.api.post({ type: "train", zoneId: id, labels, X, y }, [labels.buffer, X.buffer, y.buffer]);
  }

  // Mensajes del worker relacionados con el aprendizaje.
  async onMessage(data) {
    if (data.type === "trainprogress") $("teach-train").textContent = `Entrenando… ${Math.round(data.progress * 100)} %`;
    else if (data.type === "trained") {
      $("teach-train").disabled = false; $("teach-train").textContent = "Entrenar";
      const z = this.zones.find(o => o.id === data.zoneId); if (!z) return;
      if (z.D !== data.D) z.descs = [];                 // huellas de otro modelo: no sirven
      Object.assign(z, { D: data.D, W: data.W, X: data.X, y: data.y, acc: data.acc, n: data.n, updated: new Date().toISOString() });
      z.descs = [...(z.descs || []), data.desc].slice(-MAX_DESCS);
      await this.save(); this.sync();
      let where = "";
      if (cloud.cloudEnabled && cloud.trainer()) {
        try { await this.publish(z); where = " Publicada para todos."; }
        catch (e) { where = ` No se pudo publicar (${e.message}); se ha guardado en este móvil.`; }
      } else if (cloud.cloudEnabled) where = " Guardada solo en este móvil: inicia sesión de entrenador para publicarla para todos.";
      this.api.toast(`«${z.name}» aprendida: ${Math.round(data.acc * 100)} % de acierto con ${data.n} muestras.${where}`);
      this.close();
    } else if (data.type === "retrained" && data.ok) {
      const z = this.zones.find(o => o.id === data.zoneId); if (!z) return;
      Object.assign(z, { W: data.W, acc: data.acc }); await this.save(); this.sync();
    }
  }

  onError(msg) {
    $("teach-train").disabled = false; $("teach-train").textContent = "Entrenar";
    this.api.toast("No se pudo entrenar: " + msg);
  }
}
