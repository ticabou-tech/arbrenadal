// Modelo de la escena: fusiona los análisis del modelo en el tiempo (compensando el
// movimiento de la cámara) y extrae la geometría que se decora:
//   · ventanas como cuadriláteros nítidos,
//   · árboles (copa, contorno) y posiciones fijas para luces y bolas,
//   · borde superior de las paredes para la guirnalda.
// Todo lo que se decora se guarda en coordenadas de "mundo" (píxeles del primer
// fotograma); G (mundo → pantalla) lo mantiene el seguidor de movimiento.
import { CONFIG } from "./config.js";
import { I, apply, compose, invert, scaleOf, gridMatrix, smoothstep, hash, polyArea } from "./geom.js";
import { mkCanvas } from "./sprites.js";

const DEBUG_COLORS = { window: [80, 160, 255], wall: [255, 160, 60], ceiling: [200, 90, 255], tree: [60, 200, 90], sky: [120, 220, 255] };

export class Scene {
  constructor() { this.reset(0, 0); }

  reset(W, H) {
    this.W = W; this.H = H;
    this.maps = null; this.gw = 0; this.gh = 0;
    this.Gref = I();
    this.cv = {};                 // canvases de máscaras (rejilla)
    this.coverage = {};
    this.indoor = 0;              // 0 exterior … 1 interior
    this.windows = [];            // { pts: [[x,y]×4] (mundo), miss }
    this.trees = [];              // { top, bl, br, w, miss } (mundo)
    this.decor = new Map();       // clave de celda -> { x, y, kind, c, p, alpha, target }
    this.garland = new Map();     // cubo -> { x, y, snowy, miss }
    this.sp = W / 30;             // separación de la rejilla de adornos (unidades de mundo)
    this.gsp = W / 44;            // separación de los puntos de la guirnalda
  }

  get ready() { return !!this.maps; }

  // Rejilla del modelo → píxeles de vídeo del fotograma de referencia.
  g2v(x, y) { return [x * this.W / this.gw, y * this.H / this.gh]; }
  g2w(x, y) { return apply(this.GrefInv, ...this.g2v(x, y)); }
  w2g(x, y) { const [vx, vy] = apply(this.Gref, x, y); return [vx * this.gw / this.W, vy * this.gh / this.H]; }

  // Probabilidad (interpolada) de un grupo en coordenadas de la rejilla.
  sampleGrid(name, gx, gy) {
    const m = this.maps?.[name]; if (!m) return 0;
    const x = gx - 0.5, y = gy - 0.5, x0 = Math.floor(x), y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 >= this.gw - 1 || y0 >= this.gh - 1) return 0;
    const fx = x - x0, fy = y - y0, i = y0 * this.gw + x0;
    return (m[i] * (1 - fx) + m[i + 1] * fx) * (1 - fy) + (m[i + this.gw] * (1 - fx) + m[i + this.gw + 1] * fx) * fy;
  }
  sampleWorld(name, x, y) { return this.sampleGrid(name, ...this.w2g(x, y)); }
  // Punto de pantalla (con la G actual) → probabilidad.
  sampleScreen(name, sx, sy, G) {
    const [wx, wy] = apply(invert(G), sx, sy);
    return this.sampleWorld(name, wx, wy);
  }

  // Matriz de canvas para dibujar una máscara de la rejilla en pantalla con la G actual.
  gridMatrix(G, k = 1) {
    const m = gridMatrix(compose(G, this.GrefInv), this.W / this.gw, this.H / this.gh);
    return m.map(v => v * k);
  }

  inRefView(wx, wy, margin = 0) {
    const [x, y] = apply(this.Gref, wx, wy);
    return x > -margin && y > -margin && x < this.W + margin && y < this.H + margin;
  }

  // ---------------------------------------------------------------------------
  ingest({ gw, gh, maps }, Gcap, gray) {
    this.gray = gray;
    this.frameNo = (this.frameNo || 0) + 1;
    const a = CONFIG.blend;
    if (this.maps && this.gw === gw && this.gh === gh) {
      // Lleva el mapa acumulado al punto de vista del nuevo fotograma y lo fusiona.
      const D = compose(this.Gref, invert(Gcap));         // vídeo nuevo → vídeo anterior
      const sx = this.W / gw, sy = this.H / gh;
      for (const name in maps) {
        const old = this.maps[name], nw = maps[name];
        if (!old) continue;
        const out = new Float32Array(gw * gh);
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
          const [ox, oy] = apply(D, (x + 0.5) * sx, (y + 0.5) * sy);
          const gx = ox / sx - 0.5, gy = oy / sy - 0.5, x0 = Math.floor(gx), y0 = Math.floor(gy), i = y * gw + x;
          if (x0 < 0 || y0 < 0 || x0 >= gw - 1 || y0 >= gh - 1) { out[i] = nw[i]; continue; }
          const fx = gx - x0, fy = gy - y0, j = y0 * gw + x0;
          const v = (old[j] * (1 - fx) + old[j + 1] * fx) * (1 - fy) + (old[j + gw] * (1 - fx) + old[j + gw + 1] * fx) * fy;
          out[i] = v * (1 - a) + nw[i] * a;
        }
        maps[name] = out;
      }
    }
    this.maps = maps; this.gw = gw; this.gh = gh;
    this.Gref = { ...Gcap }; this.GrefInv = invert(Gcap);

    // Pared "ampliada": la pared más lo que cuelga de ella (cuadros, puertas, cortinas…),
    // para que esos objetos no la rompan. Sólidos = pared + techo + toldos; la oclusión
    // lejana de la nieve incluye además los árboles.
    const N = gw * gh, solid = new Float32Array(N), far = new Float32Array(N), wallX = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      wallX[i] = Math.min(1, maps.wall[i] + maps.onwall[i]);
      solid[i] = Math.max(wallX[i], maps.ceiling[i], maps.roof[i]);
      far[i] = Math.max(solid[i], maps.tree[i]);
    }
    maps.wallX = wallX; maps.solid = solid; maps.far = far;

    const th = CONFIG.thresholds;
    for (const name of ["window", "wall", "ceiling", "tree", "sky"]) {
      let n = 0; const m = maps[name], t = th[name];
      for (let i = 0; i < N; i++) if (m[i] > t) n++;
      this.coverage[name] = n / N;
    }
    // ¿Interior o exterior? Techo visible → interior; cielo visible → exterior.
    const target = this.coverage.ceiling > 0.03 ? 1 : this.coverage.sky > 0.04 ? 0 : this.indoor;
    this.indoor += (target - this.indoor) * 0.3;

    this.renderMask("window", maps.window, th.window, DEBUG_COLORS.window);
    this.renderMask("solid", solid, th.wall, DEBUG_COLORS.wall);
    this.renderMask("far", far, th.wall, [255, 255, 255]);
    this.renderMask("tree", maps.tree, th.tree, DEBUG_COLORS.tree);
    this.renderMask("sky", maps.sky, th.sky, DEBUG_COLORS.sky);
    this.renderTreeSnow();

    this.findWindows();
    this.findTrees();
    this.findWallEdge();
  }

  renderMask(name, m, t, [r, g, b]) {
    const { gw, gh } = this;
    let c = this.cv[name];
    if (!c || c.width !== gw || c.height !== gh) c = this.cv[name] = mkCanvas(gw, gh);
    const cx = c.getContext("2d"), img = cx.createImageData(gw, gh), px = new Uint32Array(img.data.buffer), rgb = (b << 16) | (g << 8) | r;
    for (let i = 0; i < m.length; i++) px[i] = ((smoothstep(t - 0.15, t + 0.15, m[i]) * 255) << 24) | rgb;
    cx.putImageData(img, 0, 0);
  }

  // Nieve acumulada en la parte superior de las ramas (solo en exterior).
  renderTreeSnow() {
    const { gw, gh } = this, m = this.maps.tree;
    let c = this.cv.treeSnow;
    if (!c || c.width !== gw || c.height !== gh) c = this.cv.treeSnow = mkCanvas(gw, gh);
    const cx = c.getContext("2d"), img = cx.createImageData(gw, gh), px = new Uint32Array(img.data.buffer);
    for (let y = 2; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x, top = m[i] * (1 - m[i - 2 * gw]);
      const speck = (hash(x, y) % 7 === 0 ? 0.35 : 0) * m[i];
      px[i] = ((Math.min(1, top * 1.6 + speck) * 235) << 24) | 0xfffaf5;
    }
    cx.putImageData(img, 0, 0);
  }

  // Componentes conexas de un mapa umbralizado.
  components(m, t, minArea) {
    const { gw, gh } = this, N = gw * gh, lab = new Int32Array(N), comps = [], stack = [];
    for (let i = 0; i < N; i++) {
      if (lab[i] || m[i] <= t) continue;
      const c = { id: comps.length + 1, px: [], minX: gw, maxX: 0, minY: gh, maxY: 0 };
      lab[i] = c.id; stack.push(i);
      while (stack.length) {
        const p = stack.pop(), x = p % gw, y = (p / gw) | 0;
        c.px.push(p);
        if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x; if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
        for (const q of [x > 0 ? p - 1 : -1, x < gw - 1 ? p + 1 : -1, y > 0 ? p - gw : -1, y < gh - 1 ? p + gw : -1]) {
          if (q >= 0 && !lab[q] && m[q] > t) { lab[q] = c.id; stack.push(q); }
        }
      }
      if (c.px.length >= minArea * N) comps.push(c);
    }
    return { comps, lab };
  }

  // Ventanas → cuadrilátero (esquinas extremas en las diagonales), con los paneles de
  // una misma ventana unidos y los bordes ajustados a las líneas reales de la imagen.
  findWindows() {
    const { gw } = this, { comps } = this.components(this.maps.window, CONFIG.thresholds.window, CONFIG.minWindowArea * 0.4);
    // Une paneles vecinos (separados por el marco o un parteluz).
    const parent = comps.map((_, i) => i), root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
    const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
    for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
      const A = comps[i], Bc = comps[j];
      const gapX = -ov(A.minX, A.maxX + 1, Bc.minX, Bc.maxX + 1), gapY = -ov(A.minY, A.maxY + 1, Bc.minY, Bc.maxY + 1);
      const hA = A.maxY - A.minY + 1, hB = Bc.maxY - Bc.minY + 1, wA = A.maxX - A.minX + 1, wB = Bc.maxX - Bc.minX + 1;
      const side = gapX <= 3 && gapX >= -1 && -gapY >= 0.6 * Math.min(hA, hB);
      const stack = gapY <= 3 && gapY >= -1 && -gapX >= 0.6 * Math.min(wA, wB);
      if (side || stack) parent[root(i)] = root(j);
    }
    const groups = new Map();
    comps.forEach((c, i) => { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });

    const found = [], N = this.gw * this.gh;
    for (const g of groups.values()) {
      const px = g.flatMap(c => c.px);
      if (px.length < CONFIG.minWindowArea * N) continue;
      let tl, tr, br, bl, vtl = Infinity, vtr = -Infinity, vbr = -Infinity, vbl = Infinity;
      for (const p of px) {
        const x = p % gw + 0.5, y = ((p / gw) | 0) + 0.5;
        if (x + y < vtl) { vtl = x + y; tl = [x - 0.5, y - 0.5]; }
        if (x + y > vbr) { vbr = x + y; br = [x + 0.5, y + 0.5]; }
        if (x - y > vtr) { vtr = x - y; tr = [x + 0.5, y - 0.5]; }
        if (x - y < vbl) { vbl = x - y; bl = [x - 0.5, y + 0.5]; }
      }
      const quad = [tl, tr, br, bl], area = polyArea(quad);
      // forma poco rectangular: no es una ventana clara (con varios paneles se tolera el marco)
      if (area < 4 || px.length / area < (g.length > 1 ? 0.5 : 0.62)) continue;
      found.push(this.snapQuad(quad).map(([x, y]) => this.g2w(x, y)));
    }
    this.windows = this.track(this.windows, found, 0.55);
  }

  // Gradiente de la imagen en grises (coordenadas de la imagen analizada).
  grad(x, y) {
    const { w, h, data } = this.gray;
    const at = (u, v) => {
      u = Math.min(w - 1.001, Math.max(0, u)); v = Math.min(h - 1.001, Math.max(0, v));
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i = y0 * w + x0;
      return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy;
    };
    return [(at(x + 1, y) - at(x - 1, y)) * 0.5, (at(x, y + 1) - at(x, y - 1)) * 0.5];
  }

  // Desplaza cada lado del cuadrilátero hasta la línea más marcada de la imagen cercana
  // (el marco de la ventana) y recalcula las esquinas como cruces de esas líneas.
  snapQuad(q) {
    if (!this.gray) return q;
    const k = this.gray.w / this.gw, r = Math.max(2, Math.round(1.6 * k));
    const P = q.map(([x, y]) => [x * k, y * k]);
    const cx = P.reduce((s, p) => s + p[0], 0) / 4, cy = P.reduce((s, p) => s + p[1], 0) / 4;
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const t = [dx / len, dy / len];
      let n = [-t[1], t[0]];
      if (((a[0] + b[0]) / 2 - cx) * n[0] + ((a[1] + b[1]) / 2 - cy) * n[1] < 0) n = [-n[0], -n[1]];
      let best = 0, bo = 0, mean = 0;
      for (let o = -r; o <= r; o++) {
        let sc = 0;
        for (let j = 0; j < 14; j++) {
          const f = 0.15 + 0.7 * j / 13, x = a[0] + dx * f + n[0] * o, y = a[1] + dy * f + n[1] * o;
          const [gx, gy] = this.grad(x, y);
          sc += Math.abs(gx * n[0] + gy * n[1]);
        }
        mean += sc;
        if (sc > best) { best = sc; bo = o; }
      }
      mean /= 2 * r + 1;
      if (best < mean * 1.25 || best / 14 < 6) bo = 0;           // sin línea clara: no se mueve
      lines.push({ p: [a[0] + n[0] * bo, a[1] + n[1] * bo], d: t });
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const L1 = lines[(i + 3) % 4], L2 = lines[i];
      const den = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
      if (Math.abs(den) < 1e-3) return q;
      const s = ((L2.p[0] - L1.p[0]) * L2.d[1] - (L2.p[1] - L1.p[1]) * L2.d[0]) / den;
      const c = [L1.p[0] + L1.d[0] * s, L1.p[1] + L1.d[1] * s];
      if (Math.hypot(c[0] - P[i][0], c[1] - P[i][1]) > r * 3) return q;
      out.push([c[0] / k, c[1] / k]);
    }
    return out;
  }

  // Empareja objetos nuevos con los ya conocidos (en coordenadas de mundo) y suaviza
  // sus puntos. Los que dejan de verse estando en cámara desaparecen tras unos análisis;
  // los que quedan fuera de cámara se recuerdan.
  track(known, found, k, maxMiss = 3) {
    const center = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const size = pts => Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]));
    const used = new Set(), next = [];
    for (const fp of found) {
      const fc = center(fp), fs = size(fp);
      let best = -1, bd = Infinity;
      known.forEach((o, i) => {
        if (used.has(i)) return;
        const oc = center(o.pts), d = Math.hypot(oc[0] - fc[0], oc[1] - fc[1]);
        if (d < Math.max(fs, size(o.pts)) * 0.5 && d < bd) { bd = d; best = i; }
      });
      if (best < 0) { next.push({ pts: fp, miss: 0, seen: 1, cut: fp.cut }); continue; }
      used.add(best);
      const o = known[best];
      next.push({ ...o, pts: o.pts.map((p, i) => [p[0] * (1 - k) + fp[i][0] * k, p[1] * (1 - k) + fp[i][1] * k]), miss: 0, seen: o.seen + 1, cut: fp.cut });
    }
    known.forEach((o, i) => {
      if (used.has(i)) return;
      const c = center(o.pts);
      const miss = this.inRefView(c[0], c[1], -this.W * 0.05) ? o.miss + 1 : o.miss;
      if (miss <= maxMiss) next.push({ ...o, miss });
    });
    return next.slice(0, 16);
  }

  // Árboles: copa (estrella), caja y adornos colocados en una rejilla fija del mundo.
  findTrees() {
    const { gw, gh } = this, maps = this.maps, t = CONFIG.thresholds.tree;
    const { comps } = this.components(maps.tree, t, CONFIG.minTreeArea);
    const found = comps.map(c => {
      let sx = 0, n = 0, edge = c.minY === 0;
      for (const p of c.px) {
        const y = (p / gw) | 0, x = p % gw;
        if (y <= c.minY + 1) { sx += x; n++; }
        if (y <= c.minY + (c.maxY - c.minY) * 0.3 && (x === 0 || x === gw - 1)) edge = true;
      }
      // pts: copa, abajo-izquierda, abajo-derecha. cut: la copa queda fuera de la imagen.
      const pts = [this.g2w(sx / n + 0.5, c.minY + 0.3), this.g2w(c.minX, c.maxY + 1), this.g2w(c.maxX + 1, c.maxY + 1)];
      pts.cut = edge;
      return pts;
    });
    this.trees = this.track(this.trees, found, 0.4);

    // Adornos: candidatos fijos en el mundo, visibles solo donde el modelo ve árbol.
    const sp = this.sp, seen = new Set();
    for (const tr of this.trees) {
      if (tr.miss) continue;
      const [top, bl, br] = tr.pts;
      const minX = Math.min(bl[0], top[0]) - sp, maxX = Math.max(br[0], top[0]) + sp;
      const minY = top[1], maxY = Math.max(bl[1], br[1]), hgt = maxY - minY;
      for (let cy = Math.floor(minY / sp); cy * sp <= maxY; cy++) for (let cx = Math.floor(minX / sp); cx * sp <= maxX; cx++) {
        const h = hash(cx + 5000, cy + 5000), r = (h >>> 16) % 100;
        const kind = r < 46 ? "light" : r < 60 ? "bauble" : null;
        if (!kind) continue;
        const x = (cx + (h % 1000) / 1000) * sp, y = (cy + ((h >>> 10) % 1000) / 1000) * sp, key = cx + "," + cy;
        if (seen.has(key) || y < minY + hgt * 0.07) continue;
        seen.add(key);
        const p = this.sampleWorld("tree", x, y);
        let d = this.decor.get(key);
        if (!d) { if (p < 0.55) continue; d = { x, y, kind, c: (h >>> 4) % 997, p: (h % 628) / 100, alpha: 0, target: 0 }; this.decor.set(key, d); }
        d.target = p > 0.5 ? 1 : 0;
      }
    }
    for (const [key, d] of this.decor) {
      if (!seen.has(key) && this.inRefView(d.x, d.y)) d.target = 0;
      if (d.target === 0 && d.alpha < 0.02) this.decor.delete(key);
    }
  }

  // Borde superior de las paredes: puntos en cubos fijos del mundo.
  findWallEdge() {
    const { gw, gh } = this, m = this.maps.wallX, t = CONFIG.thresholds.wall, seen = new Set();
    for (let x = 0; x < gw; x += 2) {
      let y = -1;
      for (let j = 0; j < gh - 2; j++) if (m[j * gw + x] > t && m[(j + 1) * gw + x] > t && m[(j + 2) * gw + x] > t) { y = j; break; }
      if (y <= 1 || y > gh * 0.85) continue;                 // sin borde visible
      if (this.maps.window[(y + 1) * gw + x] > 0.5) continue;
      const [wx, wy] = this.g2w(x + 0.5, this.snapEdgeY(x + 0.5, y));
      const key = Math.round(wx / this.gsp);
      if (seen.has(key)) continue;
      seen.add(key);
      const snowy = this.maps.sky[Math.max(0, y - 2) * gw + x] > 0.3;
      const g = this.garland.get(key);
      if (g) { g.y = g.y * 0.6 + wy * 0.4; g.x = key * this.gsp; g.miss = 0; g.snowy = snowy; g.seen = this.frameNo; }
      else this.garland.set(key, { x: key * this.gsp, y: wy, snowy, miss: 0, seen: this.frameNo });
    }
    for (const [key, g] of this.garland) {
      if (seen.has(key)) continue;
      if (this.inRefView(g.x, g.y, -this.W * 0.03)) g.miss++;
      if (g.miss > 3) this.garland.delete(key);
    }
  }

  // Ajusta la altura del borde superior de la pared a la línea horizontal más marcada
  // de la imagen (unión pared-techo, cornisa, tejado).
  snapEdgeY(gx, gy) {
    if (!this.gray) return gy;
    const k = this.gray.w / this.gw, r = Math.max(2, Math.round(1.5 * k)), x = gx * k, y0 = gy * k;
    let best = 0, by = y0;
    for (let o = -r; o <= r; o++) {
      let sc = 0;
      for (const dx of [-k, 0, k]) sc += Math.abs(this.grad(x + dx, y0 + o)[1]);
      if (sc > best) { best = sc; by = y0 + o; }
    }
    return best / 3 > 8 ? by / k : gy;
  }

  // Escala actual mundo → pantalla.
  static scale(G) { return scaleOf(G); }
}
