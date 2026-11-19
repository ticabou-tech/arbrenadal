// Almacén clave-valor persistente (IndexedDB) compartido por la app.
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("navidad-ar", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

// kv(clave) lee; kv(clave, valor) escribe. Nunca lanza: devuelve undefined si falla.
export async function kv(key, value) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const tx = d.transaction("kv", value === undefined ? "readonly" : "readwrite"), st = tx.objectStore("kv");
      const r = value === undefined ? st.get(key) : st.put(value, key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  } catch { return undefined; }
}
