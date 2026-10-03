"use strict";

// ---------- utilidades ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Los nombres de icono son constantes internas, nunca datos externos.
function icon(name) {
  const span = document.createElement("span");
  span.className = "ic-wrap";
  span.innerHTML = `<svg class="ic"><use href="#i-${name}"/></svg>`;
  return span.firstChild;
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch {
    $("#offline").classList.remove("hidden");
    throw new Error("No se pudo conectar con TikSave.");
  }
  $("#offline").classList.add("hidden");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data.detail === "string" ? data.detail : "Datos no válidos.";
    throw new Error(detail || `Error ${res.status}`);
  }
  return data;
}
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

function toast(text, type = "") {
  const el = h("div", { class: `toast ${type}` }, text);
  $("#toasts").append(el);
  setTimeout(() => el.remove(), type === "error" ? 7000 : 3800);
}

const store = {
  get(key, fallback) { try { const v = localStorage.getItem("tiksave." + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem("tiksave." + key, JSON.stringify(value)); } catch { /* sin almacenamiento */ } },
};

const fmtSize = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB";
const fmtDur = (s) => { if (!s) return ""; const m = Math.floor(s / 60); return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`; };
const fmtNum = (n) => n == null ? "" : n >= 1e6 ? (n / 1e6).toFixed(1) + " M" : n >= 1e3 ? (n / 1e3).toFixed(1) + " k" : String(n);
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
const encPath = (rel) => rel.split("/").map(encodeURIComponent).join("/");
const norm = (p) => String(p).replace(/\\/g, "/");

let health = null;
let downloadDir = "";
function relPath(abs) {
  const a = norm(abs), base = norm(downloadDir).replace(/\/$/, "");
  return a.toLowerCase().startsWith(base.toLowerCase() + "/") ? a.slice(base.length + 1) : a;
}

// ---------- pestañas ----------
function showTab(name) {
  $$(".tab").forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle("active", on); t.setAttribute("aria-selected", on); });
  $$(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  store.set("tab", name);
  if (name === "library") loadLibrary();
  if (name === "settings") loadSettings();
}
$$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

// ---------- DESCARGAR ----------
const urlsEl = $("#urls");
let sites = {};
let previewTimer = null;
let lastPreviewed = "";

function hostOk(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return Object.values(sites).some((domains) => domains.some((d) => host === d || host.endsWith("." + d)));
  } catch { return false; }
}
function extractUrls(text) {
  const found = text.match(/https?:\/\/[^\s<>"']+/g) || [];
  return [...new Set(found.map((u) => u.replace(/[),.;]+$/, "")))];
}
function currentMode() { return $('input[name="mode"]:checked').value; }
function isProfile(url) {
  return /^https?:\/\/(www\.)?tiktok\.com\/@[\w.\-]+\/?(\?.*)?$/i.test(url)
    || /youtube\.com\/(playlist\?|@[\w.\-]+(\/videos)?\/?$|channel\/|c\/)/i.test(url);
}

function updateDownloadUi() {
  const all = extractUrls(urlsEl.value);
  const valid = all.filter(hostOk);
  const invalid = all.length - valid.length;
  const hint = $("#url-hint");
  hint.replaceChildren();
  if (all.length) {
    hint.append(h("span", { class: valid.length ? "ok" : "bad" }, `${valid.length} enlace${valid.length === 1 ? "" : "s"} válido${valid.length === 1 ? "" : "s"}`));
    if (invalid) hint.append(h("span", { class: "bad" }, ` · ${invalid} no reconocido${invalid === 1 ? "" : "s"} (se omitirá${invalid === 1 ? "" : "n"})`));
  } else if (urlsEl.value.trim()) {
    hint.append(h("span", { class: "bad" }, "No encuentro ningún enlace (debe empezar con https://)."));
  }
  const mode = currentMode();
  const textOnly = mode === "transcript", coverOnly = mode === "cover";
  $("#x-transcript").disabled = textOnly; if (textOnly) $("#x-transcript").checked = true;
  $("#x-cover").disabled = coverOnly; if (coverOnly) $("#x-cover").checked = true;
  $("#go").disabled = valid.length === 0;
  $("#go-label").textContent = valid.length > 1 ? `Descargar ${valid.length} enlaces` : "Descargar";
  $("#profile-box").classList.toggle("hidden", !(valid.length === 1 && isProfile(valid[0])));

  clearTimeout(previewTimer);
  if (valid.length === 1 && !isProfile(valid[0])) {
    if (valid[0] !== lastPreviewed) previewTimer = setTimeout(() => loadPreview(valid[0]), 500);
  } else {
    $("#preview").classList.add("hidden");
    lastPreviewed = "";
  }
  store.set("download-opts", { mode, transcript: $("#x-transcript").checked, notes: $("#x-notes").checked, cover: $("#x-cover").checked });
}

async function loadPreview(url) {
  lastPreviewed = url;
  try {
    const d = await post("/api/inspect", { url });
    if (lastPreviewed !== url) return;
    $("#thumb").src = d.thumbnail || "";
    $("#thumb").style.visibility = d.thumbnail ? "visible" : "hidden";
    $("#p-title").textContent = d.title || d.site;
    $("#p-meta").textContent = [d.uploader && `@${String(d.uploader).replace(/^@/, "")}`, fmtDur(d.duration),
      d.view_count != null && `${fmtNum(d.view_count)} vistas`].filter(Boolean).join(" · ");
    const badges = $("#p-badges");
    badges.replaceChildren(h("span", { class: "badge" }, d.site));
    if (d.max_height) badges.append(h("span", { class: "badge" }, `hasta ${d.max_height}p`));
    badges.append(d.has_subtitles
      ? h("span", { class: "badge ok" }, `Subtítulos: ${d.subtitle_langs.slice(0, 3).join(", ")}`)
      : h("span", { class: "badge warn" }, "Sin subtítulos"));
    $("#preview").classList.remove("hidden");
  } catch (err) {
    if (lastPreviewed !== url) return;
    $("#preview").classList.add("hidden");
    $("#url-hint").append(h("div", { class: "bad" }, err.message));
  }
}

urlsEl.addEventListener("input", updateDownloadUi);
$$('input[name="mode"], #x-transcript, #x-notes, #x-cover').forEach((el) => el.addEventListener("change", updateDownloadUi));

$("#paste").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlsEl.value = urlsEl.value.trim() ? urlsEl.value.trim() + "\n" + text.trim() : text.trim();
    updateDownloadUi();
  } catch { toast("El navegador no permitió leer el portapapeles. Usa Ctrl+V dentro del cuadro.", "error"); }
});

$("#kit").addEventListener("click", () => {
  $('input[name="mode"][value="transcript"]').checked = true;
  $("#x-notes").checked = true; $("#x-cover").checked = true;
  updateDownloadUi();
  toast("Kit para IA: transcripción + ficha Markdown + portada.");
});

$("#profile-load").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget, url = extractUrls(urlsEl.value).filter(hostOk)[0];
  btn.disabled = true; btn.textContent = "Cargando…";
  try {
    const { entries } = await post("/api/expand", { url, limit: Number($("#profile-limit").value) || 20 });
    if (!entries.length) throw new Error("No encontré videos en ese enlace.");
    urlsEl.value = entries.map((e) => e.url).join("\n");
    toast(`${entries.length} videos cargados. Revisa el formato y pulsa Descargar.`, "ok");
  } catch (err) { toast(err.message, "error"); }
  btn.disabled = false; btn.textContent = "Cargar videos";
  updateDownloadUi();
});

$("#go").addEventListener("click", async () => {
  const urls = extractUrls(urlsEl.value).filter(hostOk);
  if (!urls.length) return;
  const btn = $("#go"); btn.disabled = true;
  try {
    const mode = currentMode();
    const res = await post("/api/download/batch", {
      urls, mode, transcript: $("#x-transcript").checked, notes: $("#x-notes").checked, cover: $("#x-cover").checked,
    });
    toast(`${res.jobs.length} descarga${res.jobs.length === 1 ? "" : "s"} en cola.`, "ok");
    urlsEl.value = ""; lastPreviewed = "";
    refreshJobs();
  } catch (err) { toast(err.message, "error"); }
  updateDownloadUi();
});

// Pegar en cualquier parte de la página
document.addEventListener("paste", (ev) => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  const text = ev.clipboardData?.getData("text") || "";
  if (!extractUrls(text).length) return;
  showTab("download");
  urlsEl.value = (urlsEl.value.trim() ? urlsEl.value.trim() + "\n" : "") + text.trim();
  updateDownloadUi();
});

// ---------- CAPTURAR WEB ----------
$("#cap-go").addEventListener("click", capture);
$("#cap-url").addEventListener("keydown", (e) => { if (e.key === "Enter") capture(); });
async function capture() {
  const url = $("#cap-url").value.trim();
  if (!url) { toast("Escribe la dirección de la página.", "error"); return; }
  const btn = $("#cap-go"); btn.disabled = true;
  try {
    await post("/api/capture", {
      url, markdown: $("#c-md").checked, html: $("#c-html").checked,
      screenshot: $("#c-shot").checked, pdf: $("#c-pdf").checked,
      full_content: $("#c-full").value === "1", render: $("#c-render").value,
      depth: Number($("#c-depth").value), max_pages: Math.min(50, Math.max(1, Number($("#c-max").value) || 10)),
    });
    toast("Captura en cola.", "ok");
    $("#cap-url").value = "";
    refreshJobs();
  } catch (err) { toast(err.message, "error"); }
  btn.disabled = false;
}

// ---------- COLA ----------
const jobEls = new Map();
let pollTimer = null;
let prevStatus = new Map();
let lastJobs = [];

const STATUS = { queued: "En cola", starting: "Preparando", downloading: "Trabajando", processing: "Procesando", done: "Listo", error: "Error", cancelled: "Cancelado" };
const MODE = { video: "Video MP4", mp3: "Audio MP3", audio: "Audio original", transcript: "Texto", cover: "Portada", capture: "Captura web" };
const ACTIVE = new Set(["queued", "starting", "downloading", "processing"]);

function jobCard(job) {
  const card = h("div", { class: "job", "data-id": job.id });
  card.append(
    h("div", { class: "job-top" },
      h("div", { class: "job-ic" }, icon(job.kind === "capture" ? "globe" : "download")),
      h("div", { class: "job-main" }, h("div", { class: "job-title" }), h("div", { class: "job-sub" }))),
    h("div", { class: "track" }, h("div", { class: "bar" })),
    h("div", { class: "job-state" }, h("span", { class: "js-left" }), h("span", { class: "js-right" })),
    h("div", { class: "job-msgs" }),
    h("div", { class: "job-actions" }),
  );
  return card;
}

function updateJobCard(card, job) {
  card.className = `job ${job.status}`;
  $(".job-title", card).textContent = job.title || job.url;
  $(".job-title", card).title = job.url;
  const extras = [];
  if (job.options?.transcript && job.mode !== "transcript") extras.push("texto");
  if (job.options?.notes) extras.push("ficha");
  if (job.options?.cover && job.mode !== "cover") extras.push("portada");
  $(".job-sub", card).textContent = [MODE[job.mode] || job.mode, job.uploader && (job.kind === "capture" ? job.uploader : `@${String(job.uploader).replace(/^@/, "")}`),
    extras.length && `+ ${extras.join(", ")}`].filter(Boolean).join(" · ");
  const pct = Math.round(job.progress || 0);
  $(".bar", card).style.width = `${job.status === "done" ? 100 : pct}%`;
  $(".track", card).classList.toggle("hidden", job.status === "error" || job.status === "cancelled");
  $(".js-left", card).textContent = job.status === "downloading" || job.status === "processing" || job.status === "starting"
    ? (job.stage || STATUS[job.status]) : STATUS[job.status];
  $(".js-right", card).textContent = ACTIVE.has(job.status) ? [job.speed, job.eta && `${job.eta}`, job.status === "downloading" && pct ? `${pct}%` : ""].filter(Boolean).join(" · ") : "";
  const msgs = $(".job-msgs", card); msgs.replaceChildren();
  if (job.error) msgs.append(h("div", { class: "job-err" }, job.error));
  (job.warnings || []).forEach((w) => msgs.append(h("div", { class: "job-warn" }, w)));

  const actions = $(".job-actions", card); actions.replaceChildren();
  const btn = (label, ic, fn, cls = "") => h("button", { class: `btn small ${cls}`, onclick: fn }, icon(ic), label);
  if (ACTIVE.has(job.status)) actions.append(btn("Cancelar", "x", () => post(`/api/jobs/${job.id}/cancel`).then(refreshJobs).catch((e) => toast(e.message, "error"))));
  if (job.status === "done" && job.files?.length) {
    actions.append(btn("Ver", "play", () => openItem(jobAsItem(job)), "primary"));
    actions.append(btn("Carpeta", "folder", () => revealPath(relPath(job.filename || job.files[0]))));
  }
  if (job.status === "error" || job.status === "cancelled") actions.append(btn("Reintentar", "retry", () => post(`/api/jobs/${job.id}/retry`).then(refreshJobs).catch((e) => toast(e.message, "error"))));
  if (!ACTIVE.has(job.status)) actions.append(btn("Quitar", "x", () => api(`/api/jobs/${job.id}`, { method: "DELETE" }).then(refreshJobs), "ghost"));
}

function jobAsItem(job) {
  const kindOf = (f) => { const e = f.split(".").pop().toLowerCase();
    return ["mp4", "webm", "mkv", "mov"].includes(e) ? "video" : ["mp3", "m4a", "opus", "ogg", "wav", "aac"].includes(e) ? "audio"
      : ["jpg", "jpeg", "png", "webp"].includes(e) ? "image" : ["html", "htm", "pdf"].includes(e) ? "page" : "text"; };
  return { name: job.title || job.url, files: job.files.map((f) => ({ path: relPath(f), name: norm(f).split("/").pop(), kind: kindOf(f) })) };
}

function syncJobs(jobs) {
  lastJobs = jobs;
  const ids = new Set(jobs.map((j) => j.id));
  for (const [id, el] of jobEls) if (!ids.has(id)) { el.remove(); jobEls.delete(id); }
  const list = $("#q-list");
  jobs.forEach((job, index) => {
    let el = jobEls.get(job.id);
    if (!el) { el = jobCard(job); jobEls.set(job.id, el); }
    updateJobCard(el, job);
    if (list.children[index] !== el) list.insertBefore(el, list.children[index] || null);
    const before = prevStatus.get(job.id);
    if (before && ACTIVE.has(before) && !ACTIVE.has(job.status)) {
      if (job.status === "done") { toast(`Listo: ${(job.title || job.url).slice(0, 70)}`, "ok"); if (!$("#tab-library").classList.contains("hidden")) loadLibrary(); }
      else if (job.status === "error") toast(job.error || "Falló una descarga.", "error");
    }
    prevStatus.set(job.id, job.status);
  });
  const active = jobs.filter((j) => ACTIVE.has(j.status)).length;
  $("#q-count").textContent = active; $("#q-count").classList.toggle("hidden", !active);
  $("#q-empty").classList.toggle("hidden", jobs.length > 0);
  document.title = active ? `(${active}) TikSave` : "TikSave";
}

async function refreshJobs() {
  clearTimeout(pollTimer);
  let active = false;
  try {
    const { jobs } = await api("/api/jobs");
    syncJobs(jobs);
    active = jobs.some((j) => ACTIVE.has(j.status));
  } catch { /* se muestra el banner de desconexión */ }
  pollTimer = setTimeout(refreshJobs, active ? 900 : 4000);
}
$("#q-clear").addEventListener("click", () => api("/api/jobs", { method: "DELETE" }).then(refreshJobs));

// ---------- BIBLIOTECA ----------
let libItems = [];
let libFilter = "all";
const KIND_LABEL = { video: "Video", audio: "Audio", image: "Imagen", text: "Texto", page: "Página", site: "Sitio" };

async function loadLibrary() {
  try { libItems = (await api("/api/library")).items; renderLibrary(); } catch (err) { toast(err.message, "error"); }
}
function renderLibrary() {
  const q = $("#lib-q").value.trim().toLowerCase();
  const items = libItems.filter((i) => (libFilter === "all" || i.type === libFilter) && (!q || i.name.toLowerCase().includes(q)));
  const grid = $("#lib-grid"); grid.replaceChildren();
  $("#lib-empty").classList.toggle("hidden", items.length > 0);
  for (const item of items) {
    const thumb = h("div", { class: "lib-thumb" }, h("span", { class: "lib-kind" }, KIND_LABEL[item.type] || item.type));
    if (item.cover) thumb.prepend(h("img", { src: `/files/${encPath(norm(item.cover))}`, alt: "", loading: "lazy" }));
    else thumb.prepend(icon(item.type === "site" ? "globe" : "file"));
    grid.append(h("button", { class: "lib-card", onclick: () => openItem(item) }, thumb,
      h("div", { class: "lib-info" }, h("div", { class: "lib-name" }, item.name),
        h("div", { class: "lib-meta" }, [item.platform && item.platform !== "Sitios" ? item.platform : null, fmtSize(item.size), fmtDate(item.modified)].filter(Boolean).join(" · ")))));
  }
}
$("#lib-q").addEventListener("input", renderLibrary);
$("#lib-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  libFilter = b.dataset.f; $$("#lib-filter button").forEach((x) => x.classList.toggle("active", x === b)); renderLibrary();
});
$("#lib-open").addEventListener("click", () => revealPath(null));

async function revealPath(rel) {
  try { await post("/api/open-folder", rel ? { path: rel } : {}); } catch (err) { toast(err.message, "error"); }
}

// ---------- VISOR ----------
let modalItem = null, modalFile = null;
function fileLabel(f) {
  const ext = f.name.split(".").pop().toLowerCase();
  const byExt = { md: "Markdown", txt: "Texto", srt: "Subtítulos", vtt: "Subtítulos", html: "Página offline", htm: "Página offline", pdf: "PDF", json: "Datos", png: "Captura", jpg: "Portada", jpeg: "Portada", webp: "Portada" };
  return f.kind === "video" ? "Video" : f.kind === "audio" ? "Audio" : byExt[ext] || ext;
}
function openItem(item) {
  modalItem = item;
  $("#m-title").textContent = item.name;
  const order = { video: 0, audio: 0, text: 1, page: 2, image: 3 };
  const rank = (f) => (order[f.kind] ?? 9) * 10 + (f.name.endsWith(".md") ? 0 : f.name.endsWith(".txt") ? 1 : 2);
  const files = [...item.files].sort((a, b) => rank(a) - rank(b));
  const tabs = $("#m-files"); tabs.replaceChildren();
  files.forEach((f) => tabs.append(h("button", { "data-path": f.path, onclick: () => showFile(f) }, fileLabel(f))));
  $("#modal").classList.remove("hidden");
  showFile(files.find((f) => ["video", "audio", "text", "page", "image"].includes(f.kind)) || files[0]);
}
async function showFile(f) {
  modalFile = f;
  $$("#m-files button").forEach((b) => b.classList.toggle("active", b.dataset.path === f.path));
  const body = $("#m-body"); body.replaceChildren();
  const url = `/files/${encPath(norm(f.path))}`;
  const copy = $("#m-copy"); copy.classList.add("hidden"); copy.dataset.text = "";
  if (f.kind === "video") body.append(h("video", { src: url, controls: true, autoplay: true, playsinline: true }));
  else if (f.kind === "audio") body.append(h("audio", { src: url, controls: true, autoplay: true }));
  else if (f.kind === "image") body.append(h("img", { src: url, alt: f.name }));
  else if (f.kind === "page") body.append(f.name.toLowerCase().endsWith(".pdf")
    ? h("iframe", { src: url, style: "width:100%;height:60vh;border:0;border-radius:10px;background:#fff" })
    : h("div", {}, h("p", {}, "Esta página guardada se abre en una pestaña nueva (sin scripts)."), h("a", { class: "btn primary", href: url, target: "_blank", rel: "noopener" }, "Abrir página")));
  else {
    try {
      const text = await (await fetch(url)).text();
      if (modalFile !== f) return;
      const shown = text.length > 300000 ? text.slice(0, 300000) + "\n\n… (texto recortado)" : text;
      body.append(h("pre", {}, shown));
      copy.dataset.text = text; copy.classList.remove("hidden");
    } catch { body.append(h("p", { class: "muted" }, "No se pudo leer el archivo.")); }
  }
}
function closeModal() {
  $("#modal").classList.add("hidden"); $("#m-body").replaceChildren(); modalItem = modalFile = null;
}
$("#m-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").classList.contains("hidden")) closeModal(); });
$("#m-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#m-copy").dataset.text); toast("Texto copiado.", "ok"); } catch { toast("No se pudo copiar.", "error"); }
});
$("#m-reveal").addEventListener("click", () => modalFile && revealPath(norm(modalFile.path)));
$("#m-delete").addEventListener("click", async () => {
  if (!modalItem || !confirm(`¿Eliminar "${modalItem.name}" y todos sus archivos? No se puede deshacer.`)) return;
  try {
    const res = await post("/api/library/delete", { paths: modalItem.files.map((f) => norm(f.path)) });
    toast(`${res.deleted} archivo${res.deleted === 1 ? "" : "s"} eliminado${res.deleted === 1 ? "" : "s"}.`, "ok");
    closeModal(); loadLibrary();
  } catch (err) { toast(err.message, "error"); }
});

// ---------- AJUSTES ----------
async function loadSettings() {
  try {
    const s = await api("/api/settings");
    $("#s-dir").value = s.download_dir; $("#s-langs").value = s.subtitle_langs.join(", ");
    $("#s-site").checked = s.organize_by_site; $("#s-h264").checked = s.prefer_h264;
    renderSystem();
  } catch (err) { toast(err.message, "error"); }
}
function renderSystem() {
  const c = health?.capabilities || {};
  const rows = [
    [c.curl_cffi, `curl_cffi: ${c.curl_cffi ? "instalado" : "FALTA"}`, c.curl_cffi ? "Necesario para que TikTok no bloquee las descargas." : "TikTok bloqueará las descargas. Ejecuta install-windows.bat otra vez."],
    [c.ffmpeg, `FFmpeg: ${c.ffmpeg ? "instalado" : "no encontrado"}`, c.ffmpeg ? "MP3, subtítulos SRT y portadas JPG disponibles." : "Sin él no hay MP3 ni mezcla de audio y video."],
    [c.browser, `Navegador para capturas: ${c.browser ? "disponible" : "no encontrado"}`, c.browser ? "Capturas de pantalla, PDF y páginas con JavaScript." : "Instala Edge o Chrome."],
    [c.whisper ? true : null, `Transcripción automática (Whisper): ${c.whisper ? "activa" : "opcional"}`, c.whisper ? "Se usa cuando un video no trae subtítulos." : "Para videos sin subtítulos: pip install faster-whisper"],
    [true, `yt-dlp ${c.yt_dlp || ""}`, ""],
  ];
  const ul = $("#sys"); ul.replaceChildren();
  rows.forEach(([ok, title, note]) => ul.append(h("li", {}, h("span", { class: `dot ${ok === true ? "" : ok === null ? "warn" : "bad"}` }), h("span", {}, h("b", {}, title), note ? ` — ${note}` : ""))));
  $("#ver").textContent = `v${health?.version || ""}`;
  $("#cap-nobrowser").classList.toggle("hidden", !!c.browser);
  ["#c-shot", "#c-pdf"].forEach((id) => { $(id).disabled = !c.browser; if (!c.browser) $(id).checked = false; });
}
$("#s-save").addEventListener("click", async () => {
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({
      download_dir: $("#s-dir").value.trim(), subtitle_langs: $("#s-langs").value.split(",").map((x) => x.trim()).filter(Boolean),
      organize_by_site: $("#s-site").checked, prefer_h264: $("#s-h264").checked }) });
    await initHealth(); toast("Ajustes guardados.", "ok");
  } catch (err) { toast(err.message, "error"); }
});
$("#s-update").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget; btn.disabled = true; btn.textContent = "Actualizando…";
  const out = $("#s-update-out");
  try {
    const r = await post("/api/update-ytdlp");
    out.textContent = r.output + (r.ok ? "\n\nListo. Cierra y vuelve a abrir TikSave para usar la versión nueva." : "");
    out.classList.remove("hidden");
    toast(r.ok ? "yt-dlp actualizado. Reinicia TikSave." : "No se pudo actualizar.", r.ok ? "ok" : "error");
  } catch (err) { toast(err.message, "error"); }
  btn.disabled = false; btn.textContent = "Actualizar yt-dlp";
});

// ---------- inicio ----------
async function initHealth() {
  health = await api("/api/health");
  downloadDir = health.download_dir; sites = health.sites;
  renderSystem();
}
(async function init() {
  try { await initHealth(); } catch { /* banner offline */ }
  const opts = store.get("download-opts", null);
  if (opts) {
    const radio = $(`input[name="mode"][value="${opts.mode}"]`); if (radio) radio.checked = true;
    $("#x-transcript").checked = !!opts.transcript; $("#x-notes").checked = !!opts.notes; $("#x-cover").checked = !!opts.cover;
  }
  showTab(store.get("tab", "download"));
  updateDownloadUi();
  refreshJobs();
})();
