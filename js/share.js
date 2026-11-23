// Empaquetado del entrenamiento por zonas para compartirlo entre dispositivos.
//
//  · Enlace: solo lo necesario para usarlo (pesos del clasificador y huellas de cada
//    zona), cuantizado a 8 bits y comprimido; viaja en el propio enlace (#entreno=…),
//    sin servidor. Quien lo abre lo recibe y se le guarda.
//  · Archivo: lo mismo más las muestras pintadas, para poder seguir entrenando en otro
//    dispositivo. Si se sube al repositorio como `entrenamiento.json`, la web lo carga
//    para todos los que la abran.

const APP = "navidad-ar-entreno", VERSION = 1;

const b64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const toUrl = s => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrl = s => s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);

async function pipe(u8, Stream, mode) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new Stream(mode))).arrayBuffer());
}
const canZip = typeof CompressionStream !== "undefined";

// --- Cuantización ---
function packW(W, K) {                     // int8 con escala por fila
  const D = W.length / K, q = new Int8Array(W.length), scales = [];
  for (let k = 0; k < K; k++) {
    let m = 1e-9; for (let d = 0; d < D; d++) m = Math.max(m, Math.abs(W[k * D + d]));
    const s = m / 127; scales.push(s);
    for (let d = 0; d < D; d++) q[k * D + d] = Math.round(W[k * D + d] / s);
  }
  return { q: b64(new Uint8Array(q.buffer)), scales };
}
function unpackW({ q, scales }) {
  const a = new Int8Array(unb64(q).buffer), K = scales.length, D = a.length / K, W = new Float32Array(a.length);
  for (let k = 0; k < K; k++) for (let d = 0; d < D; d++) W[k * D + d] = a[k * D + d] * scales[k];
  return W;
}
const packDesc = d => b64(Uint8Array.from(d, v => Math.round(Math.min(1, Math.max(0, v)) * 255)));
const unpackDesc = s => Float32Array.from(unb64(s), v => v / 255);
const packX = X => b64(new Uint8Array(Int8Array.from(X, v => Math.max(-127, Math.min(127, Math.round(v * 40)))).buffer));
const unpackX = s => Float32Array.from(new Int8Array(unb64(s).buffer), v => v / 40);

const pick = (a, n) => a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.round(i * (a.length - 1) / (n - 1))]);

// Una zona empaquetada: pesos (int8) y huellas (uint8). Sin muestras.
export function packZone(z, K, maxDescs = 99) {
  return {
    id: z.id, name: z.name, model: z.model, D: z.D, updated: z.updated, acc: z.acc, n: z.n,
    W: packW(z.W, K), descs: pick(z.descs || [], maxDescs).map(packDesc),
  };
}
export function unpackZone(z, created) {
  return {
    id: String(z.id), name: String(z.name || "Zona"), model: String(z.model), D: z.D | 0,
    updated: z.updated || created, acc: z.acc, n: z.n,
    W: unpackW(z.W), descs: (z.descs || []).map(unpackDesc),
    ...(z.X ? unpackSamples(z) : { X: null, y: null }),
  };
}
// Muestras pintadas (para seguir entrenando en otro dispositivo).
export const packSamples = z => ({ X: packX(z.X), y: b64(new Uint8Array(z.y.buffer, z.y.byteOffset, z.y.byteLength)) });
export const unpackSamples = m => ({ X: unpackX(m.X), y: new Int8Array(unb64(m.y).buffer) });

// zones: [{ id, name, model, D, W, X, y, descs, updated, acc, n }]
export function buildPackage(zones, K, withSamples) {
  return {
    app: APP, v: VERSION, created: new Date().toISOString(),
    // En el enlace viajan como mucho 4 huellas por zona (repartidas) para que no sea muy largo.
    zones: zones.filter(z => z.W).map(z => ({ ...packZone(z, K, withSamples ? 99 : 4), ...(withSamples && z.X && z.y ? packSamples(z) : {}) })),
  };
}

export function readPackage(pkg) {
  if (pkg?.app !== APP || !Array.isArray(pkg.zones)) throw new Error("no es un archivo de entrenamiento de Navidad AR");
  return { created: pkg.created, zones: pkg.zones.map(z => unpackZone(z, pkg.created)) };
}

export async function toLinkData(pkg) {
  const raw = new TextEncoder().encode(JSON.stringify(pkg));
  return canZip ? "z" + toUrl(b64(await pipe(raw, CompressionStream, "deflate-raw"))) : "r" + toUrl(b64(raw));
}

export async function fromLinkData(s) {
  let u8 = unb64(fromUrl(s.slice(1)));
  if (s[0] === "z") {
    if (typeof DecompressionStream === "undefined") throw new Error("este navegador no puede abrir enlaces comprimidos");
    u8 = await pipe(u8, DecompressionStream, "deflate-raw");
  }
  return JSON.parse(new TextDecoder().decode(u8));
}
