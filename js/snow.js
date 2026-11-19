// Nieve en tres capas de profundidad (lejos, media, cerca) por toda la pantalla.
//  · Los copos se mueven con la cámara (parecen estar en el mundo, no pegados a la pantalla).
//  · No atraviesan paredes ni techos: quedan ocultos detrás de ellos y, en las capas
//    media y cercana, el copo que choca con una pared o techo "se posa" y desaparece.
//  · En interiores (se ve techo) solo nieva al otro lado de las ventanas.
import { CONFIG } from "./config.js";
import { apply } from "./geom.js";
import { SPRITES, mkCanvas } from "./sprites.js";

const LAYERS = {
  //       tamaño (u)   velocidad (H/s)   alfa   balanceo   paralaje
  far:  { size: [0.8, 1.8], speed: [0.035, 0.06], alpha: 0.6, sway: 0.004, par: 1.0 },
  mid:  { size: [2.0, 4.0], speed: [0.08, 0.14], alpha: 0.9, sway: 0.010, par: 1.0 },
  near: { size: [12, 26],  speed: [0.22, 0.36], alpha: 0.32, sway: 0.025, par: 1.35 },
};

export class Snow {
  constructor() { this.flakes = {}; this.W = 0; this.H = 0; this.wind = 0; }

  resize(W, H) {
    this.W = W; this.H = H;
    this.k = 0.5;                                // las capas de nieve se dibujan a media resolución
    this.far = mkCanvas(Math.round(W * this.k), Math.round(H * this.k));
    this.near = mkCanvas(this.far.width, this.far.height);
    this.mask = mkCanvas(this.far.width, this.far.height);
    for (const name in LAYERS) this.flakes[name] = Array.from({ length: CONFIG.snow[name] }, () => this.spawn(name, true));
  }

  spawn(name, anywhere) {
    const L = LAYERS[name], r = Math.random;
    const s = L.size[0] + (L.size[1] - L.size[0]) * r() ** 1.5;
    return {
      x: r() * this.W, y: anywhere ? r() * this.H : -s * 4 - r() * this.H * 0.1,
      s, v: L.speed[0] + (L.speed[1] - L.speed[0]) * r(), p: r() * 100, f: 0.4 + r() * 0.8,
    };
  }

  // Movimiento de la cámara en este fotograma (semejanza en píxeles de vídeo).
  onMotion(M) {
    for (const name in LAYERS) {
      const par = LAYERS[name].par;
      for (const f of this.flakes[name]) {
        const [x, y] = apply(M, f.x, f.y);
        f.x += (x - f.x) * par; f.y += (y - f.y) * par;
      }
    }
  }

  update(dt, t, scene, G, outdoor) {
    const { W, H } = this, u = Math.min(W, H) / 360;
    this.wind = 0.012 * Math.sin(t / 5200) + 0.006 * Math.sin(t / 1700 + 1);
    for (const name in LAYERS) {
      const L = LAYERS[name], collide = outdoor && name !== "far" && scene.ready;
      const list = this.flakes[name];
      for (let i = 0; i < list.length; i++) {
        const f = list[i], depth = name === "near" ? 1.6 : name === "mid" ? 1 : 0.5;
        f.y += f.v * H * dt;
        f.x += (this.wind * depth + Math.sin(t / 1000 * f.f + f.p) * L.sway) * W * dt;
        const m = f.s * u * 3;
        if (f.y > H + m) list[i] = this.spawn(name, false);
        else if (f.y < -H * 0.3) f.y += H * 1.3;
        if (f.x < -m) f.x += W + 2 * m; else if (f.x > W + m) f.x -= W + 2 * m;
        // Choque con paredes / techos: el copo se posa y vuelve a caer desde arriba.
        if (collide && f.y > 0 && scene.sampleScreen("solid", f.x, f.y, G) > 0.6) list[i] = this.spawn(name, false);
      }
    }
  }

  drawLayer(cv, names, ctx) {
    const c = cv.getContext("2d"), k = this.k, u = Math.min(this.W, this.H) / 360;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, cv.width, cv.height);
    for (const name of names) {
      const L = LAYERS[name], spr = SPRITES.flake[name];
      c.globalAlpha = L.alpha;
      for (const f of this.flakes[name]) {
        const s = f.s * u * k * (name === "near" ? 1 : 2.4);
        c.drawImage(spr, f.x * k - s / 2, f.y * k - s / 2, s, s);
      }
    }
    c.globalAlpha = 1;
  }

  // Recorta la capa: en interior solo dentro de ventanas; en exterior, fuera de los sólidos.
  occlude(cv, scene, G, indoor, occluder) {
    if (!scene.ready) return;
    const c = cv.getContext("2d"), k = this.k;
    if (indoor) {
      const m = this.mask.getContext("2d");
      m.setTransform(1, 0, 0, 1, 0, 0); m.clearRect(0, 0, this.mask.width, this.mask.height);
      m.setTransform(...scene.gridMatrix(G, k)); m.drawImage(scene.cv.window, 0, 0);
      m.setTransform(k, 0, 0, k, 0, 0); m.fillStyle = "#fff";
      for (const w of scene.windows) {
        m.beginPath();
        w.pts.forEach(([x, y], i) => { const [sx, sy] = apply(G, x, y); i ? m.lineTo(sx, sy) : m.moveTo(sx, sy); });
        m.fill();
      }
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = "destination-in";
      c.drawImage(this.mask, 0, 0);
    } else {
      c.setTransform(...scene.gridMatrix(G, k));
      c.globalCompositeOperation = "destination-out";
      c.drawImage(scene.cv[occluder], 0, 0);
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-over";
  }

  drawFar(ctx, scene, G, indoor) {
    this.drawLayer(this.far, ["far"]);
    this.occlude(this.far, scene, G, indoor, "far");
    ctx.drawImage(this.far, 0, 0, this.W, this.H);
  }

  drawNear(ctx, scene, G, indoor) {
    this.drawLayer(this.near, ["mid", "near"]);
    this.occlude(this.near, scene, G, indoor, "solid");
    ctx.drawImage(this.near, 0, 0, this.W, this.H);
  }
}
