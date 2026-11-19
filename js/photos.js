// Guardado de fotos.
//
// 1) Cada foto se guarda SIEMPRE en la galería interna de la app (almacenamiento privado
//    del navegador, OPFS, marcado como persistente), así nunca se pierde.
// 2) Además se exporta a un archivo del dispositivo:
//    · Chrome / Edge de escritorio: carpeta elegida una vez (la app pide permiso y lo
//      recuerda entre visitas).
//    · Navegadores con "Guardar como" (showSaveFilePicker): diálogo del sistema.
//    · iPhone / iPad: hoja de compartir → "Guardar imagen" (Fotos) o "Guardar en Archivos".
//    · Resto (Android, Firefox…): descarga a la carpeta Descargas.
// Los permisos se piden dentro del toque del usuario (si no, el navegador los rechaza).

export const folderSupported = "showDirectoryPicker" in window;
const saveAsSupported = "showSaveFilePicker" in window;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------------------
// Persistencia del permiso de carpeta (IndexedDB)
// ---------------------------------------------------------------------------
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("navidad-ar", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kv(key, value) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const tx = d.transaction("kv", value === undefined ? "readonly" : "readwrite"), st = tx.objectStore("kv");
      const r = value === undefined ? st.get(key) : st.put(value, key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  } catch { return undefined; }
}

let dir = null, dirLoaded = false;
const dirReady = kv("photoDir").then(d => { dir = d || null; dirLoaded = true; });

export async function folderName() { await dirReady; return dir?.name; }

// Pide al usuario la carpeta donde guardar (llamar dentro de un toque del usuario).
export async function chooseFolder() {
  if (!folderSupported) return null;
  dir = await window.showDirectoryPicker({ id: "navidad-ar", mode: "readwrite", startIn: "pictures" });
  await kv("photoDir", dir);
  return dir.name;
}

// ---------------------------------------------------------------------------
// Galería interna (OPFS)
// ---------------------------------------------------------------------------
let galleryDir = null;
async function gallery() {
  if (galleryDir) return galleryDir;
  if (!navigator.storage?.getDirectory) return null;
  navigator.storage.persist?.().catch(() => {});
  galleryDir = await (await navigator.storage.getDirectory()).getDirectoryHandle("fotos", { create: true });
  return galleryDir;
}

async function storeInGallery(name, blob) {
  try {
    const g = await gallery(); if (!g) return false;
    const fh = await g.getFileHandle(name, { create: true }), w = await fh.createWritable();
    await w.write(blob); await w.close();
    return true;
  } catch (e) { console.warn("No se pudo guardar en la galería:", e); return false; }
}

export async function listPhotos() {
  const g = await gallery(); if (!g) return [];
  const out = [];
  for await (const [name, h] of g.entries()) if (h.kind === "file") out.push({ name, file: await h.getFile() });
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export async function deletePhoto(name) { const g = await gallery(); await g?.removeEntry(name); }

// ---------------------------------------------------------------------------
// Exportar a un archivo del dispositivo
// ---------------------------------------------------------------------------
async function writeTo(handle, blob) { const w = await handle.createWritable(); await w.write(blob); await w.close(); }

// Devuelve un texto que describe dónde quedó la foto.
export async function exportPhoto(blob, name) {
  // a) Carpeta con permiso (escritorio).
  if (folderSupported) {
    try {
      if (!dirLoaded) await dirReady;
      if (!dir) await chooseFolder();
      const o = { mode: "readwrite" };
      let ok = (await dir.queryPermission?.(o)) === "granted";
      if (!ok) ok = (await dir.requestPermission?.(o)) === "granted";
      if (ok) { await writeTo(await dir.getFileHandle(name, { create: true }), blob); return `en la carpeta «${dir.name}»`; }
    } catch (e) {
      if (e.name === "AbortError") return null;
      console.warn("No se pudo usar la carpeta:", e);
      if (e.name === "NotFoundError" || e.name === "NotAllowedError") { dir = null; kv("photoDir", null); }
    }
  }
  // b) Diálogo "Guardar como".
  if (saveAsSupported && !folderSupported) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, startIn: "pictures", types: [{ description: "Foto JPEG", accept: { "image/jpeg": [".jpg"] } }] });
      await writeTo(h, blob); return `en «${h.name}»`;
    } catch (e) { if (e.name === "AbortError") return null; console.warn(e); }
  }
  // c) iPhone / iPad: compartir → Guardar imagen / Guardar en Archivos.
  const file = new File([blob], name, { type: blob.type });
  if (isIOS && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return "con «Guardar imagen» o «Guardar en Archivos»"; }
    catch (e) { if (e.name === "AbortError") return null; }
  }
  // d) Descarga.
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return "en Descargas";
}

export const photoName = () => `navidad-ar-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jpg`;

// Guarda una foto: galería interna + archivo del dispositivo. Devuelve un mensaje.
export async function savePhoto(blob) {
  const name = photoName();
  const [where, inGallery] = await Promise.all([exportPhoto(blob, name), storeInGallery(name, blob)]);
  if (where) return `Foto guardada ${where}`;
  return inGallery ? "Foto guardada en la galería de la app (🖼️)" : "No se pudo guardar la foto";
}
