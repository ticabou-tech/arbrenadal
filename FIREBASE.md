# Entrenamiento compartido para todos con Firebase

Con esto, lo que se entrena en la app (🎓) se guarda en una base de datos de Google
(Firebase) y **todos los que abran la web lo reciben automáticamente**. Solo pueden
publicar las cuentas de entrenador que tú crees. Es gratis para este uso (plan Spark).

Tarda unos 10 minutos y solo hay que hacerlo una vez.

## 1. Crear el proyecto

1. Entra en <https://console.firebase.google.com> con tu cuenta de Google.
2. **Crear un proyecto** → ponle nombre (p. ej. `arbrenadal`) → puedes desactivar
   Google Analytics → **Crear proyecto**.

## 2. Base de datos (Firestore)

1. Menú izquierdo: **Compilación → Firestore Database → Crear base de datos**.
2. Ubicación: `eur3 (europe-west)` o la más cercana → **Siguiente**.
3. Elige **Iniciar en modo de producción** → **Crear**.
4. Pestaña **Reglas**: borra lo que haya, pega el contenido de
   [`firebase/firestore.rules`](firebase/firestore.rules) y pulsa **Publicar**.

## 3. Cuentas de entrenador

1. Menú: **Compilación → Authentication → Comenzar**.
2. En **Método de acceso**, activa **Correo electrónico/contraseña** → **Guardar**.
3. Pestaña **Usuarios → Agregar usuario**: escribe el correo y una contraseña para cada
   entrenador (tú y quien quieras).
4. Vuelve a **Firestore Database → Datos → Iniciar colección**:
   - ID de la colección: `entrenadores`
   - ID del documento: **el correo del entrenador** (exactamente igual, p. ej.
     `ana@gmail.com`)
   - Añade un campo cualquiera, p. ej. `nombre` (string) = `Ana` → **Guardar**.
   - Repite **Agregar documento** para cada entrenador.

   Solo los correos de esta lista pueden publicar. Aunque alguien se creara una cuenta,
   no podría cambiar nada.

## 4. Conectar la web

1. **Configuración del proyecto** (rueda dentada arriba a la izquierda) → **General** →
   en *Tus apps* pulsa el icono **`</>`** (web) → ponle un nombre → **Registrar app**
   (no hace falta Hosting).
2. Te muestra un bloque `firebaseConfig`. Copia dos valores: `apiKey` y `projectId`.
3. En el repositorio, edita [`js/config.js`](js/config.js) y pégalos:

   ```js
   export const FIREBASE = {
     apiKey: "AIza…",
     projectId: "arbrenadal-1234",
   };
   ```

   (En GitHub: abre el archivo → lápiz ✏️ → pega → **Commit changes**.) La web se
   vuelve a publicar sola en unos segundos. La `apiKey` de Firebase no es secreta: la
   seguridad la ponen las reglas del paso 2.

## 5. Usarlo

- **Entrenador**: en la app pulsa 🎓 → en la fila *Entrenador* escribe tu correo y
  contraseña → **Iniciar sesión**. A partir de ahí, cada vez que pulses **Entrenar** la
  zona se publica para todos. Si ya tenías zonas entrenadas en el móvil, pulsa
  **☁️ Publicar todas mis zonas**.
- **Todos los demás**: no tienen que hacer nada. Al abrir la web reciben las zonas, y
  las novedades llegan solas (al volver a la app y cada 5 minutos).
- Un entrenador puede ampliar una zona desde cualquier móvil (se recupera lo pintado
  antes) o borrarla para todos (🗑️ Borrar zona).

El entrenamiento va ligado al modelo de detección (rápida / precisa): lo que entrenes
con uno lo reciben quienes usen ese mismo.
