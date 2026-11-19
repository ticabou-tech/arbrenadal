// Sprites pre-renderizados: dibujar imágenes es mucho más rápido que usar shadowBlur
// o gradientes en cada fotograma, sobre todo en el móvil.
import { LIGHTS, WARM, BAUBLES } from "./config.js";

export const mkCanvas = (w = 1, h = 1) => Object.assign(document.createElement("canvas"), { width: w, height: h });

// Generador pseudoaleatorio con semilla (texturas iguales en cada carga).
function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// Bombilla: núcleo casi blanco, color saturado alrededor y caída suave (bloom).
function bulb(color) {
  const S = 64, c = mkCanvas(S, S), x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.08, "rgba(255,255,240,1)");
  g.addColorStop(0.18, rgba(color, 1));
  g.addColorStop(0.4, rgba(color, 0.35));
  g.addColorStop(1, rgba(color, 0));
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  return c;
}

// Halo grande y tenue: la luz que la bombilla proyecta sobre lo que tiene alrededor.
function halo(color) {
  const S = 64, c = mkCanvas(S, S), x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, rgba(color, 0.55)); g.addColorStop(0.5, rgba(color, 0.15)); g.addColorStop(1, rgba(color, 0));
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  return c;
}

// Bola de Navidad: esfera con sombreado, brillo especular, reflejo de borde y enganche dorado.
function bauble(color) {
  const S = 96, c = mkCanvas(S, S), x = c.getContext("2d"), cx = 48, cy = 54, r = 34;
  // sombra de contacto
  const sh = x.createRadialGradient(cx + 6, cy + 10, r * 0.6, cx + 6, cy + 10, r * 1.15);
  sh.addColorStop(0, "rgba(0,0,0,.35)"); sh.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = sh; x.beginPath(); x.arc(cx + 6, cy + 10, r * 1.15, 0, 7); x.fill();
  // cuerpo
  const g = x.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r);
  g.addColorStop(0, "#ffffff"); g.addColorStop(0.12, rgba(color, 1)); g.addColorStop(0.75, rgba(color, 1)); g.addColorStop(1, "#000");
  x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill();
  // reflejo de ventana en el cristal
  x.fillStyle = "rgba(255,255,255,.55)";
  x.beginPath(); x.ellipse(cx - r * 0.38, cy - r * 0.42, r * 0.16, r * 0.09, -0.7, 0, 7); x.fill();
  // brillo de borde inferior
  x.strokeStyle = "rgba(255,255,255,.18)"; x.lineWidth = 3;
  x.beginPath(); x.arc(cx, cy, r - 3, 0.3, Math.PI - 0.3); x.stroke();
  // enganche
  const cap = x.createLinearGradient(cx - 7, 0, cx + 7, 0);
  cap.addColorStop(0, "#7a5d12"); cap.addColorStop(0.5, "#f5d76e"); cap.addColorStop(1, "#7a5d12");
  x.fillStyle = cap; x.fillRect(cx - 7, cy - r - 7, 14, 10);
  x.strokeStyle = "#c9a227"; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy - r - 10, 4, 0, 7); x.stroke();
  return c;
}

// Estrella metálica con biselado (cada punta en dos caras de distinta luz), halo y destellos.
function star() {
  const S = 256, c = mkCanvas(S, S), x = c.getContext("2d"), m = S / 2;
  const glow = x.createRadialGradient(m, m, 0, m, m, m);
  glow.addColorStop(0, "rgba(255,236,150,.75)"); glow.addColorStop(0.3, "rgba(255,200,80,.25)"); glow.addColorStop(1, "rgba(255,200,80,0)");
  x.fillStyle = glow; x.fillRect(0, 0, S, S);
  x.strokeStyle = "rgba(255,245,200,.5)"; x.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, l = i % 2 ? m * 0.55 : m * 0.95;
    x.beginPath(); x.moveTo(m, m); x.lineTo(m + l * Math.cos(a), m + l * Math.sin(a)); x.stroke();
  }
  const R = 64, r = 26;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
    const tip = [m + R * Math.cos(a), m + R * Math.sin(a)];
    const l = [m + r * Math.cos(a - Math.PI / 5), m + r * Math.sin(a - Math.PI / 5)];
    const rr = [m + r * Math.cos(a + Math.PI / 5), m + r * Math.sin(a + Math.PI / 5)];
    for (const [side, col] of [[l, i < 3 ? "#fff1a8" : "#e8b830"], [rr, i < 2 ? "#f2c440" : "#b98400"]]) {
      x.fillStyle = col; x.beginPath(); x.moveTo(m, m); x.lineTo(...tip); x.lineTo(...side); x.closePath(); x.fill();
    }
  }
  x.fillStyle = "rgba(255,255,255,.9)"; x.beginPath(); x.arc(m - 6, m - 8, 5, 0, 7); x.fill();
  return c;
}

// Trozo de guirnalda de pino: muchas agujas de distintos verdes, alguna piña.
function garland() {
  const S = 128, c = mkCanvas(S, 56), x = c.getContext("2d"), R = rng(7);
  x.lineCap = "round";
  for (let i = 0; i < 420; i++) {
    const px = 8 + R() * (S - 16), py = 28 + (R() - 0.5) * 14;
    const a = R() * Math.PI * 2, l = 7 + R() * 11, shade = R();
    const g = Math.round(60 + shade * 90), r = Math.round(15 + shade * 30), b = Math.round(20 + shade * 25);
    x.strokeStyle = `rgb(${r},${g},${b})`; x.lineWidth = 1.2 + R() * 1.3;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + l * Math.cos(a), py + l * Math.sin(a) * 0.8); x.stroke();
  }
  for (let i = 0; i < 2; i++) {
    const px = 30 + i * 60 + R() * 10, py = 32 + R() * 6;
    x.fillStyle = "#5d3a1a"; x.beginPath(); x.ellipse(px, py, 5, 8, 0.3, 0, 7); x.fill();
    x.strokeStyle = "#3b220c"; x.lineWidth = 1;
    for (let k = -2; k <= 2; k++) { x.beginPath(); x.moveTo(px - 5, py + k * 3); x.lineTo(px + 5, py + k * 3 + 1); x.stroke(); }
  }
  return c;
}

// Lazo rojo de terciopelo.
function bow() {
  const S = 96, c = mkCanvas(S, S), x = c.getContext("2d");
  const red = x.createLinearGradient(0, 20, 0, 80);
  red.addColorStop(0, "#ef5350"); red.addColorStop(0.5, "#c62828"); red.addColorStop(1, "#7f0000");
  x.fillStyle = red; x.strokeStyle = "rgba(60,0,0,.6)"; x.lineWidth = 1.5;
  const loop = s => { x.beginPath(); x.moveTo(48, 38); x.bezierCurveTo(48 + s * 20, 6, 48 + s * 46, 16, 48 + s * 40, 40); x.bezierCurveTo(48 + s * 36, 56, 48 + s * 16, 50, 48, 40); x.fill(); x.stroke(); };
  const tail = s => { x.beginPath(); x.moveTo(46 + s * 2, 42); x.lineTo(48 + s * 18, 88); x.lineTo(48 + s * 24, 80); x.lineTo(48 + s * 30, 86); x.lineTo(50 + s * 6, 40); x.closePath(); x.fill(); x.stroke(); };
  tail(-1); tail(1); loop(-1); loop(1);
  x.beginPath(); x.ellipse(48, 40, 8, 10, 0, 0, 7); x.fill(); x.stroke();
  x.fillStyle = "rgba(255,255,255,.25)"; x.beginPath(); x.ellipse(30, 24, 8, 3, -0.5, 0, 7); x.fill();
  return c;
}

// Copos: lejano (punto suave), medio (con núcleo) y cercano (bokeh desenfocado).
function flake(kind) {
  const S = 64, c = mkCanvas(S, S), x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  if (kind === "near") {
    g.addColorStop(0, "rgba(255,255,255,.55)"); g.addColorStop(0.7, "rgba(255,255,255,.45)");
    g.addColorStop(0.85, "rgba(255,255,255,.5)"); g.addColorStop(1, "rgba(255,255,255,0)");
  } else if (kind === "mid") {
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(250,252,255,.9)"); g.addColorStop(1, "rgba(240,248,255,0)");
  } else {
    g.addColorStop(0, "rgba(255,255,255,.9)"); g.addColorStop(1, "rgba(255,255,255,0)");
  }
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  return c;
}

// Textura de escarcha: cristales dendríticos que crecen al azar.
function frost() {
  const S = 256, c = mkCanvas(S, S), x = c.getContext("2d"), R = rng(42);
  x.lineCap = "round";
  const branch = (px, py, a, len, w, depth) => {
    if (depth > 3 || len < 2) return;
    const ex = px + Math.cos(a) * len, ey = py + Math.sin(a) * len;
    x.strokeStyle = `rgba(255,255,255,${0.25 + 0.5 * R()})`; x.lineWidth = w;
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {   // continuo al repetir
      x.beginPath(); x.moveTo(px + ox, py + oy); x.lineTo(ex + ox, ey + oy); x.stroke();
    }
    const n = 1 + Math.floor(R() * 2);
    for (let i = 0; i < n; i++) {
      const t = 0.3 + R() * 0.7, bx = px + (ex - px) * t, by = py + (ey - py) * t;
      branch(bx, by, a + (R() < 0.5 ? -1 : 1) * (0.5 + R() * 0.6), len * (0.35 + R() * 0.3), w * 0.7, depth + 1);
    }
    branch(ex, ey, a + (R() - 0.5) * 0.4, len * 0.7, w * 0.85, depth + 1);
  };
  for (let i = 0; i < 26; i++) branch(R() * S, R() * S, R() * Math.PI * 2, 18 + R() * 30, 1.6, 0);
  for (let i = 0; i < 900; i++) { x.fillStyle = `rgba(255,255,255,${R() * 0.35})`; x.fillRect(R() * S, R() * S, 1.2, 1.2); }
  return c;
}

export const SPRITES = {
  bulb: LIGHTS.map(bulb), halo: LIGHTS.map(halo),
  warmBulb: bulb(WARM), warmHalo: halo(WARM),
  bauble: BAUBLES.map(bauble),
  star: star(), garland: garland(), bow: bow(), frost: frost(),
  flake: { far: flake("far"), mid: flake("mid"), near: flake("near") },
};
