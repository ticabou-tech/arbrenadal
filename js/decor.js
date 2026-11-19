// Decoración anclada a la escena: todo se define en coordenadas de mundo y se dibuja
// con G (mundo → pantalla), así sigue a la cámara entre un análisis y el siguiente.
//
// Se dibuja en tres capas para simular 3D:
//   R.d  adornos materiales (guirnalda, lazos, bolas, estrella…) → luego se ajusta su
//        exposición/tono a la luz real de la escena,
//   R.s  siluetas desplazadas → sombras suaves proyectadas sobre pared / árbol,
//   R.e  luz emitida (bombillas, halos) → se suma encima sin oscurecer.
import { LIGHTS } from "./config.js";
import { apply, scaleOf } from "./geom.js";
import { SPRITES, mkCanvas } from "./sprites.js";

const toScreen = (G, pts) => pts.map(([x, y]) => apply(G, x, y));
const offscreen = (pts, W, H) => pts.every(([x]) => x < 0) || pts.every(([x]) => x > W) || pts.every(([, y]) => y < 0) || pts.every(([, y]) => y > H);

// Sprite con su sombra (la sombra se desplaza según la dirección de la luz y la "altura").
function sprite(R, img, x, y, w, h, lift = 1) {
  R.d.drawImage(img, x, y, w, h);
  R.s.drawImage(img, x + R.sh[0] * lift, y + R.sh[1] * lift, w, h);
}

// Bombilla: casquillo con sombra + luz emitida con halo sobre lo que tiene alrededor.
function light(R, x, y, size, ci, alpha, warm) {
  const b = warm ? SPRITES.warmBulb : SPRITES.bulb[ci % LIGHTS.length];
  const h = warm ? SPRITES.warmHalo : SPRITES.halo[ci % LIGHTS.length];
  const hs = size * (4 + 3 * R.dark);
  R.e.globalAlpha = alpha * (0.16 + 0.3 * R.dark); R.e.drawImage(h, x - hs / 2, y - hs / 2, hs, hs);
  R.e.globalAlpha = alpha; R.e.drawImage(b, x - size / 2, y - size / 2, size, size);
  R.s.fillRect(x - size * 0.12 + R.sh[0] * 0.5, y - size * 0.12 + R.sh[1] * 0.5, size * 0.24, size * 0.3);
}

// Parpadeo realista: la mayoría de bombillas fijas con leve respiración, unas pocas titilan.
const twinkle = (t, p, c) => (c % 9 === 0 ? 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t / 260 + p * 7)) : 0.82 + 0.18 * Math.sin(t / 1400 + p));

// ---------------------------------------------------------------------------
// Péndulo: las bolas se balancean por inercia cuando la cámara acelera.
// ---------------------------------------------------------------------------
const swing = { th: 0, w: 0 };
export function updateSwing(dt, accelX) {
  if (!dt) return;
  const w0 = 5.5, z = 0.12;
  const acc = -w0 * w0 * swing.th - 2 * z * w0 * swing.w - accelX * 0.00045;
  swing.w += acc * dt; swing.th += swing.w * dt;
  swing.th = Math.max(-0.7, Math.min(0.7, swing.th));
}

// ---------------------------------------------------------------------------
// Ventanas: escarcha en el cristal, nieve en el alféizar y luces en el marco.
// ---------------------------------------------------------------------------
export function drawWindows(R, scene, G, t, opts) {
  const ctx = R.d, s = scaleOf(G), pattern = drawWindows.pattern ||= ctx.createPattern(SPRITES.frost, "repeat");
  for (const w of scene.windows) {
    if (w.seen < 2) continue;                                 // espera a confirmar la ventana
    const P = toScreen(G, w.pts);
    if (offscreen(P, scene.W, scene.H)) continue;
    const side = Math.min(Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]), Math.hypot(P[3][0] - P[0][0], P[3][1] - P[0][1]));
    const path = c => { c.beginPath(); P.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); };
    const fade = w.miss ? 0.5 : 1;

    ctx.save();
    path(ctx); ctx.clip();
    ctx.globalAlpha = fade;
    ctx.fillStyle = "rgba(225,238,255,.10)"; ctx.fill();                       // vaho
    ctx.lineJoin = "round";
    for (const k of [0.42, 0.28, 0.17, 0.08]) { ctx.lineWidth = side * k; ctx.strokeStyle = "rgba(240,248,255,.11)"; path(ctx); ctx.stroke(); }
    // Cristales de hielo anclados al cristal.
    pattern.setTransform?.(new DOMMatrix([G.a * 0.6, G.b * 0.6, -G.b * 0.6, G.a * 0.6, G.tx, G.ty]));
    ctx.strokeStyle = pattern; ctx.lineWidth = side * 0.5; ctx.globalAlpha = 0.85 * fade; path(ctx); ctx.stroke();
    ctx.lineWidth = side * 0.22; path(ctx); ctx.stroke();
    for (const [x, y] of P) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, side * 0.38);
      g.addColorStop(0, "rgba(255,255,255,.42)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.fillRect(x - side * 0.4, y - side * 0.4, side * 0.8, side * 0.8);
    }
    // Nieve acumulada en el alféizar (borde inferior), con volumen: cara superior
    // iluminada y sombra azulada abajo.
    const [bl, br] = [P[3], P[2]], hgt = side * 0.09;
    const pile = c => {
      c.beginPath(); c.moveTo(bl[0], bl[1] + 2);
      const n = 9;
      for (let i = 0; i <= n; i++) {
        const f = i / n, x = bl[0] + (br[0] - bl[0]) * f, y = bl[1] + (br[1] - bl[1]) * f;
        const bump = hgt * (0.65 + 0.35 * Math.sin(i * 2.7 + 1)) * Math.max(0.35, Math.sin(Math.PI * f));
        c.lineTo(x, y - bump);
      }
      c.lineTo(br[0], br[1] + 2); c.closePath();
    };
    const sg = ctx.createLinearGradient(0, bl[1] - hgt, 0, bl[1]);
    sg.addColorStop(0, "rgba(255,255,255,.98)"); sg.addColorStop(1, "rgba(185,205,230,.95)");
    ctx.globalAlpha = fade; ctx.fillStyle = sg; pile(ctx); ctx.fill();
    ctx.restore();

    // Luces cálidas siguiendo el marco, con su cable.
    if (opts.windowLights) {
      const step = scene.sp * 0.55 * s, size = Math.max(5, scene.sp * 0.32 * s);
      ctx.strokeStyle = "rgba(20,30,20,.85)"; ctx.lineWidth = Math.max(1, size * 0.12);
      path(ctx); ctx.stroke();
      R.s.lineWidth = ctx.lineWidth; R.s.save(); R.s.translate(R.sh[0] * 0.5, R.sh[1] * 0.5); path(R.s); R.s.stroke(); R.s.restore();
      let n = 0;
      for (let i = 0; i < 4; i++) {
        const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % 4], len = Math.hypot(x2 - x1, y2 - y1), k = Math.max(1, Math.round(len / step));
        for (let j = 0; j < k; j++, n++) {
          const f = j / k;
          light(R, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, size, n, fade * twinkle(t, n * 0.7, n), true);
        }
      }
      R.e.globalAlpha = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Árboles: espumillón, nieve, bolas que se balancean, luces y estrella 3D giratoria.
// ---------------------------------------------------------------------------
const tinselLayer = mkCanvas();

export function drawTrees(R, scene, G, t, dt, opts) {
  const ctx = R.d, s = scaleOf(G), { W, H } = scene;
  const visibleTrees = scene.trees.filter(tr => tr.seen >= 2);

  // Espumillón dorado colgando en curvas, recortado con la silueta del árbol.
  if (visibleTrees.length) {
    if (tinselLayer.width !== W || tinselLayer.height !== H) { tinselLayer.width = W; tinselLayer.height = H; }
    const c = tinselLayer.getContext("2d");
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = "source-over"; c.clearRect(0, 0, W, H);
    c.lineCap = "round";
    for (const tr of visibleTrees) {
      const [top, bl, br] = toScreen(G, tr.pts), hgt = Math.max(bl[1], br[1]) - top[1], wd = br[0] - bl[0];
      if (hgt < 20) continue;
      for (let k = 1; k <= 4; k++) {
        const y = top[1] + hgt * (0.18 + k * 0.17), x0 = top[0] - wd * 0.6, x1 = top[0] + wd * 0.6, drop = hgt * 0.09;
        const draw = (col, w, dash, oy = 0) => {
          c.strokeStyle = col; c.lineWidth = w; c.setLineDash(dash);
          c.beginPath(); c.moveTo(x0, y - drop + oy); c.quadraticCurveTo(top[0], y + drop * 1.6 + oy, x1, y - drop * 0.4 + oy); c.stroke();
        };
        draw("rgba(0,0,0,.35)", Math.max(3, wd * 0.026), [], wd * 0.012);           // sombra sobre las ramas
        draw("rgba(150,105,20,.95)", Math.max(3, wd * 0.022), []);
        draw("rgba(255,215,110,.95)", Math.max(2, wd * 0.014), [wd * 0.012, wd * 0.01]);
        c.lineDashOffset = -t / 40;
        draw("rgba(255,255,230,.9)", Math.max(1, wd * 0.006), [1, wd * 0.035]);
        c.lineDashOffset = 0;
      }
    }
    c.setLineDash([]);
    c.globalCompositeOperation = "destination-in";
    c.setTransform(...scene.gridMatrix(G)); c.drawImage(scene.cv.tree, 0, 0);
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = "source-over";
    ctx.drawImage(tinselLayer, 0, 0);
  }

  // Nieve sobre las ramas (exterior).
  if (opts.outdoor) {
    ctx.save(); ctx.globalAlpha = 0.8; ctx.setTransform(...scene.gridMatrix(G)); ctx.drawImage(scene.cv.treeSnow, 0, 0); ctx.restore();
  }

  // Bolas y luces (aparecen y desaparecen suavemente).
  const k = Math.min(1, dt * 4), items = [];
  for (const d of scene.decor.values()) {
    d.alpha += (d.target - d.alpha) * k;
    if (d.alpha < 0.02) continue;
    const [x, y] = apply(G, d.x, d.y);
    if (x < -50 || y < -50 || x > W + 50 || y > H + 50) continue;
    items.push([d, x, y]);
  }
  const bs = scene.sp * 0.62 * s, flip = R.lightDir[0] > 0.15;      // brillo de la bola del lado de la luz
  for (const [d, x, y] of items) {
    if (d.kind !== "bauble") continue;
    const th = swing.th * (0.7 + (d.c % 5) * 0.12) + Math.sin(t / 900 + d.p) * 0.03;
    for (const [c, ox, oy, a] of [[R.s, R.sh[0] * 0.8, R.sh[1] * 0.8, 1], [ctx, 0, 0, d.alpha]]) {
      c.save(); c.globalAlpha = a; c.translate(x + ox, y + oy - bs * 0.45); c.rotate(-th);
      if (flip) c.scale(-1, 1);
      c.drawImage(SPRITES.bauble[d.c % SPRITES.bauble.length], -bs / 2, 0, bs, bs);
      c.restore();
    }
  }
  const ls = Math.max(5, scene.sp * 0.42 * s);
  for (const [d, x, y] of items) if (d.kind === "light") light(R, x, y, ls, d.c, d.alpha * twinkle(t, d.p, d.c), opts.warm);
  R.e.globalAlpha = 1;

  // Estrella en la copa: gira despacio sobre su eje vertical (3D) y emite luz.
  for (const tr of visibleTrees) {
    if (tr.cut) continue;
    const [top, bl, br] = toScreen(G, tr.pts);
    const size = Math.min(Math.max((br[0] - bl[0]) * 0.42, 40), Math.min(W, H) * 0.35);
    const spin = Math.cos(t / 1600), sx = Math.max(0.18, Math.abs(spin));
    const y = top[1] - size * 0.18, rot = Math.atan2(G.b, G.a);
    R.e.save(); R.e.globalAlpha = 0.5 + 0.3 * R.dark; R.e.translate(top[0], y);
    R.e.drawImage(SPRITES.warmHalo, -size, -size, size * 2, size * 2); R.e.restore();
    ctx.save();
    ctx.globalAlpha = tr.miss ? 0.6 : 1;
    ctx.translate(top[0], y); ctx.rotate(rot); ctx.scale(sx * (spin < 0 ? -1 : 1), 1);
    ctx.drawImage(SPRITES.star, -size / 2, -size / 2, size, size);
    // al ponerse de canto la cara se oscurece (sombreado según el giro)
    if (sx < 0.9) { ctx.globalCompositeOperation = "source-atop"; ctx.fillStyle = `rgba(80,50,0,${(0.9 - sx) * 0.5})`; ctx.fillRect(-size / 2, -size / 2, size, size); }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Paredes: guirnalda de pino en festones con luces y lazos; nieve acumulada en exterior.
// ---------------------------------------------------------------------------
export function drawWall(R, scene, G, t, opts) {
  const ctx = R.d, s = scaleOf(G), keys = [...scene.garland.keys()].sort((a, b) => a - b);
  const segs = []; let cur = [], last = null;
  for (const key of keys) {
    const g = scene.garland.get(key);
    if (last !== null && key - last > 2) { segs.push(cur); cur = []; }
    const [x, y] = apply(G, g.x, g.y);
    cur.push({ x, y, snowy: g.snowy }); last = key;
  }
  if (cur.length) segs.push(cur);

  const u = scene.gsp * s;                      // separación en pantalla entre puntos
  const gw = SPRITES.garland.width, gh = SPRITES.garland.height;
  let li = 0;
  for (const pts of segs) {
    if (pts.length < 3) continue;
    if (pts.every(p => p.x < -u * 4) || pts.every(p => p.x > scene.W + u * 4)) continue;

    // Nieve acumulada sobre el borde (tejados, muros exteriores), con volumen.
    if (opts.outdoor) {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const [w, col, oy] of [[u * 0.8, "rgba(150,175,210,.7)", u * 0.08], [u * 0.62, "rgba(255,255,255,.97)", -u * 0.05], [u * 0.25, "rgba(255,255,255,1)", -u * 0.22]]) {
        ctx.lineWidth = w; ctx.strokeStyle = col; ctx.beginPath(); let on = false;
        for (const p of pts) { if (!p.snowy) { on = false; continue; } on ? ctx.lineTo(p.x, p.y + oy) : ctx.moveTo(p.x, p.y + oy); on = true; }
        ctx.stroke();
      }
    }

    const anchors = pts.filter((_, i) => i % 4 === 0 || i === pts.length - 1).map(p => ({ x: p.x, y: p.y + u * 0.35 }));
    const curves = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i], b = anchors[i + 1], sag = Math.hypot(b.x - a.x, b.y - a.y) * 0.22;
      curves.push([a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + sag }, b]);
    }
    const thick = u * 1.25, step = thick * gw / gh * 0.42;
    for (const [a, c, b] of curves) {
      const len = Math.hypot(b.x - a.x, b.y - a.y) * 1.15, n = Math.max(2, Math.ceil(len / step));
      for (let k = 0; k <= n; k++) {
        const q = k / n, iq = 1 - q;
        const x = iq * iq * a.x + 2 * iq * q * c.x + q * q * b.x, y = iq * iq * a.y + 2 * iq * q * c.y + q * q * b.y;
        const dx = 2 * iq * (c.x - a.x) + 2 * q * (b.x - c.x), dy = 2 * iq * (c.y - a.y) + 2 * q * (b.y - c.y);
        const ang = Math.atan2(dy, dx) + ((k * 7) % 5 - 2) * 0.05;
        // la parte central del festón se separa más de la pared → sombra más alejada
        const lift = 0.6 + 0.8 * Math.sin(Math.PI * q);
        for (const [cc, ox, oy] of [[R.s, R.sh[0] * lift, R.sh[1] * lift], [ctx, 0, 0]]) {
          cc.save(); cc.translate(x + ox, y + oy); cc.rotate(ang);
          if (k % 2) cc.scale(1, -1);
          cc.drawImage(SPRITES.garland, -thick * gw / gh / 2, -thick / 2, thick * gw / gh, thick);
          cc.restore();
        }
      }
    }
    // Luces repartidas por la guirnalda.
    const ls = Math.max(5, u * 0.55);
    for (const [a, c, b] of curves) {
      const n = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / (u * 0.9)));
      for (let k = 1; k < n; k++, li++) {
        const q = k / n, iq = 1 - q;
        const x = iq * iq * a.x + 2 * iq * q * c.x + q * q * b.x, y = iq * iq * a.y + 2 * iq * q * c.y + q * q * b.y;
        light(R, x + Math.sin(li * 2.3) * u * 0.2, y + Math.cos(li * 1.7) * u * 0.25, ls, li, twinkle(t, li * 0.37, li), opts.warm);
      }
    }
    R.e.globalAlpha = 1;
    const bsz = u * 1.9;
    for (const a of anchors) sprite(R, SPRITES.bow, a.x - bsz / 2, a.y - bsz * 0.42, bsz, bsz, 0.7);
  }
}
