// Funciona en Firefox (browser.*) y Chrome/Edge (chrome.*).
const ext = globalThis.browser ?? globalThis.chrome;
const API = "http://127.0.0.1:8173";
const ALL_SITES = { origins: ["<all_urls>"] };
const MAX_PER_TAB = 15;
const memory = new Map(); // tabId -> [{url, kind, type, size, time}]
let sitesCache = null;

// ---------- API local ----------
async function call(path, body) {
  const res = await fetch(API + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Solicitud rechazada.");
  return data;
}
async function loadSites() {
  if (!sitesCache) {
    const health = await call("/api/health");
    sitesCache = { sites: health.sites, anySite: !!health.allow_other_sites };
  }
  return sitesCache;
}
function hostMatches(url, domains) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith("." + d));
  } catch { return false; }
}
function isKnownSite(url, sites) {
  return Object.values(sites).some((domains) => hostMatches(url, domains));
}

// ---------- detector de streams ----------
const SEGMENT = /\.(ts|m4s|aac|vtt|webvtt|key)(\?|$)/i;
function header(details, name) {
  const h = (details.responseHeaders || []).find((x) => x.name.toLowerCase() === name);
  return h ? String(h.value || "") : "";
}
function classify(details) {
  const url = details.url;
  if (!/^https?:/i.test(url) || SEGMENT.test(url)) return null;
  const type = header(details, "content-type").toLowerCase();
  const range = header(details, "content-range").match(/\/(\d+)$/);
  const size = range ? Number(range[1]) : Number(header(details, "content-length")) || 0;
  if (/\.(m3u8|mpd)(\?|$)/i.test(url) || /(mpegurl|dash\+xml)/.test(type)) return { kind: "manifest", type, size };
  const looksVideo = /^video\//.test(type) && !/mp2t/.test(type);
  const extVideo = /\.(mp4|webm|m4v|mov)(\?|$)/i.test(url);
  if ((looksVideo || extVideo) && size >= 300 * 1024) return { kind: "file", type, size };
  return null;
}
function cleanUrl(url) {
  return url.replace(/([?&])(range|bytestart|byteend|start|end)=[^&]*&?/gi, "$1").replace(/[?&]$/, "");
}
async function noteMedia(details) {
  if (details.tabId < 0) return;
  const info = classify(details);
  if (!info) return;
  const list = (await getMedia(details.tabId)).filter((m) => m.url !== cleanUrl(details.url));
  list.push({ url: cleanUrl(details.url), ...info, time: Date.now() });
  const trimmed = list.slice(-MAX_PER_TAB);
  memory.set(details.tabId, trimmed);
  try { await ext.storage.session?.set({ ["media" + details.tabId]: trimmed }); } catch { /* sin storage.session */ }
  try {
    await ext.action.setBadgeText({ tabId: details.tabId, text: String(trimmed.length) });
    await ext.action.setBadgeBackgroundColor({ tabId: details.tabId, color: "#fe2c55" });
  } catch { /* la pestaña pudo cerrarse */ }
}
async function getMedia(tabId) {
  if (memory.has(tabId)) return memory.get(tabId);
  try {
    const stored = await ext.storage.session?.get("media" + tabId);
    if (stored?.["media" + tabId]) { memory.set(tabId, stored["media" + tabId]); return memory.get(tabId); }
  } catch { /* ignorar */ }
  return [];
}
function clearMedia(tabId) {
  memory.delete(tabId);
  try { ext.storage.session?.remove("media" + tabId); } catch { /* ignorar */ }
  try { ext.action.setBadgeText({ tabId, text: "" }); } catch { /* ignorar */ }
}
function bestMedia(list) {
  const manifests = list.filter((m) => m.kind === "manifest");
  if (manifests.length) return manifests[manifests.length - 1];
  return [...list].sort((a, b) => b.size - a.size)[0] || null;
}

function listen() {
  try {
    ext.webRequest.onHeadersReceived.addListener(noteMedia, { urls: ["<all_urls>"] }, ["responseHeaders"]);
  } catch { /* sin permiso de sitios: se reintenta cuando el usuario lo concede */ }
}
listen();
ext.tabs.onUpdated.addListener((tabId, change) => { if (change.status === "loading" && change.url) clearMedia(tabId); });
ext.tabs.onRemoved.addListener(clearMedia);

// ---------- boton flotante: registro de scripts ----------
async function hasAllSites() {
  try { return await ext.permissions.contains(ALL_SITES); } catch { return false; }
}
async function registerFloating() {
  if (!(await hasAllSites())) return false;
  try {
    const existing = await ext.scripting.getRegisteredContentScripts({ ids: ["tiksave-float"] });
    if (!existing.length) {
      await ext.scripting.registerContentScripts([{
        id: "tiksave-float", js: ["content.js"], matches: ["<all_urls>"], allFrames: true,
        runAt: "document_idle", persistAcrossSessions: true,
      }]);
    }
  } catch { /* ya registrado */ }
  listen();
  return true;
}
ext.runtime.onInstalled.addListener(registerFloating);
ext.runtime.onStartup.addListener(registerFloating);
ext.permissions.onAdded?.addListener(registerFloating);

// ---------- guardar ----------
async function resolveTarget({ pageUrl, candidate, directSrc, tabId }) {
  const { sites } = await loadSites();
  if (candidate && isKnownSite(candidate, sites)) return { url: candidate };
  if (isKnownSite(pageUrl, sites)) return { url: pageUrl };
  const sniffed = bestMedia(await getMedia(tabId));
  if (sniffed) return { url: sniffed.url, referer: pageUrl };
  if (directSrc && /^https?:/i.test(directSrc)) return { url: directSrc, referer: pageUrl };
  return { url: candidate || pageUrl };
}

async function save(msg, sender) {
  const tab = sender.tab || {};
  const pageUrl = tab.url || msg.pageUrl;
  const target = msg.explicitUrl
    ? { url: msg.explicitUrl, referer: msg.referer || pageUrl }
    : await resolveTarget({ pageUrl, candidate: msg.candidate, directSrc: msg.directSrc, tabId: tab.id ?? msg.tabId });
  const body = { url: target.url, mode: msg.mode || "video", title: msg.title || tab.title || undefined };
  if (target.referer) body.referer = target.referer;
  if (msg.mode === "transcript") { body.notes = true; body.cover = true; }
  if (msg.start > 0) body.start = msg.start;
  const job = await call("/api/download", body);
  if (tab.id != null) watchJob(job.id, tab.id);
  return { ok: true, job };
}

async function watchJob(jobId, tabId) {
  for (let i = 0; i < 900; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    let job;
    try { job = await call(`/api/jobs/${jobId}`); } catch { return; }
    try { await ext.tabs.sendMessage(tabId, { type: "progress", jobId, status: job.status, progress: job.progress, error: job.error }); } catch { return; }
    if (["done", "error", "cancelled"].includes(job.status)) return;
  }
}

async function handle(msg, sender) {
  if (sender.id && sender.id !== ext.runtime.id) throw new Error("Remitente no permitido.");
  switch (msg?.type) {
    case "save": return save(msg, sender);
    case "media": return { media: await getMedia(msg.tabId) };
    case "register": return { ok: await registerFloating() };
    case "status": {
      let apiOk = true, anySite = false;
      try { anySite = (await loadSites()).anySite; } catch { apiOk = false; }
      return { apiOk, anySite, allSites: await hasAllSites() };
    }
    default: throw new Error("Mensaje desconocido.");
  }
}
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (err) => sendResponse({ error: err.message || String(err) }));
  return true;
});

if (typeof module !== "undefined") module.exports = { classify, cleanUrl, bestMedia, resolveTarget, isKnownSite, handle };
