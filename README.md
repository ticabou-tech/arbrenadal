# 🎄 Arbrenadal — Navidad AR

Aplicación web de **realidad aumentada** que usa la cámara del móvil o del ordenador,
**detecta ventanas, paredes y árboles** y los decora de Navidad. La decoración queda
**anclada a la escena** (sigue el movimiento de la cámara), con **sombras**, **luces**
que iluminan su entorno y **nieve en 3D** que no atraviesa paredes ni techos.

| Detecta   | Decoración |
|-----------|------------|
| Ventanas  | Cristal escarchado con cristales de hielo, nieve acumulada en el alféizar, luces cálidas en el marco y nieve cayendo al otro lado |
| Árboles   | Luces que iluminan las ramas, bolas que se balancean al mover la cámara, espumillón dorado, nieve en las ramas (exterior) y estrella 3D giratoria |
| Paredes   | Guirnalda de pino en festones con luces, lazos y sombra sobre la pared; nieve acumulada en tejados y muros (exterior) |
| Todo      | Nieve en 3 capas de profundidad (lejos, media y bokeh cercano). En interior solo nieva tras las ventanas |

Las **fotos** se guardan siempre en la **galería de la app** (botón 🖼️, desde donde se
pueden volver a guardar o borrar) y además en el dispositivo: en una carpeta que eliges
una vez (Chrome / Edge de escritorio, botón 📁; la app pide permiso de acceso), con
"Guardar imagen" / "Guardar en Archivos" en iPhone, o en Descargas en Android y otros
navegadores.

Además permite **cambiar de cámara**, **pausar**, **modo noche**,
**luces cálidas**, elegir **detección rápida o precisa** y ver las **máscaras** detectadas.

## Enseñar a la IA por zonas (🎓)

Puedes entrenar la app para que funcione perfecta en **tus sitios** (2, 3 o más zonas:
patio, fachada, salón…):

1. Ve a la zona y pulsa **🎓**: se congela la imagen.
2. Elige la zona (o **➕ Nueva zona…** y ponle nombre).
3. Pinta encima con el dedo: **Ventana**, **Pared**, **Árbol**, **Techo**, **Cielo** o
   **Nada de esto** (para lo que la IA confunde). Bastan unos trazos en cada elemento.
4. Pulsa **Entrenar**. Enseña varias fotos de cada zona desde distintos ángulos: se
   acumulan y la zona se reconoce mejor.

La app **reconoce sola en qué zona estás** y usa su entrenamiento (selector **Zona:
Automática**, o elige una a mano). Para entrar en una zona tiene que reconocerla dos
análisis seguidos, y para salir no reconocerla en tres, así un fotograma movido no la cambia.

- Con **Decorar solo en mis zonas** (activado por defecto cuando hay zonas), fuera de
  ellas no se decora nada.
- **Dentro de una zona solo se decora lo que se pintó en ella**: pinta todo lo que
  quieras decorar. Lo pintado como **Nada de esto** apaga cualquier adorno en ese sitio.
- Al mover la cámara solo se dibuja lo confirmado en los últimos análisis, y si el
  seguimiento se pierde (movimiento brusco, imagen borrosa) se oculta todo hasta
  volver a confirmarlo: no quedan adornos donde no hay nada.

### Entrenamiento para todos (Firebase)

Configurando Firebase (gratis, unos 10 minutos: ver **[FIREBASE.md](FIREBASE.md)**), lo
que entrene un **entrenador** con sesión iniciada se guarda en la base de datos y
**todos los que abran la web lo reciben automáticamente**. Solo pueden publicar las
cuentas que tú autorices.

### Compartir sin base de datos

Desde el panel 🎓:

- **🔗 Enlace**: genera un enlace con el entrenamiento dentro (comprimido, sin
  servidor). Quien lo abre en su móvil lo recibe y se le queda guardado.
- **⬇️ Archivo**: descarga `entrenamiento.json` con todo (incluidas las muestras
  pintadas, para poder seguir entrenando en otro dispositivo). **⬆️ Importar** lo carga.
- **Para todo el mundo**: sube ese `entrenamiento.json` a la raíz del repositorio
  (GitHub → *Add file* → *Upload files*). La web lo publica y **cualquiera que la abra
  recibe tu entrenamiento automáticamente**. Si lo vuelves a subir actualizado, todos
  reciben la nueva versión.

El entrenamiento va ligado al modelo con el que se hizo (detección rápida o precisa).

Por dentro: para cada zona de la imagen se guardan las 150 puntuaciones del modelo (una
por tipo de objeto de ADE20K) y su color, y por cada zona se entrena un clasificador
lineal (regresión logística multiclase) cuyo resultado se combina con el del modelo. Cada
zona guarda además "huellas" de sus fotos (qué clases hay en cada parte de la imagen y sus
colores) para reconocerla. Todo se guarda en el dispositivo (IndexedDB).

## Cómo funciona

```
cámara ──► seguimiento de movimiento (cada fotograma) ──► G: mundo → pantalla
   │                                                         │
   └─► IA en Web Worker (SegFormer, ~8 análisis/s) ──► escena ┤──► dibujo 60 FPS
                                                              │    (sombras · adornos · luz · nieve)
       estimación de la luz real (brillo, tono, dirección) ───┘
```

- **Detección**: [SegFormer entrenado en ADE20K](https://huggingface.co/Xenova/segformer-b0-finetuned-ade-512-512)
  con [Transformers.js](https://huggingface.co/docs/transformers.js) dentro del navegador
  (WebGPU o WASM). No se envía ninguna imagen a ningún servidor. Se usan las
  **probabilidades** de cada clase (no solo la clase ganadora), se fusionan en el tiempo
  compensando el movimiento de la cámara, y las ventanas se ajustan a **cuadriláteros nítidos**.
  La imagen entra con su **proporción real** (sin aplastarla) y se alterna con su versión
  en **espejo**. Cuadros, puertas, cortinas o muebles altos cuentan como parte de la pared,
  los paneles de una misma ventana se unen, y los bordes de ventanas y paredes se
  **ajustan a las líneas reales** de la imagen (marcos, unión pared-techo, cornisas).
- **Rendimiento**: modelo en **fp16** con WebGPU (cuantizado q8 en CPU), preprocesado
  propio y **resolución adaptativa** (320–640 px) para mantener ~170 ms por análisis;
  con el seguimiento de movimiento la animación va a 60 FPS aunque el modelo sea lento.
- **Seguimiento (RA)**: flujo óptico por bloques contra un fotograma clave
  (traslación global + bloques refinados con Lucas-Kanade + ajuste robusto de
  traslación, giro y zoom). Toda la decoración vive en coordenadas de "mundo", así que
  se mueve con la escena entre un análisis y el siguiente.
- **Simulación 3D**: sombras suaves proyectadas en dirección opuesta a la luz detectada,
  exposición y tono de los adornos ajustados a la escena, luz emitida sumada aparte
  (las bombillas brillan más cuanto más oscuro está), péndulo físico en las bolas,
  paralaje y desenfoque en la nieve cercana.

## Archivos

```
index.html          Estructura de la página
style.css           Estilos (adaptados a móvil)
js/main.js          Bucle principal: cámara, seguimiento, IA, luz y composición de capas
js/worker.js        IA de segmentación (Web Worker)
js/tracker.js       Seguimiento del movimiento de la cámara
js/scene.js         Fusión de análisis y geometría: ventanas, árboles, borde de paredes
js/decor.js         Dibujo de la decoración (ventanas, árboles, paredes)
js/teach.js         Modo «Enseñar»: pintar, etiquetas y persistencia de lo aprendido
js/cloud.js         Entrenamiento compartido en Firebase (Firestore + cuentas de entrenador)
js/share.js         Empaquetado del entrenamiento (enlace, archivo, nube)
js/store.js         Almacén persistente (IndexedDB)
js/photos.js        Guardado de fotos (galería interna + carpeta con permiso, Guardar como, Fotos/Archivos en iPhone o descarga)
js/snow.js          Nieve en 3 capas con oclusión y colisiones
js/sprites.js       Sprites pre-renderizados (bombillas, bolas, estrella, guirnalda…)
js/geom.js          Utilidades geométricas
js/config.js        Parámetros ajustables
.github/workflows/pages.yml   Publicación automática en GitHub Pages
firebase/firestore.rules      Reglas de seguridad de la base de datos
FIREBASE.md                   Guía para activar el entrenamiento compartido
```

## Probarlo en local

La cámara solo funciona en **https** o en **localhost**. Desde la carpeta del proyecto:

```bash
python3 -m http.server 8000
```

y abre <http://localhost:8000>. La primera vez descarga el modelo (~15 MB en modo
rápido, ~110 MB en modo preciso); después queda en caché.

## Publicarlo en GitHub Pages

1. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Haz push a la rama `main` (o lanza el workflow a mano desde la pestaña **Actions**).
3. La web quedará en `https://<usuario>.github.io/arbrenadal/`.

## Consejos de uso

- Mueve la cámara con suavidad: el seguimiento necesita algo de textura (ladrillos,
  muebles, ramas…). Sobre una pared lisa y uniforme cuesta más.
- Si una ventana o pared no se detecta bien, prueba **Detección: Precisa**.
- **Noche** oscurece la imagen para que las luces luzcan más.

## Ajustes (`js/config.js`)

| Parámetro       | Efecto |
|-----------------|--------|
| `thresholds`    | Umbral de probabilidad por clase (más bajo = detecta más, con más falsos positivos) |
| `blend`         | Peso de cada análisis nuevo (más bajo = más estable, más alto = reacciona antes) |
| `snow`          | Número de copos por capa |
| `minTreeArea`, `minWindowArea` | Tamaño mínimo para decorar |
