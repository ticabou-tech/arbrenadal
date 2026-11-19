// Guardado de fotos.
//  · Navegadores con acceso a archivos (Chrome / Edge de escritorio): la app pide permiso
//    para una carpeta una vez y guarda ahí cada foto directamente. La carpeta se recuerda
//    entre visitas; si hace falta, el navegador vuelve a pedir permiso.
//  · iPhone / iPad: hoja de compartir → "Guardar imagen" (va a Fotos).
//  · Resto (Android, Firefox…): descarga directa (en Android aparece en la galería).

export const folderSupported = "showDirectoryPicker" in window;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// --- Persistencia del permiso de carpeta (IndexedDB) ---
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

let dir = null;
async function getDir() { return dir ||= await kv("photoDir"); }

export async function folderName() { return (await getDir())?.name; }

// Pide al usuario la carpeta donde guardar (requiere un toque del usuario).
export async function chooseFolder() {
  if (!folderSupported) return null;
  dir = await window.showDirectoryPicker({ id: "navidad-ar", mode: "readwrite", startIn: "pictures" });
  await kv("photoDir", dir);
  return dir.name;
}

async function ensurePermission(handle) {
  const o = { mode: "readwrite" };
  if (await handle.queryPermission?.(o) === "granted") return true;
  return (await handle.requestPermission?.(o)) === "granted";
}

const fileName = () => `navidad-ar-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jpg`;

// Devuelve un mensaje para el usuario.
export async function savePhoto(blob) {
  const name = fileName();
  if (folderSupported) {
    let d = await getDir();
    try {
      if (!d) { await chooseFolder(); d = dir; }
      if (d && await ensurePermission(d)) {
        const fh = await d.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob); await w.close();
        return `Foto guardada en «${d.name}»`;
      }
    } catch (e) {
      if (e.name === "AbortError") return "Foto no guardada";
      console.warn("No se pudo escribir en la carpeta, se descarga:", e);
      dir = null; await kv("photoDir", null);
    }
  }
  const file = new File([blob], name, { type: blob.type });
  if (isIOS && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Navidad AR" }); return "Foto lista: elige «Guardar imagen»"; }
    catch (e) { if (e.name === "AbortError") return "Foto no guardada"; }
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return "Foto descargada";
}
