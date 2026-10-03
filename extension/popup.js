// Funciona en Firefox (browser.*) y Chrome/Edge (chrome.*).
const ext = globalThis.browser ?? globalThis.chrome;
const API = "http://127.0.0.1:8173";
const $ = (id) => document.getElementById(id);
let currentUrl = "";
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
    $("url").textContent = tab?.title || currentUrl || "No se pudo leer la pestaña actual.";
    const health = await call("/api/health");
    sites = health.sites;
    const site = siteFor(currentUrl);
    if (site) { $("site").textContent = site; $("dl").classList.remove("hidden"); }
    else $("site").textContent = "Página web";
    if (/^https?:/i.test(currentUrl)) $("capture").classList.remove("hidden");
    if (!site && !/^https?:/i.test(currentUrl)) say("Abre un video o una página web y vuelve a pulsar.", "error");
  } catch { say("TikSave no está abierto. Ejecuta run-windows.bat primero.", "error"); }
}

document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => send("/api/download", { url: currentUrl, mode: b.dataset.mode })));
document.querySelector("[data-kit]").addEventListener("click", () => send("/api/download", { url: currentUrl, mode: "transcript", notes: true, cover: true }));
$("capture").addEventListener("click", () => send("/api/capture", { url: currentUrl, markdown: true, html: true }));
$("open").addEventListener("click", () => ext.tabs.create({ url: API }));
init();
