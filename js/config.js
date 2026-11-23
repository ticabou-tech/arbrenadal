// Configuración general de Navidad AR.
// Entrenamiento compartido para todos (Firebase). Pega aquí la "apiKey" y el "projectId"
// de tu proyecto (Configuración del proyecto → General → Tus apps → app web). La apiKey
// de Firebase es pública por diseño: lo que se puede hacer con ella lo limitan las reglas
// de firebase/firestore.rules. Si se dejan vacíos, cada móvil guarda solo lo suyo.
export const FIREBASE = {
  apiKey: "AIzaSyAsgXxAxa8uxE0UsIFcBThIGnOrrEtTOII",
  projectId: "arbrenadal",
};

export const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

export const MODELS = {
  fast: "Xenova/segformer-b0-finetuned-ade-512-512",     // ~15 MB
  precise: "Xenova/segformer-b2-finetuned-ade-512-512",  // ~110 MB (~55 MB en fp16), detecta mejor
};

// Precisión numérica a probar en cada dispositivo (la primera que funcione).
// fp16 en WebGPU: la mitad de memoria y cálculo; q8 (cuantizado) en CPU.
export const DTYPES = { webgpu: ["fp16", "fp32"], wasm: ["q8", "fp32"] };

// Anchos de entrada posibles (múltiplos de 32). Se ajusta solo según la velocidad.
export const SIZES = [320, 384, 448, 512, 576, 640];
export const START_SIZE = { fast: 512, precise: 448 };
export const TARGET_MS = 170;       // tiempo objetivo por análisis

// Grupos de clases de ADE20K. Cada grupo es la suma de las probabilidades de sus clases.
export const GROUPS = {
  window: /^(windowpane|window)\b/i,
  wall: /^(wall|building|house|skyscraper|column|tower)\b/i,
  // Objetos que están en la pared y no deben "romperla" (cuadros, puertas, cortinas…).
  onwall: /^(painting|mirror|door|double door|curtain|blind|bulletin board|poster|shelf|bookcase|cabinet|wardrobe|chest of drawers|radiator|clock|fireplace|signboard|screen door|plaything|sconce|switch)\b/i,
  ceiling: /^ceiling\b/i,
  roof: /^(awning|canopy|hood)\b/i,       // toldos, marquesinas: la nieve tampoco los atraviesa
  tree: /^(tree|palm)\b/i,
  sky: /^sky\b/i,
};

// Clases que el usuario puede pintar en el modo "Enseñar" (el orden importa: índice = etiqueta).
export const TEACH_CLASSES = ["window", "wall", "tree", "ceiling", "sky", "other"];
export const TEACH_UI = [
  { name: "Ventana", color: "#3d8bff" }, { name: "Pared", color: "#ff9a3c" }, { name: "Árbol", color: "#3ccf5a" },
  { name: "Techo", color: "#b46bff" }, { name: "Cielo", color: "#7fd6ff" }, { name: "Nada de esto", color: "#9e9e9e" },
];

export const CONFIG = {
  trackWidth: 160,        // ancho al que se calcula el movimiento de la cámara
  blend: 0.5,             // peso de cada análisis nuevo al fusionar con lo anterior
  thresholds: { window: 0.38, wall: 0.5, ceiling: 0.45, tree: 0.45, sky: 0.5 },
  minTreeArea: 0.004,     // fracción de la imagen
  minWindowArea: 0.003,
  snow: { far: 260, mid: 110, near: 18 },   // copos por capa
};

export const LIGHTS = ["#ff4d4d", "#ffd36b", "#5ee08a", "#5cc8ff", "#ff8ad8"];
export const WARM = "#ffd89a";
export const BAUBLES = ["#b71c1c", "#c9a227", "#0d47a1", "#6a1b9a", "#cfd8dc", "#1b5e20"];
