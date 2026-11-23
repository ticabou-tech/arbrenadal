// Seguimiento del movimiento de la cámara (traslación + giro + zoom).
//
//  · Se compara cada fotograma con un FOTOGRAMA CLAVE (no con el anterior), así el error
//    no se acumula fotograma a fotograma; el clave se renueva al alejarse demasiado.
//  · Traslación global en baja resolución (robusta con texturas repetitivas: ladrillos,
//    azulejos), luego bloques con textura buscados alrededor de la predicción y refinados
//    con Lucas-Kanade (precisión subpíxel), y ajuste robusto de una semejanza.
import { I, compose, invert, fitSimilarity } from "./geom.js";

const COLS = 10, ROWS = 7, B = 12, RG = 6, RB = 3;

export class Tracker {
  constructor(width) {
    this.tw = width;
    this.cv = document.createElement("canvas");
    this.cx = this.cv.getContext("2d", { willReadFrequently: true });
    this.reset();
  }

  reset() { this.key = null; this.Mkc = I(); this.quality = 0; }

  // Devuelve la semejanza (píxeles de vídeo) que lleva el fotograma anterior al actual.
  update(video, W, H) {
    const tw = this.tw, th = Math.max(16, Math.round(tw * H / W));
    if (this.cv.width !== tw || this.cv.height !== th) { this.cv.width = tw; this.cv.height = th; this.key = null; }
    this.cx.drawImage(video, 0, 0, tw, th);
    const rgba = this.cx.getImageData(0, 0, tw, th).data;
    const g0 = new Float32Array(tw * th);
    for (let i = 0, j = 0; i < g0.length; i++, j += 4) g0[i] = rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114;
    const cur = { g0, g1: half(g0, tw, th), w: tw, h: th };

    if (!this.key) { this.setKey(cur); return I(); }

    const old = this.Mkc;
    const m = estimate(this.key, cur, old);
    if (!m) {                                    // perdido: se empieza de nuevo desde aquí
      this.setKey(cur); this.quality = 0; this.lostCount = (this.lostCount || 0) + 1;
      return I();
    }
    this.quality = m.quality;
    this.Mkc = m;
    const step = compose(m, invert(old));        // anterior → actual
    // ¿Renovar el fotograma clave?
    const s = Math.hypot(m.a, m.b), cxm = tw / 2, cym = th / 2;
    const dx = m.a * cxm - m.b * cym + m.tx - cxm, dy = m.b * cxm + m.a * cym + m.ty - cym;
    if (Math.hypot(dx / tw, dy / th) > 0.12 || s < 0.88 || s > 1.14 || Math.abs(Math.atan2(m.b, m.a)) > 0.12 || m.quality < 0.3) this.setKey(cur);

    const k = W / tw;                            // de píxeles de seguimiento a píxeles de vídeo
    return { a: step.a, b: step.b, tx: step.tx * k, ty: step.ty * k };
  }

  setKey(f) {
    const { g0, w, h } = f, gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (g0[i + 1] - g0[i - 1]) * 0.5; gy[i] = (g0[i + w] - g0[i - w]) * 0.5;
    }
    const blocks = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const x0 = Math.round(4 + (w - 8 - B) * c / (COLS - 1)), y0 = Math.round(4 + (h - 8 - B) * r / (ROWS - 1));
      // Matriz de estructura: hace falta gradiente en dos direcciones (esquinas, no bordes).
      let a = 0, b = 0, d = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const i = (y0 + y) * w + x0 + x; a += gx[i] * gx[i]; b += gx[i] * gy[i]; d += gy[i] * gy[i]; }
      const tr = a + d, det = a * d - b * b, lmin = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
      if (lmin / (B * B) > 2) blocks.push({ x0, y0, a, b, d, det, tex: Math.sqrt(lmin / (B * B)) });
    }
    this.key = { ...f, gx, gy, blocks };
    this.Mkc = I();
  }
}

function half(g, w, h) {
  const hw = w >> 1, hh = h >> 1, o = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
    const i = 2 * y * w + 2 * x;
    o[y * hw + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) * 0.25;
  }
  return o;
}

function sad(a, b, w, ax, ay, bx, by, n) {
  let s = 0;
  for (let y = 0; y < n; y++) {
    let ia = (ay + y) * w + ax, ib = (by + y) * w + bx;
    for (let x = 0; x < n; x++) s += Math.abs(a[ia++] - b[ib++]);
  }
  return s;
}

// Traslación global (imagen reducida) alrededor de la predicción (px, py).
// Se usan todos los píxeles que caen dentro de ambas imágenes.
function globalShift(key, cur, w, h, px, py) {
  let best = Infinity, bx = px, by = py;
  for (let dy = py - RG; dy <= py + RG; dy++) for (let dx = px - RG; dx <= px + RG; dx++) {
    const x0 = Math.max(1, -dx + 1), x1 = Math.min(w - 1, w - dx - 1), y0 = Math.max(1, -dy + 1), y1 = Math.min(h - 1, h - dy - 1);
    if (x1 - x0 < w * 0.4 || y1 - y0 < h * 0.4) continue;
    let s = 0, n = 0;
    for (let y = y0; y < y1; y += 2) {
      let ia = y * w + x0, ib = (y + dy) * w + x0 + dx;
      for (let x = x0; x < x1; x += 2, ia += 2, ib += 2) { s += Math.abs(key[ia] - cur[ib]); n++; }
    }
    s /= n;
    if (s < best) { best = s; bx = dx; by = dy; }
  }
  return [bx, by];
}

// Búsqueda entera del bloque alrededor de (pdx, pdy) con radio r.
function matchBlock(key, cur, w, h, x0, y0, pdx, pdy, r) {
  let best = Infinity, fdx = 0, fdy = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const bx = x0 + pdx + dx, by = y0 + pdy + dy;
    if (bx < 0 || by < 0 || bx + B > w || by + B > h) continue;
    const s = sad(key, cur, w, x0, y0, bx, by, B);
    if (s < best) { best = s; fdx = dx; fdy = dy; }
  }
  return isFinite(best) ? [pdx + fdx, pdy + fdy] : null;
}

// Refinamiento Lucas-Kanade (composicional inverso) de la traslación de un bloque.
function lk(key, bl, cur, w, h, dx, dy) {
  const { x0, y0, a, b, d, det } = bl, g0 = key.g0, gx = key.gx, gy = key.gy;
  if (det < 1e-3) return null;
  let err = 0;
  for (let it = 0; it < 3; it++) {
    let ex = 0, ey = 0; err = 0;
    for (let y = 0; y < B; y++) {
      const sy = y0 + y + dy, iy = Math.floor(sy), fy = sy - iy;
      if (iy < 0 || iy >= h - 1) return null;
      for (let x = 0; x < B; x++) {
        const sx = x0 + x + dx, ix = Math.floor(sx), fx = sx - ix;
        if (ix < 0 || ix >= w - 1) return null;
        const j = iy * w + ix;
        const v = (cur[j] * (1 - fx) + cur[j + 1] * fx) * (1 - fy) + (cur[j + w] * (1 - fx) + cur[j + w + 1] * fx) * fy;
        const i = (y0 + y) * w + x0 + x, e = v - g0[i];
        ex += gx[i] * e; ey += gy[i] * e; err += Math.abs(e);
      }
    }
    const ux = (d * ex - b * ey) / det, uy = (a * ey - b * ex) / det;
    dx -= ux; dy -= uy;
    if (Math.abs(ux) + Math.abs(uy) < 0.01) break;
  }
  return { dx, dy, err: err / (B * B) };
}

function robustFit(P, Q, Wt) {
  let m = fitSimilarity(P, Q, Wt), n = P.length;
  for (let pass = 0; pass < 3 && m; pass++) {
    const res = P.map(([x, y], i) => Math.hypot(m.a * x - m.b * y + m.tx - Q[i][0], m.b * x + m.a * y + m.ty - Q[i][1]));
    const med = res.slice().sort((a, b) => a - b)[res.length >> 1];
    const lim = Math.max(0.35, med * 2.5);
    const keep = res.map(r => r <= lim);
    const p2 = P.filter((_, i) => keep[i]), q2 = Q.filter((_, i) => keep[i]), w2 = Wt.filter((_, i) => keep[i]);
    if (p2.length < 5) break;
    m = fitSimilarity(p2, q2, w2); n = p2.length;
  }
  return m && { ...m, inliers: n };
}

// Estima la semejanza fotograma clave → actual, partiendo de la anterior (pred).
function estimate(key, cur, pred) {
  const { w, h } = cur, blocks = key.blocks;
  if (blocks.length < 6) return null;
  // Traslación residual en el centro respecto de la predicción.
  const cx = w / 2, cy = h / 2;
  const pcx = pred.a * cx - pred.b * cy + pred.tx - cx, pcy = pred.b * cx + pred.a * cy + pred.ty - cy;
  const [gx, gy] = globalShift(key.g1, cur.g1, w >> 1, h >> 1, Math.round(pcx / 2), Math.round(pcy / 2));
  let m = { ...pred, tx: pred.tx + gx * 2 - pcx, ty: pred.ty + gy * 2 - pcy };

  let fit = null;
  for (let it = 0; it < 2; it++) {
    const P = [], Q = [], Wt = [];
    for (const bl of blocks) {
      const bx = bl.x0 + B / 2, by = bl.y0 + B / 2;
      const ex = m.a * bx - m.b * by + m.tx - bx, ey = m.b * bx + m.a * by + m.ty - by;
      const ip = matchBlock(key.g0, cur.g0, w, h, bl.x0, bl.y0, Math.round(ex), Math.round(ey), it === 0 ? RB : 1);
      if (!ip) continue;
      const r = lk(key, bl, cur.g0, w, h, ip[0], ip[1]);
      if (!r || r.err > 18 || Math.hypot(r.dx - ip[0], r.dy - ip[1]) > 1.5) continue;
      P.push([bx, by]); Q.push([bx + r.dx, by + r.dy]); Wt.push(bl.tex / (1 + r.err));
    }
    if (P.length < 5) return null;
    fit = robustFit(P, Q, Wt);
    if (!fit) return null;
    m = fit;
  }
  const s = Math.hypot(m.a, m.b);
  if (s < 0.6 || s > 1.6) return null;
  return { a: m.a, b: m.b, tx: m.tx, ty: m.ty, quality: fit.inliers / blocks.length };
}
