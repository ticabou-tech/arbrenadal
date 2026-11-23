// Entrenamiento compartido en la nube con Firebase (Firestore + Authentication).
//
//  · Todo el mundo LEE las zonas entrenadas (pesos y huellas) al abrir la web.
//  · Solo los ENTRENADORES (cuentas de correo y contraseña que crea el dueño y que están
//    en la colección "entrenadores") pueden publicar, cambiar o borrar zonas; las muestras
//    pintadas solo las leen ellos (para seguir entrenando desde cualquier móvil).
//
// Se usan las API REST de Firebase directamente (sin librerías). La configuración está en
// config.js (FIREBASE); si está vacía, la app funciona igual pero solo con lo local.
// Las reglas de seguridad están en firebase/firestore.rules.
import { FIREBASE } from "./config.js";

export const cloudEnabled = !!(FIREBASE.apiKey && FIREBASE.projectId);
const DOCS = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents`;
const AUTH = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FIREBASE.apiKey;
const REFRESH = "https://securetoken.googleapis.com/v1/token?key=" + FIREBASE.apiKey;
const SESSION_KEY = "navidad-ar-entrenador";
const CHUNK = 700000;               // Firestore admite documentos de hasta 1 MiB

let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { session = null; }
const saveSession = s => { session = s; try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* nada */ } };

export const trainer = () => session?.email || null;

async function request(url, { method = "GET", body, form, auth = false } = {}) {
  const headers = {};
  if (auth) { await refreshIfNeeded(); headers.Authorization = "Bearer " + session.idToken; }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const r = await fetch(url, { method, headers, body: form ? new URLSearchParams(form) : body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* nada */ }
    if (r.status === 404 && method === "GET") return null;
    if (r.status === 401 || r.status === 403 || /PERMISSION_DENIED/.test(msg)) msg = "no autorizado: esta cuenta no es de entrenador";
    if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/.test(msg)) msg = "correo o contraseña incorrectos";
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}

// --- Cuentas de entrenador ---
export async function signIn(email, password) {
  const r = await request(AUTH, { method: "POST", body: { email, password, returnSecureToken: true } });
  saveSession({ email: r.email, idToken: r.idToken, refreshToken: r.refreshToken, expiresAt: Date.now() / 1000 + +r.expiresIn });
  return trainer();
}
export function signOut() { saveSession(null); }

async function refreshIfNeeded() {
  if (!session) throw new Error("inicia sesión de entrenador");
  if (session.expiresAt - 60 > Date.now() / 1000) return;
  try {
    const r = await request(REFRESH, { method: "POST", form: { grant_type: "refresh_token", refresh_token: session.refreshToken } });
    saveSession({ ...session, idToken: r.id_token, refreshToken: r.refresh_token, expiresAt: Date.now() / 1000 + +r.expires_in });
  } catch { saveSession(null); throw new Error("la sesión de entrenador ha caducado: vuelve a iniciarla"); }
}

// --- Conversión a los campos tipados de Firestore ---
const str = v => ({ stringValue: v }), int = v => ({ integerValue: String(v) }), ts = v => ({ timestampValue: v });
const val = f => f?.stringValue ?? (f?.integerValue !== undefined ? +f.integerValue : f?.timestampValue);

// --- Zonas ---
// Fila: { id, nombre, modelo, dim, paquete, actualizada }  (paquete = zona empaquetada por share.js)
export async function fetchZones(model) {
  const rows = [];
  let token = "";
  do {
    const r = await request(`${DOCS}/zonas?pageSize=300${token ? "&pageToken=" + encodeURIComponent(token) : ""}`);
    for (const d of r?.documents || []) {
      const f = d.fields || {};
      if (val(f.modelo) !== model) continue;
      try { rows.push({ id: d.name.split("/").pop(), nombre: val(f.nombre), modelo: val(f.modelo), dim: val(f.dim), paquete: JSON.parse(val(f.paquete)), actualizada: val(f.actualizada) }); }
      catch { /* documento dañado: se ignora */ }
    }
    token = r?.nextPageToken || "";
  } while (token);
  return rows;
}

export async function publishZone(row, samples) {
  await request(`${DOCS}/zonas/${encodeURIComponent(row.id)}`, {
    method: "PATCH", auth: true,
    body: { fields: { nombre: str(row.nombre), modelo: str(row.modelo), dim: int(row.dim), paquete: str(JSON.stringify(row.paquete)), actualizada: ts(row.actualizada) } },
  });
  if (!samples) return;
  // Las muestras pueden superar 1 MiB: se guardan en trozos.
  const text = JSON.stringify(samples), parts = Math.ceil(text.length / CHUNK);
  for (let i = 0; i < parts; i++) {
    await request(`${DOCS}/zonas_muestras/${encodeURIComponent(row.id)}/partes/${i}`, { method: "PATCH", auth: true, body: { fields: { datos: str(text.slice(i * CHUNK, (i + 1) * CHUNK)) } } });
  }
  await request(`${DOCS}/zonas_muestras/${encodeURIComponent(row.id)}`, { method: "PATCH", auth: true, body: { fields: { partes: int(parts), actualizada: ts(row.actualizada) } } });
}

export async function fetchSamples(id) {
  const head = await request(`${DOCS}/zonas_muestras/${encodeURIComponent(id)}`, { auth: true });
  const parts = val(head?.fields?.partes);
  if (!parts) return null;
  let text = "";
  for (let i = 0; i < parts; i++) text += val((await request(`${DOCS}/zonas_muestras/${encodeURIComponent(id)}/partes/${i}`, { auth: true })).fields.datos);
  return JSON.parse(text);
}

export async function deleteZone(id) {
  await request(`${DOCS}/zonas/${encodeURIComponent(id)}`, { method: "DELETE", auth: true });
  try { await request(`${DOCS}/zonas_muestras/${encodeURIComponent(id)}`, { method: "DELETE", auth: true }); } catch { /* nada */ }
}
