# 🎄 Arbrenadal — Navidad AR

Aplicación web de realidad aumentada que usa la cámara del móvil o del ordenador,
**detecta ventanas, paredes y árboles** y los decora de Navidad en tiempo real:

| Detecta   | Decoración |
|-----------|------------|
| Ventanas  | Cristal escarchado (más intenso en los bordes) y nieve cayendo dentro del cristal |
| Árboles   | Luces que parpadean, bolas de colores y una estrella en la copa de cada árbol |
| Paredes   | Guirnalda en festón siguiendo el borde superior, con luces "persecución" y lazos rojos |

Además permite **hacer fotos** (se descargan o se comparten desde el móvil),
**cambiar de cámara** (trasera/frontal), **pausar** y ver las **máscaras** detectadas.

## Cómo funciona

- Segmentación semántica con [SegFormer-B0 entrenado en ADE20K](https://huggingface.co/Xenova/segformer-b0-finetuned-ade-512-512)
  ejecutado **en el navegador** con [Transformers.js](https://huggingface.co/docs/transformers.js).
  No se envía ninguna imagen a ningún servidor.
- Usa **WebGPU** si está disponible y, si no, **WASM** (más lento).
- El análisis se hace a baja resolución (256 px de ancho) y a pocos FPS; las máscaras
  se suavizan en el tiempo para evitar parpadeos, y los efectos se dibujan a 60 FPS.
- Clases de ADE20K usadas: `windowpane` → ventana; `tree`, `palm` → árbol;
  `wall`, `building`, `house` → pared. Se pueden cambiar en `CONFIG.classes` (`app.js`).

## Archivos

```
index.html   Estructura de la página
style.css    Estilos (adaptados a móvil, con zonas seguras del notch)
app.js       Cámara, modelo, análisis de la escena y efectos
.github/workflows/pages.yml   Publicación automática en GitHub Pages
```

## Probarlo en local

La cámara solo funciona en **https** o en **localhost**. Desde la carpeta del proyecto:

```bash
python3 -m http.server 8000
```

y abre <http://localhost:8000>. La primera vez descarga el modelo (~15 MB); después queda en caché.

Para probarlo en el móvil hace falta https: lo más sencillo es GitHub Pages (abajo).

## Publicarlo en GitHub Pages

1. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Haz push a la rama `main` (o lanza el workflow a mano desde la pestaña **Actions**).
3. La web quedará en `https://<usuario>.github.io/arbrenadal/`.

## Requisitos del navegador

- Chrome / Edge (escritorio y Android) recientes: WebGPU, va fluido.
- Safari iOS 17+ / Firefox: funciona con WASM, algo más lento.
- Se necesita conexión a internet la primera vez (librería y modelo se cargan desde CDN / Hugging Face).

## Ajustes útiles (`CONFIG` en `app.js`)

| Parámetro       | Efecto |
|-----------------|--------|
| `analysisWidth` | Más alto = máscaras más precisas pero más lento |
| `ema`           | Más bajo = más estable, más alto = reacciona antes al mover la cámara |
| `minArea`       | Tamaño mínimo para decorar un árbol |
