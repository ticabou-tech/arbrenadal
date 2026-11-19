// Configuración general de Navidad AR.
export const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

export const MODELS = {
  fast: "Xenova/segformer-b0-finetuned-ade-512-512",     // ~15 MB
  precise: "Xenova/segformer-b2-finetuned-ade-512-512",  // ~110 MB, detecta mejor
};

// Grupos de clases de ADE20K. Cada grupo es la suma de las probabilidades de sus clases.
export const GROUPS = {
  window: /^(windowpane|window)\b/i,
  wall: /^(wall|building|house|skyscraper|column)\b/i,
  ceiling: /^ceiling\b/i,
  tree: /^(tree|palm)\b/i,
  sky: /^sky\b/i,
};

export const CONFIG = {
  analysisWidth: 512,     // ancho de la imagen que se manda al modelo
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
