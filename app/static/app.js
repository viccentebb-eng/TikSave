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

// ---------- selector de rango (recorte) ----------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function fmtClock(sec) {
  sec = Math.max(0, sec);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  const ssTxt = (ss < 10 ? "0" : "") + ss.toFixed(1).replace(/\.0$/, "");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ssTxt}` : `${mm}:${ssTxt}`;
}
function parseClock(txt) {
  const parts = String(txt).trim().replace(",", ".").split(":").map(Number);
  if (!parts.length || parts.length > 3 || parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
// Doble control deslizante + campos de tiempo. Devuelve { get, set, setDuration, isFull }.
function makeRange(container, { duration = 0, onChange = () => {}, onScrub = () => {} } = {}) {
  const GAP = 0.2;
  let max = Math.max(GAP * 2, duration);
  const a = h("input", { type: "range", min: 0, max, step: 0.1, value: 0, "aria-label": "Inicio del recorte" });
  const b = h("input", { type: "range", min: 0, max, step: 0.1, value: max, "aria-label": "Fin del recorte" });
  const fill = h("div", { class: "rng-fill" });
  const ta = h("input", { type: "text", inputmode: "decimal", "aria-label": "Inicio (mm:ss)" });
  const tb = h("input", { type: "text", inputmode: "decimal", "aria-label": "Fin (mm:ss)" });
  const len = h("span", { class: "rng-len" });
  const get = () => ({ start: +a.value, end: +b.value });
  const paint = () => {
    const { start, end } = get();
    fill.style.left = `${(start / max) * 100}%`;
    fill.style.width = `${((end - start) / max) * 100}%`;
    a.style.zIndex = start > max / 2 ? 3 : 1; b.style.zIndex = 2;
    ta.value = fmtClock(start); tb.value = fmtClock(end);
    len.textContent = `Duración: ${fmtClock(end - start)}`;
  };
  a.addEventListener("input", () => { a.value = Math.min(+a.value, +b.value - GAP); paint(); onChange(get()); onScrub(+a.value, "start"); });
  b.addEventListener("input", () => { b.value = Math.max(+b.value, +a.value + GAP); paint(); onChange(get()); onScrub(+b.value, "end"); });
  const typed = (input, which) => () => {
    const v = parseClock(input.value);
    if (v != null) {
      if (which === "start") a.value = clamp(v, 0, +b.value - GAP); else b.value = clamp(v, +a.value + GAP, max);
    }
    paint(); onChange(get()); onScrub(which === "start" ? +a.value : +b.value, which);
  };
  ta.addEventListener("change", typed(ta, "start")); tb.addEventListener("change", typed(tb, "end"));
  container.replaceChildren(h("div", { class: "rng" },
    h("div", { class: "rng-track" }, fill, a, b),
    h("div", { class: "rng-times" }, h("label", {}, "Inicio", ta), len, h("label", {}, "Fin", tb))));
  paint();
  return {
    get,
    set(start, end) {
      if (start != null) a.value = clamp(start, 0, +b.value - GAP);
      if (end != null) b.value = clamp(end, +a.value + GAP, max);
      paint(); onChange(get());
    },
    setDuration(d) { max = Math.max(GAP * 2, d); a.max = b.max = max; a.value = 0; b.value = max; paint(); },
    isFull: () => +a.value <= 0.05 && +b.value >= max - 0.05,
  };
}

// ---------- tema (claro / oscuro / automatico) ----------
const THEMES = ["auto", "dark", "light"], THEME_NAME = { auto: "auto", dark: "oscuro", light: "claro" };
function applyTheme(t) {
  const root = document.documentElement;
  if (t === "auto") root.removeAttribute("data-theme"); else root.dataset.theme = t;
  $("#theme").textContent = `Tema: ${THEME_NAME[t]}`;
}
$("#theme").addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(store.get("theme", "auto")) + 1) % THEMES.length];
  store.set("theme", next); applyTheme(next);
});
applyTheme(store.get("theme", "auto"));

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
let anySite = true;
let previewTimer = null;
let lastPreviewed = "";
let previewDuration = 0;
let rangeDl = null;

function hostOk(url) {
  try {
    const parsed = new URL(url);
    if (anySite) return /^https?:$/.test(parsed.protocol);
    const host = parsed.hostname.toLowerCase();
    return Object.values(sites).some((domains) => domains.some((d) => host === d || host.endsWith("." + d)));
  } catch { return false; }
}
function extractUrls(text) {
  const found = text.match(/https?:\/\/[^\s<>"']+/g) || [];
  return [...new Set(found.map((u) => u.replace(/[),.;]+$/, "")))];
}
const CHAT_SITES = ["chatgpt.com", "chat.openai.com", "gemini.google.com", "claude.ai"];
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
  const chatLink = valid.find((u) => CHAT_SITES.some((d) => new URL(u).hostname.toLowerCase().endsWith(d)));
  if (chatLink) {
    hint.append(h("div", { class: "bad" }, "Esto es una conversación de ChatGPT/Gemini/Claude: yt-dlp no puede leerla. "),
      h("button", { class: "btn small", onclick: () => { $("#cap-url").value = chatLink; showTab("capture"); toast("Para guardar la conversación con tu sesión, usa la extensión → Capturar esta página.", "ok"); } }, "Ir a Capturar web"));
  }
  const textOnly = mode === "transcript", coverOnly = mode === "cover";
  $("#x-transcript").disabled = textOnly; if (textOnly) $("#x-transcript").checked = true;
  $("#x-cover").disabled = coverOnly; if (coverOnly) $("#x-cover").checked = true;
  $("#go").disabled = valid.length === 0;
  $("#go-label").textContent = valid.length > 1 ? `Descargar ${valid.length} enlaces` : "Descargar";
  $("#profile-box").classList.toggle("hidden", !(valid.length === 1 && isProfile(valid[0])));
  const trimmable = valid.length === 1 && !isProfile(valid[0]) && previewDuration >= 3 && ["video", "mp3", "audio"].includes(mode);
  $("#trim-box").classList.toggle("hidden", !trimmable);

  clearTimeout(previewTimer);
  if (valid.length === 1 && !isProfile(valid[0])) {
    if (valid[0] !== lastPreviewed) previewTimer = setTimeout(() => loadPreview(valid[0]), 500);
  } else {
    $("#preview").classList.add("hidden");
    lastPreviewed = ""; previewDuration = 0;
    $("#trim-on").checked = false; $("#trim-ui").classList.add("hidden");
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
    previewDuration = d.duration || 0;
    $("#trim-on").checked = false; $("#trim-ui").classList.add("hidden");
    rangeDl = previewDuration >= 3 ? makeRange($("#trim-ui"), { duration: previewDuration }) : null;
    updateDownloadUi();
  } catch (err) {
    if (lastPreviewed !== url) return;
    // No es un video que yt-dlp entienda: se muestra la pagina (titulo e imagen) para saber que es.
    try {
      const p = await post("/api/page-preview", { url });
      if (lastPreviewed !== url) return;
      previewDuration = 0;
      $("#thumb").src = p.image || ""; $("#thumb").style.visibility = p.image ? "visible" : "hidden";
      $("#thumb").referrerPolicy = "no-referrer";
      $("#p-title").textContent = p.title;
      $("#p-meta").textContent = [p.site, p.description].filter(Boolean).join(" · ");
      const badges = $("#p-badges"); badges.replaceChildren(h("span", { class: "badge warn" }, "Página, no video"));
      $("#preview").classList.remove("hidden");
      $("#url-hint").append(h("div", { class: "muted" }, "Esto no es un video descargable. Para guardar la página usa «Capturar web» o la extensión."));
    } catch {
      if (lastPreviewed !== url) return;
      $("#preview").classList.add("hidden");
      $("#url-hint").append(h("div", { class: "bad" }, err.message));
    }
  }
}

urlsEl.addEventListener("input", updateDownloadUi);
urlsEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#go").click(); }
});

// Arrastrar y soltar enlaces en cualquier parte de la pantalla
let dragDepth = 0;
const dropText = (dt) => (dt.getData("text/uri-list") || dt.getData("text/plain") || "").split(/\r?\n/).filter((l) => !l.startsWith("#")).join("\n");
document.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].some((t) => t === "text/plain" || t === "text/uri-list")) return;
  e.preventDefault(); dragDepth++;
  $("#drop-overlay").classList.remove("hidden");
  $("#dropzone").classList.toggle("over", showingDownload() && true);
});
function showingDownload() { return !$("#tab-download").classList.contains("hidden"); }
document.addEventListener("dragover", (e) => { if (dragDepth) e.preventDefault(); });
document.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { $("#drop-overlay").classList.add("hidden"); $("#dropzone").classList.remove("over"); } });
document.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("#drop-overlay").classList.add("hidden"); $("#dropzone").classList.remove("over");
  const text = dropText(e.dataTransfer || { getData: () => "" });
  if (!extractUrls(text).length) return;
  showTab("download");
  urlsEl.value = (urlsEl.value.trim() ? urlsEl.value.trim() + "\n" : "") + text.trim();
  updateDownloadUi();
  toast("Enlace añadido. Revisa el formato y pulsa Descargar.", "ok");
});
$$('input[name="mode"], #x-transcript, #x-notes, #x-cover').forEach((el) => el.addEventListener("change", updateDownloadUi));

$("#trim-on").addEventListener("change", () => $("#trim-ui").classList.toggle("hidden", !$("#trim-on").checked));

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
    const extras = { transcript: $("#x-transcript").checked, notes: $("#x-notes").checked, cover: $("#x-cover").checked };
    const clip = urls.length === 1 && !$("#trim-box").classList.contains("hidden") && $("#trim-on").checked
      && rangeDl && !rangeDl.isFull() ? rangeDl.get() : null;
    if (clip) {
      await post("/api/download", { url: urls[0], mode, ...extras, start: clip.start, end: clip.end });
      toast(`Descarga del tramo ${fmtClock(clip.start)}–${fmtClock(clip.end)} en cola.`, "ok");
    } else {
      const res = await post("/api/download/batch", { urls, mode, ...extras });
      toast(`${res.jobs.length} descarga${res.jobs.length === 1 ? "" : "s"} en cola.`, "ok");
    }
    urlsEl.value = ""; lastPreviewed = ""; previewDuration = 0;
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
      docx: $("#c-docx").checked, epub: $("#c-epub").checked, images: $("#c-images").checked,
      full_content: $("#c-full").value === "1", render: $("#c-render").value,
      depth: Number($("#c-depth").value), max_pages: Math.min(1000, Math.max(1, Number($("#c-max").value) || 10)),
      files: $("#c-files").checked, media: $("#c-media").checked,
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
const MODE = { video: "Video MP4", mp3: "Audio MP3", audio: "Audio original", transcript: "Texto", cover: "Portada", capture: "Captura web", trim: "Recorte", record: "Grabación", convert: "Conversión" };
const ACTIVE = new Set(["queued", "starting", "downloading", "processing"]);

function jobCard(job) {
  const card = h("div", { class: "job", "data-id": job.id });
  card.append(
    h("div", { class: "job-top" },
      h("img", { class: "job-thumb hidden", alt: "", referrerpolicy: "no-referrer", loading: "lazy" }),
      h("div", { class: "job-ic" }, icon(job.kind === "capture" ? "globe" : job.kind === "trim" ? "scissors" : job.kind === "record" ? "play" : job.kind === "convert" ? "sparkle" : "download")),
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
  $(".job-title", card).title = job.title || job.url;
  const thumb = $(".job-thumb", card), iconEl = $(".job-ic", card);
  const showThumb = !!job.thumbnail && /^https:/.test(job.thumbnail);
  if (showThumb && thumb.getAttribute("src") !== job.thumbnail) thumb.src = job.thumbnail;
  thumb.classList.toggle("hidden", !showThumb);
  iconEl.classList.toggle("hidden", showThumb);
  const extras = [];
  if (job.options?.transcript && job.mode !== "transcript") extras.push("texto");
  if (job.options?.notes) extras.push("ficha");
  if (job.options?.cover && job.mode !== "cover") extras.push("portada");
  if (job.kind === "download" && (job.options?.start != null || job.options?.end != null)) {
    extras.push(`recorte ${fmtClock(job.options.start || 0)}–${job.options.end ? fmtClock(job.options.end) : "fin"}`);
  } else if (job.kind === "trim") extras.push(`${fmtClock(job.options.start)}–${fmtClock(job.options.end)}`);

  const modeLabel = job.kind === "convert" ? `Conversión · ${CONVERT_LABEL[job.mode] || job.mode}` : (MODE[job.mode] || job.mode);
  $(".job-sub", card).textContent = [modeLabel, job.uploader && (job.kind === "capture" ? job.uploader : `@${String(job.uploader).replace(/^@/, "")}`),
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
  if ((job.status === "error" || job.status === "cancelled") && job.kind !== "record") actions.append(btn("Reintentar", "retry", () => post(`/api/jobs/${job.id}/retry`).then(refreshJobs).catch((e) => toast(e.message, "error"))));
  if (!ACTIVE.has(job.status)) actions.append(btn("Quitar", "x", () => api(`/api/jobs/${job.id}`, { method: "DELETE" }).then(refreshJobs), "ghost"));
}

function jobAsItem(job) {
  const kindOf = (f) => { const e = f.split(".").pop().toLowerCase();
    return ["mp4", "webm", "mkv", "mov"].includes(e) ? "video" : ["mp3", "m4a", "opus", "ogg", "wav", "aac"].includes(e) ? "audio"
      : ["jpg", "jpeg", "png", "webp"].includes(e) ? "image" : ["html", "htm", "pdf"].includes(e) ? "page" : "text"; };
  return { name: job.title || job.url, files: job.files.map((f) => ({ path: relPath(f), name: norm(f).split("/").pop(), kind: kindOf(f) })) };
}

const DONE_SHOWN = 4;
let showAllDone = false;
function syncJobs(jobs) {
  lastJobs = jobs;
  const ids = new Set(jobs.map((j) => j.id));
  for (const [id, el] of jobEls) if (!ids.has(id)) { el.remove(); jobEls.delete(id); }
  const list = $("#q-list");
  let finishedSeen = 0, hiddenCount = 0;
  jobs.forEach((job, index) => {
    let el = jobEls.get(job.id);
    if (!el) { el = jobCard(job); jobEls.set(job.id, el); }
    updateJobCard(el, job);
    const finished = !ACTIVE.has(job.status);
    const collapsed = finished && ++finishedSeen > DONE_SHOWN && !showAllDone;
    el.classList.toggle("hidden", collapsed);
    if (collapsed) hiddenCount++;
    if (list.children[index] !== el) list.insertBefore(el, list.children[index] || null);
    const before = prevStatus.get(job.id);
    if (before && ACTIVE.has(before) && !ACTIVE.has(job.status)) {
      if (job.status === "done") { toast(`Listo: ${(job.title || job.url).slice(0, 70)}`, "ok"); if (!$("#tab-library").classList.contains("hidden")) loadLibrary(); }
      else if (job.status === "error") toast(job.error || "Falló una descarga.", "error");
    }
    prevStatus.set(job.id, job.status);
  });
  let more = $("#q-more");
  if (!more) { more = h("button", { id: "q-more", class: "btn ghost small q-more", onclick: () => { showAllDone = !showAllDone; syncJobs(lastJobs); } }); list.after(more); }
  more.classList.toggle("hidden", !hiddenCount && !(showAllDone && finishedSeen > DONE_SHOWN));
  more.textContent = showAllDone ? "Mostrar menos" : `Ver ${hiddenCount} anteriores`;
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
let libSort = "recent";
let selecting = false;
const selected = new Set();
const SORTERS = {
  recent: (a, b) => b.modified - a.modified,
  name: (a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }),
  size: (a, b) => b.size - a.size,
};
function videoFile(item) { return item.files.find((f) => f.kind === "video"); }

function renderLibrary() {
  const q = $("#lib-q").value.trim().toLowerCase();
  const items = libItems
    .filter((i) => (libFilter === "all" || i.type === libFilter) && (!q || i.name.toLowerCase().includes(q)))
    .sort(SORTERS[libSort]);
  const grid = $("#lib-grid"); grid.replaceChildren();
  $("#lib-empty").classList.toggle("hidden", items.length > 0);
  for (const item of items) {
    const thumb = h("div", { class: "lib-thumb" }, h("span", { class: "lib-kind" }, KIND_LABEL[item.type] || item.type));
    if (item.cover) thumb.prepend(h("img", { src: `/files/${encPath(norm(item.cover))}`, alt: "", loading: "lazy" }));
    else if (item.type === "video" || item.type === "audio") {
      const src = `/api/thumb?path=${encodeURIComponent(norm(item.files.find((f) => f.kind === item.type)?.path || item.files[0].path))}`;
      thumb.prepend(h("img", { class: "thumb-media", src, alt: "", loading: "lazy", onerror: (e) => e.target.remove() }));
      thumb.prepend(icon(item.type === "audio" ? "play" : "play"));
    }
    else if (item.snippet) { thumb.classList.add("has-snippet"); thumb.prepend(h("div", { class: "lib-snippet" }, item.snippet)); }
    else thumb.prepend(icon(item.type === "site" ? "globe" : "file"));
    const check = h("span", { class: "check", "aria-hidden": "true" }, icon("check"));
    const card = h("button", { class: `lib-card${selected.has(item.id) ? " sel" : ""}`, title: item.name,
      "aria-pressed": selecting ? String(selected.has(item.id)) : null,
      onclick: () => (selecting ? toggleSelect(item.id) : openItem(item)) }, thumb, check,
      h("div", { class: "lib-info" }, h("div", { class: "lib-name" }, item.name),
        h("div", { class: "lib-meta" }, [item.platform && item.platform !== "Sitios" ? item.platform : null, fmtSize(item.size), fmtDate(item.modified)].filter(Boolean).join(" · "))));
    const vf = videoFile(item);
    if (vf && !item.cover) attachPreview(card, thumb, `/files/${encPath(norm(vf.path))}`);
    grid.append(card);
  }
  updateBulk();
}

// Vista previa al pasar el mouse: el video solo se carga mientras el cursor esta encima.
function attachPreview(card, thumb, src) {
  card.addEventListener("mouseenter", () => {
    if (selecting || thumb.querySelector("video")) return;
    const v = h("video", { class: "lib-preview", src, muted: true, playsinline: true, loop: true, preload: "auto" });
    thumb.append(v);
    v.play().catch(() => {});
  });
  card.addEventListener("mouseleave", () => { const v = thumb.querySelector("video"); if (v) { v.pause(); v.remove(); } });
}

function toggleSelect(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  renderLibrary();
}
function setSelecting(on) {
  selecting = on;
  if (!on) selected.clear();
  document.body.classList.toggle("selecting", on);
  $("#lib-select").textContent = on ? "Cancelar selección" : "Seleccionar";
  renderLibrary();
}
function updateBulk() {
  const n = selected.size;
  $("#lib-bulk").classList.toggle("hidden", !selecting);
  $("#lib-sel-count").textContent = `${n} seleccionado${n === 1 ? "" : "s"}`;
  $("#lib-del-sel").disabled = n === 0;
}
$("#lib-select").addEventListener("click", () => setSelecting(!selecting));
$("#lib-sel-done").addEventListener("click", () => setSelecting(false));
$("#lib-sort").addEventListener("change", (e) => { libSort = e.target.value; renderLibrary(); });
$("#lib-del-sel").addEventListener("click", async () => {
  const chosen = libItems.filter((i) => selected.has(i.id));
  if (!chosen.length || !confirm(`¿Eliminar ${chosen.length} elemento${chosen.length === 1 ? "" : "s"} y todos sus archivos? No se puede deshacer.`)) return;
  try {
    const res = await post("/api/library/delete", { paths: chosen.flatMap((i) => i.files.map((f) => norm(f.path))) });
    toast(`${res.deleted} archivo${res.deleted === 1 ? "" : "s"} eliminado${res.deleted === 1 ? "" : "s"}.`, "ok");
    selected.clear(); setSelecting(false); loadLibrary();
  } catch (err) { toast(err.message, "error"); }
});
$("#lib-q").addEventListener("input", renderLibrary);
$("#lib-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  libFilter = b.dataset.f; $$("#lib-filter button").forEach((x) => x.classList.toggle("active", x === b)); renderLibrary();
});
$("#lib-open").addEventListener("click", () => revealPath(null));

// ---------- subir archivos locales ----------
function uploadOne(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      const data = (() => { try { return JSON.parse(xhr.responseText); } catch { return {}; } })();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(typeof data.detail === "string" ? `${file.name}: ${data.detail}` : `${file.name}: error ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error(`${file.name}: no se pudo conectar con TikSave.`));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}
async function uploadFiles(files) {
  const list = [...files];
  if (!list.length) return;
  const box = $("#lib-drop");
  box.classList.remove("hidden");
  const failed = [];
  let done = 0;
  for (const file of list) {
    box.replaceChildren(h("div", {}, `Subiendo ${file.name} (${done + 1} de ${list.length})…`),
      h("div", { class: "track" }, h("div", { class: "bar", id: "up-bar", style: "width:0%" })));
    try {
      await uploadOne(file, (p) => { const bar = $("#up-bar"); if (bar) bar.style.width = `${Math.round(p * 100)}%`; });
      done++;
    } catch (err) { failed.push(err.message); }
  }
  box.classList.add("hidden"); box.replaceChildren();
  if (done) toast(`${done} archivo${done === 1 ? "" : "s"} subido${done === 1 ? "" : "s"} a la Biblioteca.`, "ok");
  failed.forEach((m) => toast(m, "error"));
  loadLibrary();
}
$("#lib-upload").addEventListener("click", () => $("#lib-file").click());
$("#lib-file").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });
const libTab = $("#tab-library");
let libDrag = 0;
libTab.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault(); libDrag++; libTab.classList.add("dragging");
});
libTab.addEventListener("dragover", (e) => { if (libTab.classList.contains("dragging")) e.preventDefault(); });
libTab.addEventListener("dragleave", () => { libDrag = Math.max(0, libDrag - 1); if (!libDrag) libTab.classList.remove("dragging"); });
libTab.addEventListener("drop", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault(); libDrag = 0; libTab.classList.remove("dragging");
  uploadFiles(e.dataTransfer.files);
});

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
  closeCutter();
  $("#m-cut").classList.toggle("hidden", !["video", "audio"].includes(f.kind));
  $("#m-convert").classList.toggle("hidden", !["video", "audio"].includes(f.kind));
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
// Muestra 12 fotogramas repartidos a lo largo del video (solo archivos locales: no hay CORS).
async function paintFrames(media, strip) {
  const dur = media.duration;
  if (!isFinite(dur) || dur <= 0 || media.tagName !== "VIDEO") return;
  const was = media.currentTime, paused = media.paused;
  const canvas = document.createElement("canvas");
  canvas.width = 160; canvas.height = Math.round(160 * (media.videoHeight / Math.max(1, media.videoWidth)) || 90);
  const ctx = canvas.getContext("2d");
  const seekTo = (t) => new Promise((res) => {
    const done = () => { clearTimeout(timer); media.removeEventListener("seeked", done); res(); };
    const timer = setTimeout(done, 1500); // si el navegador no dispara "seeked", no bloquear
    media.addEventListener("seeked", done);
    media.currentTime = t;
  });
  try {
    media.pause();
    for (let i = 0; i < 12; i++) {
      await seekTo(Math.min(dur - 0.05, (dur * (i + 0.5)) / 12));
      if (!strip.isConnected) return;
      ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
      strip.append(h("img", { src: canvas.toDataURL("image/jpeg", 0.6), alt: "" }));
    }
  } catch { /* sin fotogramas: la barra funciona igual */ }
  finally { if (isFinite(was)) media.currentTime = was; if (!paused) media.play().catch(() => {}); }
}

const CONVERT_LABEL = { compress: "comprimir", mp4: "a MP4", webm: "a WebM", mp3: "audio MP3", m4a: "audio M4A", opus: "audio Opus" };
const VIDEO_ONLY_ACTIONS = new Set(["compress", "mp4", "webm"]);

// Panel de conversion: accion, calidad y resolucion. Solo cambia el archivo nuevo; el original no se toca.
function openConvert() {
  const box = $("#m-trim");
  if (!box.classList.contains("hidden") && box.dataset.mode === "convert") { closeCutter(); return; }
  if (!modalFile) return;
  const isVideo = modalFile.kind === "video";
  const action = h("select", { "aria-label": "Qué hacer" },
    ...(isVideo ? [h("option", { value: "compress" }, "Comprimir (archivo más pequeño)"), h("option", { value: "mp4" }, "Convertir a MP4"),
                   h("option", { value: "webm" }, "Convertir a WebM"), h("option", { value: "mp3" }, "Sacar solo el audio (MP3)"),
                   h("option", { value: "m4a" }, "Sacar solo el audio (M4A)"), h("option", { value: "opus" }, "Sacar solo el audio (Opus)")]
      : [h("option", { value: "mp3" }, "Convertir a MP3"), h("option", { value: "m4a" }, "Convertir a M4A"), h("option", { value: "opus" }, "Convertir a Opus")]));
  const quality = h("select", { "aria-label": "Calidad" },
    h("option", { value: "alta" }, "Alta (mejor calidad)"), h("option", { value: "media", selected: true }, "Media (recomendada)"),
    h("option", { value: "baja" }, "Baja (más pequeño)"), h("option", { value: "muy_baja" }, "Muy baja (mínimo)"));
  const height = h("select", { "aria-label": "Resolución" },
    h("option", { value: "" }, "Resolución original"), h("option", { value: "1080" }, "1080p"), h("option", { value: "720" }, "720p"),
    h("option", { value: "480" }, "480p"), h("option", { value: "360" }, "360p"));
  const note = h("div", { class: "muted" }, "El archivo original se queda como está; el resultado aparece en la Biblioteca.");
  const sync = () => { height.disabled = !VIDEO_ONLY_ACTIONS.has(action.value); if (height.disabled) height.value = ""; };
  action.addEventListener("change", sync); sync();
  const go = h("button", { class: "btn small primary", onclick: async () => {
    const h2 = height.value ? Number(height.value) : null;
    try {
      await post("/api/convert", { path: norm(modalFile.path), action: action.value, quality: quality.value, height: h2 });
      toast("Conversión en cola.", "ok"); closeCutter(); refreshJobs();
    } catch (err) { toast(err.message, "error"); }
  } }, icon("sparkle"), "Convertir");
  box.dataset.mode = "convert";
  box.replaceChildren(h("div", { class: "rng-times" }, h("label", {}, "Qué hacer", action), h("label", {}, "Calidad", quality), h("label", {}, "Resolución", height)),
    h("div", { class: "rng-actions", style: "margin-top:12px" }, go, note));
  box.classList.remove("hidden");
}
$("#m-convert").addEventListener("click", openConvert);

function closeCutter() {
  $("#m-trim").classList.add("hidden"); $("#m-trim").replaceChildren();
}
function openCutter() {
  const box = $("#m-trim");
  if (!box.classList.contains("hidden")) { closeCutter(); return; }
  const media = $("#m-body video, #m-body audio");
  if (!media || !modalFile) return;
  const build = () => {
    const holder = h("div");
    const strip = h("div", { class: "rng-frames", "aria-hidden": "true" });
    const range = makeRange(holder, {
      duration: media.duration,
      onScrub: (t, which) => { media.pause(); media.currentTime = which === "end" ? Math.max(0, t - 0.1) : t; },
    });
    const precise = h("input", { type: "checkbox", checked: true });
    const preview = () => {
      const { start, end } = range.get();
      media.currentTime = start; media.play();
      const stop = () => { if (media.currentTime >= end) { media.pause(); media.removeEventListener("timeupdate", stop); } };
      media.addEventListener("timeupdate", stop);
    };
    const save = async () => {
      const { start, end } = range.get();
      try {
        await post("/api/trim", { path: norm(modalFile.path), start, end, precise: precise.checked });
        toast("Recorte en cola.", "ok"); closeCutter(); refreshJobs();
      } catch (err) { toast(err.message, "error"); }
    };
    box.replaceChildren(holder, h("div", { class: "rng-actions", style: "margin-top:12px" },
      h("button", { class: "btn small", onclick: () => range.set(media.currentTime, null) }, "Inicio = aquí"),
      h("button", { class: "btn small", onclick: () => range.set(null, media.currentTime) }, "Fin = aquí"),
      h("button", { class: "btn small", onclick: preview }, icon("play"), "Ver tramo"),
      h("label", { class: "switch" }, precise, h("span", {}, "Corte exacto ", h("small", {}, "(más lento)"))),
      h("button", { class: "btn small primary", onclick: save }, icon("scissors"), "Guardar recorte")));
    box.dataset.mode = "cut";
    box.classList.remove("hidden");
    const track = holder.querySelector(".rng-track");
    if (track) track.prepend(strip);
    paintFrames(media, strip);
  };
  if (media.readyState >= 1 && isFinite(media.duration)) build(); else media.addEventListener("loadedmetadata", build, { once: true });
}
$("#m-cut").addEventListener("click", openCutter);

function closeModal() {
  closeCutter();
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
    $("#s-site").checked = s.organize_by_site; $("#s-h264").checked = s.prefer_h264; $("#s-other").checked = s.allow_other_sites; $("#s-cookies").value = s.cookies_browser || "";
    renderSystem();
  } catch (err) { toast(err.message, "error"); }
}
function renderSystem() {
  const c = health?.capabilities || {};
  const rows = [
    [c.curl_cffi, `curl_cffi: ${c.curl_cffi ? "instalado" : "FALTA"}`, c.curl_cffi ? "Necesario para que TikTok no bloquee las descargas." : "TikTok bloqueará las descargas. Ejecuta install-windows.bat otra vez."],
    [c.ffmpeg, `FFmpeg: ${c.ffmpeg ? "instalado" : "no encontrado"}`, c.ffmpeg ? "MP3, subtítulos SRT y portadas JPG disponibles." : "Sin él no hay MP3 ni mezcla de audio y video."],
    [c.browser, `Navegador para capturas: ${c.browser ? "disponible" : "no encontrado"}`, c.browser ? "Capturas de pantalla, PDF y páginas con JavaScript." : "Instala Edge o Chrome."],
    [c.pandoc, `Exportar a Word/EPUB (pandoc): ${c.pandoc ? "disponible" : "no encontrado"}`, c.pandoc ? "Word con ecuaciones editables y EPUB." : "pip install pypandoc_binary"],
    [c.whisper ? true : null, `Transcripción automática (Whisper): ${c.whisper ? "activa" : "opcional"}`, c.whisper ? "Se usa cuando un video no trae subtítulos." : "Para videos sin subtítulos: pip install faster-whisper"],
    [true, `yt-dlp ${c.yt_dlp || ""}`, ""],
  ];
  const ul = $("#sys"); ul.replaceChildren();
  rows.forEach(([ok, title, note]) => ul.append(h("li", {}, h("span", { class: `dot ${ok === true ? "" : ok === null ? "warn" : "bad"}` }), h("span", {}, h("b", {}, title), note ? ` — ${note}` : ""))));
  $("#ver").textContent = `v${health?.version || ""}`;
  $("#cap-nobrowser").classList.toggle("hidden", !!c.browser);
  ["#c-docx", "#c-epub"].forEach((id) => { $(id).disabled = !c.pandoc; if (!c.pandoc) $(id).checked = false; });
  ["#c-shot", "#c-pdf"].forEach((id) => { $(id).disabled = !c.browser; if (!c.browser) $(id).checked = false; });
}
$("#s-save").addEventListener("click", async () => {
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({
      download_dir: $("#s-dir").value.trim(), subtitle_langs: $("#s-langs").value.split(",").map((x) => x.trim()).filter(Boolean),
      organize_by_site: $("#s-site").checked, prefer_h264: $("#s-h264").checked, allow_other_sites: $("#s-other").checked, cookies_browser: $("#s-cookies").value }) });
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
  downloadDir = health.download_dir; sites = health.sites; anySite = health.allow_other_sites !== false;
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
