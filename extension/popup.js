// Funciona en Firefox (browser.*) y Chrome/Edge (chrome.*).
const ext = globalThis.browser ?? globalThis.chrome;
const API = "http://127.0.0.1:8173";
const CHAT_HOSTS = ["chatgpt.com", "chat.openai.com", "gemini.google.com", "claude.ai"];
const $ = (id) => document.getElementById(id);
let currentUrl = "";
let currentTabId = null;
let sites = {};

function say(text, type = "") { $("message").textContent = text; $("message").className = type; }

function siteFor(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [name, domains] of Object.entries(sites)) {
      if (domains.some((d) => host === d || host.endsWith("." + d))) return name;
    }
  } catch { /* url no valida */ }
  return null;
}

async function call(path, body) {
  const res = await fetch(API + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Solicitud rechazada.");
  return data;
}

async function track(jobId) {
  $("bar").classList.remove("hidden");
  for (let i = 0; i < 600; i++) {
    const job = await call(`/api/jobs/${jobId}`);
    $("fill").style.width = `${job.status === "done" ? 100 : job.progress || 0}%`;
    if (job.status === "done") { say("Listo. Guardado en tu carpeta de TikSave.", "ok"); return; }
    if (job.status === "error") { say(job.error || "Falló la descarga.", "error"); return; }
    if (job.status === "cancelled") { say("Cancelado.", ""); return; }
    say(job.stage || "Trabajando…");
    await new Promise((r) => setTimeout(r, 900));
  }
}

async function send(path, body) {
  try {
    const job = await call(path, body);
    say("Enviado a TikSave…");
    await track(job.id);
  } catch (err) { say(err.message || "No se pudo conectar con TikSave.", "error"); }
}

async function init() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    currentUrl = tab?.url || "";
    currentTabId = tab?.id ?? null;
    $("url").textContent = tab?.title || currentUrl || "No se pudo leer la pestaña actual.";
    const health = await call("/api/health");
    sites = health.sites;
    const site = siteFor(currentUrl);
    const isWeb = /^https?:/i.test(currentUrl);
    const isChat = CHAT_HOSTS.some((d) => { try { return new URL(currentUrl).hostname.endsWith(d); } catch { return false; } });
    if (isChat) { $("dl").classList.add("hidden"); say("Conversación detectada: usa Capturar esta página para guardarla con tu sesión.", "ok"); }
    if (site) { $("site").textContent = site; $("dl").classList.remove("hidden"); }
    else {
      $("site").textContent = "Página web";
      if (isWeb && health.allow_other_sites) $("dl").classList.remove("hidden");
    }
    await initFloating(isWeb);
    if (/^https?:/i.test(currentUrl)) $("cap").classList.remove("hidden");
    if (!site && !/^https?:/i.test(currentUrl)) say("Abre un video o una página web y vuelve a pulsar.", "error");
  } catch { say("TikSave no está abierto. Ejecuta run-windows.bat primero.", "error"); }
}

const pageTitle = () => $("url").textContent;
// En sitios sin extractor, la pagina no sirve: se usa el stream que cargo (si lo hay).
async function resolveUrl(url) {
  if (siteFor(url) || url !== currentUrl || currentTabId == null) return url;
  try {
    const res = await ext.runtime.sendMessage({ type: "page-target", tabId: currentTabId });
    return res?.url || url;
  } catch { return url; }
}
// Las descargas pasan por el fondo: el adjunta tu sesion (cookies) y resuelve el enlace correcto.
async function sendDownload(body) {
  // Sitio sin extractor sin permiso de sitios: no hay forma de encontrar el video. Se pide el permiso aqui mismo
  // (el clic cuenta como gesto del usuario) y se pide recargar, porque el video ya cargo sin que lo viéramos.
  if (!siteFor(body.url) && body.url === currentUrl && currentTabId != null) {
    let granted = false;
    try { granted = await ext.permissions.contains({ origins: ["<all_urls>"] }); } catch { /* ignorar */ }
    if (!granted) {
      try { granted = await ext.permissions.request({ origins: ["<all_urls>"] }); } catch { /* ignorar */ }
      if (!granted) { say("Para encontrar el video necesito el permiso de sitios. Pulsa «Activar en todos los sitios».", "error"); return; }
      await ext.runtime.sendMessage({ type: "register" });
      await initFloating(true);
      say("Permiso activado. Recarga la página del video y vuelve a pulsar Descargar.", "ok");
      return;
    }
  }
  try {
    body = { ...body, url: await resolveUrl(body.url) };
    const res = await ext.runtime.sendMessage({ type: "save", explicitUrl: body.url, mode: body.mode, title: body.title,
      referer: body.referer, pageUrl: currentUrl, tabId: currentTabId });
    if (!res || res.error) throw new Error(res?.error || "Sin respuesta");
    say("Enviado a TikSave…");
    await track(res.job.id);
  } catch (err) { say(err.message || "No se pudo conectar con TikSave.", "error"); }
}
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => sendDownload({
  url: currentUrl, mode: b.dataset.mode, title: siteFor(currentUrl) ? undefined : pageTitle(),
  referer: siteFor(currentUrl) ? undefined : currentUrl })));
document.querySelector("[data-kit]").addEventListener("click", () => sendDownload({ url: currentUrl, mode: "transcript" }));
// Se ejecuta DENTRO de la pagina (con tu sesion): copia el DOM y convierte las imagenes a datos incrustados.
async function grabPage() {
  const MAX_IMG = 3 * 1024 * 1024, MAX_TOTAL = 25 * 1024 * 1024, MAX_COUNT = 60;
  const imgs = [...document.querySelectorAll("img")];
  const toData = (blob) => new Promise((res) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(blob);
  });
  let total = 0;
  const map = new Map();
  const targets = imgs.filter((i) => /^https?:/.test(i.currentSrc || i.src)).slice(0, MAX_COUNT);
  await Promise.all(targets.map(async (img) => {
    try {
      const res = await fetch(img.currentSrc || img.src, { credentials: "include" });
      if (!res.ok) return;
      const blob = await res.blob();
      if (!blob.type.startsWith("image/") || blob.size > MAX_IMG || total + blob.size > MAX_TOTAL) return;
      total += blob.size;
      const data = await toData(blob);
      if (data) map.set(img, data);
    } catch { /* imagen no accesible: se queda el enlace original */ }
  }));
  const clone = document.documentElement.cloneNode(true);
  const cloned = clone.querySelectorAll("img");
  imgs.forEach((img, i) => {
    const data = map.get(img);
    if (data && cloned[i]) { cloned[i].setAttribute("src", data); cloned[i].removeAttribute("srcset"); }
  });
  return { html: "<!doctype html>" + clone.outerHTML, url: location.href, title: document.title };
}

$("capture").addEventListener("click", async () => {
  const formats = { markdown: $("f-md").checked, docx: $("f-docx").checked, pdf: $("f-pdf").checked, html: $("f-html").checked };
  if (!Object.values(formats).some(Boolean)) { say("Elige al menos un formato.", "error"); return; }
  $("capture").disabled = true;
  say("Leyendo la página que estás viendo…");
  let body = { url: currentUrl, ...formats };
  try {
    const [{ result }] = await ext.scripting.executeScript({ target: { tabId: currentTabId }, func: grabPage });
    if (result?.html) body = { ...body, url: result.url, html_source: result.html };
  } catch { say("No pude leer la página desde el navegador; intento descargarla directamente…"); }
  await send("/api/capture", body);
  $("capture").disabled = false;
});
$("open").addEventListener("click", () => ext.tabs.create({ url: API }));
async function initFloating(isWeb) {
  if (!isWeb) return;
  let granted = false;
  try { granted = await ext.permissions.contains({ origins: ["<all_urls>"] }); } catch { /* ignorar */ }
  $("perm").classList.toggle("hidden", granted);
  $("float-row").classList.toggle("hidden", !granted);
  const stored = await ext.storage.local.get({ floatEnabled: true, useCookies: true });
  $("float-on").checked = stored.floatEnabled !== false;
  $("cookie-on").checked = stored.useCookies !== false;
  $("cookie-row").classList.remove("hidden");
  if (granted) await showFound();
}
$("grant").addEventListener("click", async () => {
  try {
    const ok = await ext.permissions.request({ origins: ["<all_urls>"] });
    if (ok) { await ext.runtime.sendMessage({ type: "register" }); say("Listo: recarga la página para ver el botón sobre los videos.", "ok"); await initFloating(true); }
    else say("Sin ese permiso no puedo mostrar el botón flotante.", "error");
  } catch (err) { say(err.message || "No se pudo pedir el permiso.", "error"); }
});
$("cookie-on").addEventListener("change", () => ext.storage.local.set({ useCookies: $("cookie-on").checked }));
$("float-on").addEventListener("change", () => ext.storage.local.set({ floatEnabled: $("float-on").checked }));

async function showFound() {
  if (siteFor(currentUrl) || currentTabId == null) return; // en sitios conocidos basta con la URL de la pagina
  const res = await ext.runtime.sendMessage({ type: "media", tabId: currentTabId });
  const list = (res?.media || []).slice().reverse();
  $("found").classList.toggle("hidden", !list.length);
  const box = $("found-list"); box.replaceChildren();
  for (const item of list) {
    const row = document.createElement("div"); row.className = "found-item";
    const name = document.createElement("span");
    let host = ""; try { host = new URL(item.url).pathname.split("/").pop() || new URL(item.url).hostname; } catch { /* ignorar */ }
    name.textContent = `${item.kind === "manifest" ? "Stream" : "Video"} · ${host.slice(0, 28)}${item.size ? ` · ${(item.size / 1e6).toFixed(1)} MB` : ""}`;
    name.title = item.url;
    const mk = (text, mode) => { const b = document.createElement("button"); b.textContent = text;
      b.addEventListener("click", () => sendDownload({ url: item.url, mode, referer: currentUrl, title: pageTitle() })); return b; };
    row.append(name, mk("MP4", "video"), mk("MP3", "mp3"));
    box.append(row);
  }
}

init();
