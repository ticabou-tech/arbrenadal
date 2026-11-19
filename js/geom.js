// Transformaciones de semejanza (escala + rotación + traslación):
//   x' = a·x − b·y + tx      y' = b·x + a·y + ty
export const I = () => ({ a: 1, b: 0, tx: 0, ty: 0 });

export const apply = (m, x, y) => [m.a * x - m.b * y + m.tx, m.b * x + m.a * y + m.ty];

// m2 ∘ m1 (primero m1, luego m2)
export const compose = (m2, m1) => ({
  a: m2.a * m1.a - m2.b * m1.b,
  b: m2.a * m1.b + m2.b * m1.a,
  tx: m2.a * m1.tx - m2.b * m1.ty + m2.tx,
  ty: m2.b * m1.tx + m2.a * m1.ty + m2.ty,
});

export const invert = m => {
  const d = m.a * m.a + m.b * m.b, a = m.a / d, b = -m.b / d;
  return { a, b, tx: -(a * m.tx - b * m.ty), ty: -(b * m.tx + a * m.ty) };
};

export const scaleOf = m => Math.hypot(m.a, m.b);

// Ajuste por mínimos cuadrados de una semejanza que lleva los puntos p a q.
export function fitSimilarity(p, q, w) {
  let sw = 0, px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0; i < p.length; i++) { const k = w ? w[i] : 1; sw += k; px += k * p[i][0]; py += k * p[i][1]; qx += k * q[i][0]; qy += k * q[i][1]; }
  if (!sw) return null;
  px /= sw; py /= sw; qx /= sw; qy /= sw;
  let sxx = 0, sa = 0, sb = 0;
  for (let i = 0; i < p.length; i++) {
    const k = w ? w[i] : 1, x = p[i][0] - px, y = p[i][1] - py, u = q[i][0] - qx, v = q[i][1] - qy;
    sxx += k * (x * x + y * y); sa += k * (x * u + y * v); sb += k * (x * v - y * u);
  }
  if (sxx < 1e-6) return { a: 1, b: 0, tx: qx - px, ty: qy - py };
  const a = sa / sxx, b = sb / sxx;
  return { a, b, tx: qx - (a * px - b * py), ty: qy - (b * px + a * py) };
}

// Matriz de canvas para dibujar algo definido en una rejilla gw×gh (que cubre W×H)
// con la semejanza m (píxeles de vídeo → pantalla).
export function gridMatrix(m, sx, sy) {
  return [m.a * sx, m.b * sx, -m.b * sy, m.a * sy, m.tx, m.ty];
}

export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// Envolvente convexa (cadena monótona). Puntos [x, y].
export function convexHull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

export const polyArea = poly => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2;
};
