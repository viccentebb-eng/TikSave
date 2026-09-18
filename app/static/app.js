const $ = (id) => document.getElementById(id);

const urlsInput = $("urls");
const message = $("message");
const jobsPanel = $("jobs");
const jobsBox = $("jobs-list");
const historyPanel = $("history");
const historyBox = $("history-list");
const jobPollers = new Map();
const completionNotified = new Set();

let completionAudio = null;
let completionToastTimer = null;
let currentInspection = null;
let trimDuration = 0;
let trimFramesLoadedFor = "";
let inspectTimer = null;
let analysisItems = [];
let activeAnalysisIndex = 0;

function setAnalysisState(text, type = "") {
  const node = $("analysis-state");
  if (!node) return;
  node.textContent = text;
  node.className = `analysis-state ${type}`.trim();
}

function setStatusPill(id, text, type = "pending") {
  const node = $(id);
  if (!node) return;
  node.className = `status-pill ${type}`;
  node.innerHTML = `<i></i>${escapeHtml(text)}`;
}

function showMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

function clearMessage() {
  message.textContent = "";
  message.className = "message hidden";
}

function armCompletionFeedback() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !completionAudio) {
      completionAudio = new AudioContextClass();
    }
    if (completionAudio?.state === "suspended") {
      completionAudio.resume().catch(() => {});
    }
  } catch {
    // Sound is optional; downloads continue normally.
  }

  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function playCompletionSound(success = true) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!completionAudio) completionAudio = new AudioContextClass();
    if (completionAudio.state === "suspended") {
      completionAudio.resume().catch(() => {});
    }

    const now = completionAudio.currentTime;
    const gain = completionAudio.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(success ? 0.11 : 0.07, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (success ? 0.42 : 0.28));
    gain.connect(completionAudio.destination);

    const notes = success ? [659.25, 783.99, 987.77] : [311.13, 246.94];
    notes.forEach((frequency, index) => {
      const oscillator = completionAudio.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, now + index * 0.085);
      oscillator.connect(gain);
      oscillator.start(now + index * 0.085);
      oscillator.stop(now + index * 0.085 + 0.18);
    });
  } catch {
    // Browsers can block audio when the page never received a user gesture.
  }
}

function showCompletionToast(job) {
  document.querySelector(".completion-toast")?.remove();
  if (completionToastTimer) clearTimeout(completionToastTimer);

  const success = job.status === "done";
  const toast = document.createElement("aside");
  toast.className = `completion-toast ${success ? "success" : "failure"}`;
  toast.setAttribute("role", "status");
  toast.innerHTML = `
    <div class="completion-mark">${success ? "✓" : "!"}</div>
    <div class="completion-copy">
      <strong>${success ? "Descarga terminada" : "La descarga falló"}</strong>
      <span>${escapeHtml(job.title || job.error || job.filename || (success ? "El archivo ya está listo." : "Revisa el historial para ver el error."))}</span>
    </div>
    <div class="completion-actions">
      ${success ? `<button class="icon-button" data-toast-folder title="Abrir carpeta de descargas" aria-label="Abrir carpeta de descargas">${folderIcon()}</button>` : ""}
      <button class="completion-close" data-toast-close aria-label="Cerrar">×</button>
    </div>
  `;

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));

  toast.querySelector("[data-toast-close]")?.addEventListener("click", () => toast.remove());
  toast.querySelector("[data-toast-folder]")?.addEventListener("click", () => {
    api("/api/open-folder", { method: "POST" }).catch(() => {});
  });

  completionToastTimer = setTimeout(() => toast.remove(), 10000);
}

function showSystemCompletion(job) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  try {
    const success = job.status === "done";
    const notification = new Notification(
      success ? "TikSave · Descarga terminada" : "TikSave · Descarga fallida",
      {
        body: String(job.title || job.error || job.filename || (success ? "El archivo ya está listo." : "No se pudo completar la descarga.")).slice(0, 180),
        tag: `tiksave-${job.id || Date.now()}`,
      },
    );
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    setTimeout(() => notification.close(), 12000);
  } catch {
    // In-app toast remains as the reliable fallback.
  }
}

function notifyCompletion(job) {
  const key = String(job.id || `${job.status}-${job.filename || job.title || Date.now()}`);
  if (completionNotified.has(key)) return;
  completionNotified.add(key);

  const success = job.status === "done";
  playCompletionSound(success);
  showCompletionToast(job);
  showSystemCompletion(job);
}

function notifyDirectCompletion(title, filename = "") {
  notifyCompletion({
    id: `direct-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    status: "done",
    title,
    filename,
  });
}

function extractUrls(value) {
  const matches = String(value || "").match(
    /https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/gi,
  ) || [];

  return [...new Set(
    matches
      .map((item) => item.replace(/[.,;:!?\)\]\}>，。；：！？）》】」』]+$/g, ""))
      .filter(Boolean),
  )];
}

function getUrls() {
  const urls = extractUrls(urlsInput.value);
  if (!urls.length) throw new Error("Pega al menos un enlace o un texto que contenga una URL.");
  return urls;
}

function platformLabel(platform) {
  return {
    tiktok: "TikTok",
    douyin: "Douyin",
    youtube: "YouTube",
    instagram: "Instagram",
    facebook: "Facebook",
    web: "Video del navegador",
  }[platform] || platform || "Video";
}

function shortUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function readableError(value, fallback = "Error desconocido") {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((item) => readableError(item, "")).filter(Boolean);
    return parts.join("; ") || fallback;
  }
  if (typeof value === "object") {
    if (typeof value.msg === "string") {
      const where = Array.isArray(value.loc)
        ? value.loc.filter((part) => part !== "body").join(".")
        : "";
      return where ? `${where}: ${value.msg}` : value.msg;
    }
    for (const key of ["detail", "error", "message", "reason"]) {
      if (value[key] != null) return readableError(value[key], fallback);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return String(value);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = data.detail ?? data.error ?? data.message ?? `Error ${res.status}`;
    throw new Error(readableError(raw, `Error ${res.status}`));
  }
  return data;
}

function resetInspection() {
  currentInspection = null;
  $("preview").classList.add("hidden");
  $("carousel-panel").classList.add("hidden");
  $("carousel-grid").innerHTML = "";
  $("subtitle-panel").classList.add("hidden");
  $("subtitle-tracks").innerHTML = "";
  $("capabilities-panel").classList.add("hidden");
  $("capability-buttons").innerHTML = "";
  $("analysis-notes").classList.add("hidden");
  $("analysis-notes").innerHTML = "";
  $("media-actions").classList.add("hidden");
  $("page-images-panel").classList.add("hidden");
  $("page-images-grid").innerHTML = "";
  $("trim-panel").classList.add("hidden");
  $("clip-enabled").checked = false;
  $("trim-fields").classList.add("hidden");
  trimDuration = 0;
  trimFramesLoadedFor = "";
  $("trim-filmstrip").innerHTML = "";
}

function activeAnalysisItem() {
  return analysisItems[activeAnalysisIndex] || null;
}

function activeUrl() {
  const item = activeAnalysisItem();
  if (item?.url) return item.url;
  const urls = getUrls();
  return urls[0];
}

function renderAnalysisQueue() {
  const panel = $("analysis-queue");
  const list = $("analysis-queue-list");

  if (analysisItems.length <= 1) {
    panel.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  const finished = analysisItems.filter((item) => ["done", "error"].includes(item.status)).length;
  $("analysis-queue-summary").textContent = `${finished} / ${analysisItems.length}`;

  list.innerHTML = analysisItems.map((item, index) => {
    const active = index === activeAnalysisIndex ? " active" : "";
    const status = {
      pending: "Pendiente",
      analyzing: "Analizando…",
      done: item.data?.cached ? "Listo · caché" : "Listo",
      error: "Error",
    }[item.status] || item.status;

    return `
      <button class="analysis-item${active}" data-analysis-index="${index}">
        <span class="analysis-item-number">${index + 1}</span>
        <span class="analysis-item-copy">
          <strong>${escapeHtml(item.data?.title || shortUrl(item.url))}</strong>
          <small>${escapeHtml(status)}${item.error ? ` · ${escapeHtml(item.error)}` : ""}</small>
        </span>
        <span class="analysis-item-platform">${escapeHtml(platformLabel(item.data?.platform || ""))}</span>
      </button>
    `;
  }).join("");

  panel.classList.remove("hidden");
}

function selectAnalysisItem(index) {
  if (!Number.isInteger(index) || !analysisItems[index]) return;
  activeAnalysisIndex = index;
  renderAnalysisQueue();

  const item = analysisItems[index];
  if (item.data) {
    resetInspection();
    currentInspection = item.data;
    renderInspection(item.data);
    setAnalysisState(item.data.cached ? "Listo · caché" : "Listo", "ok");
  } else {
    resetInspection();
    setAnalysisState(item.status === "error" ? "Error" : "Pendiente", item.status === "error" ? "error" : "");
    if (item.error) showMessage(item.error, "error");
  }
}

$("analysis-queue-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-analysis-index]");
  if (!button) return;
  selectAnalysisItem(Number(button.dataset.analysisIndex));
});

async function inspectFirst({ silent = false } = {}) {
  const urls = getUrls();
  if (!silent) clearMessage();

  const inspectButton = $("inspect");
  inspectButton.disabled = true;
  analysisItems = urls.map((url) => ({ url, status: "pending", data: null, error: null }));
  activeAnalysisIndex = 0;
  resetInspection();
  renderAnalysisQueue();

  let firstSuccess = -1;

  try {
    for (let index = 0; index < analysisItems.length; index += 1) {
      const item = analysisItems[index];
      item.status = "analyzing";
      setAnalysisState(`Analizando ${index + 1} / ${analysisItems.length}…`, "busy");
      renderAnalysisQueue();

      try {
        const data = await api("/api/analyze", {
          method: "POST",
          body: JSON.stringify({
            url: item.url,
            playlist: $("playlist").checked,
          }),
        });

        item.status = "done";
        item.data = data;
        if (firstSuccess < 0) {
          firstSuccess = index;
          activeAnalysisIndex = index;
          currentInspection = data;
          renderInspection(data);
        }
      } catch (err) {
        item.status = "error";
        item.error = err.message;
      }

      renderAnalysisQueue();
    }

    if (firstSuccess >= 0) {
      selectAnalysisItem(firstSuccess);
      const failures = analysisItems.filter((item) => item.status === "error").length;
      setAnalysisState(
        analysisItems.length > 1
          ? `${analysisItems.length - failures} listos · ${failures} con error`
          : (currentInspection?.cached ? "Listo · caché" : "Listo"),
        failures ? "warn" : "ok",
      );
      if (failures && !silent) showMessage(`${failures} enlace(s) no pudieron analizarse. Los demás siguen disponibles.`, "error");
      return currentInspection;
    }

    resetInspection();
    setAnalysisState("No analizado", "error");
    const firstError = analysisItems.find((item) => item.error)?.error || "No se pudo analizar el contenido.";
    if (!silent) showMessage(firstError, "error");
    return null;
  } finally {
    inspectButton.disabled = false;
  }
}

function capabilityIds(data) {
  return new Set((data.capabilities || []).map((item) => item.id));
}

function renderInspection(data) {
  const ids = capabilityIds(data);

  $("title").textContent = data.title || "Contenido";
  $("uploader").textContent = [
    platformLabel(data.platform),
    data.uploader || data.host,
  ].filter(Boolean).join(" · ");

  $("playlist-info").textContent = data.is_playlist
    ? `Colección · ${data.entry_count ?? "varios"} elementos`
    : data.kind && data.kind !== "media"
      ? data.kind === "artwork"
        ? "Obra / imagen ampliable"
        : `Contenido: ${data.kind}`
      : "";

  if (data.thumbnail) {
    $("thumb").src = data.thumbnail;
    $("thumb").style.visibility = "visible";
  } else {
    $("thumb").removeAttribute("src");
    $("thumb").style.visibility = "hidden";
  }

  $("preview").classList.remove("hidden");

  const hasNativeMedia = ["video", "mp3", "audio"].some((id) => ids.has(id));
  $("media-actions").classList.toggle("hidden", !hasNativeMedia);

  document.querySelector('[data-mode="video"]').classList.toggle("hidden", !ids.has("video"));
  document.querySelector('[data-mode="mp3"]').classList.toggle("hidden", !ids.has("mp3"));
  document.querySelector('[data-mode="audio"]').classList.toggle("hidden", !ids.has("audio"));

  $("quality-control").classList.toggle(
    "hidden",
    !(ids.has("video") || ids.has("web_video")),
  );

  const showPlaylist = data.platform === "youtube" || ids.has("playlist");
  $("playlist-control").classList.toggle("hidden", !showPlaylist);
  $("music-control").classList.toggle("hidden", data.platform !== "youtube");

  const showTrim = ids.has("video") && !data.is_playlist;
  $("trim-panel").classList.toggle("hidden", !showTrim);
  $("trim-help").textContent = data.duration
    ? `Duración detectada: ${formatDuration(data.duration)}. Arrastra los extremos para elegir el fragmento.`
    : "Activa el recorte y arrastra los extremos para elegir el fragmento.";
  configureTrimTimeline(data);

  renderCapabilities(data);
  renderPageImages(data.images || []);
  renderCarousel(data.entries || []);
  renderSubtitleTracks(data.subtitles || data.subtitle_tracks || []);
  arrangePanels(data, ids);
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function arrangePanels(data, ids) {
  const preview = $("preview");
  const videoFirst = ids.has("video") || ids.has("web_video");
  const imageFirst = data.kind === "artwork" || ids.has("image_max") || ids.has("images");
  const order = videoFirst
    ? ["trim-panel", "media-actions", "capabilities-panel", "carousel-panel", "page-images-panel", "subtitle-panel"]
    : imageFirst
      ? ["capabilities-panel", "page-images-panel", "carousel-panel", "media-actions", "subtitle-panel", "trim-panel"]
      : ["capabilities-panel", "media-actions", "carousel-panel", "page-images-panel", "subtitle-panel", "trim-panel"];

  let cursor = preview;
  for (const id of order) {
    const node = $(id);
    if (!node) continue;
    cursor.insertAdjacentElement("afterend", node);
    cursor = node;
  }
}

function configureTrimTimeline(data) {
  trimDuration = Math.max(0, Number(data.duration || 0));
  const max = trimDuration || 100;

  const start = $("clip-start-range");
  const end = $("clip-end-range");
  start.max = String(max);
  end.max = String(max);
  start.value = "0";
  end.value = String(max);

  const filmstrip = $("trim-filmstrip");
  filmstrip.innerHTML = "";
  const fallback = data.thumbnail || "";

  for (let i = 0; i < 8; i += 1) {
    const frame = document.createElement("div");
    frame.className = "trim-frame placeholder";
    if (fallback) {
      frame.style.backgroundImage = `url("${fallback.replaceAll('"', '%22')}")`;
    }
    filmstrip.appendChild(frame);
  }

  updateTrimVisual();
}

function updateTrimVisual() {
  const start = $("clip-start-range");
  const end = $("clip-end-range");
  const max = Math.max(0.001, Number(end.max || start.max || trimDuration || 100));
  let startValue = Number(start.value || 0);
  let endValue = Number(end.value || max);

  if (startValue > endValue - 0.1) {
    if (document.activeElement === start) startValue = Math.max(0, endValue - 0.1);
    else endValue = Math.min(max, startValue + 0.1);
    start.value = String(startValue);
    end.value = String(endValue);
  }

  const left = Math.max(0, Math.min(100, (startValue / max) * 100));
  const right = Math.max(0, Math.min(100, (endValue / max) * 100));
  $("trim-range-shell").style.setProperty("--trim-left", `${left}%`);
  $("trim-range-shell").style.setProperty("--trim-right", `${100 - right}%`);

  $("clip-start-label").textContent = formatDuration(startValue);
  $("clip-end-label").textContent = formatDuration(endValue);
  $("clip-selection-label").textContent = `${formatDuration(Math.max(0, endValue - startValue))} seleccionados`;
}

async function loadTrimFrames() {
  if (!currentInspection || !trimDuration) return;

  let url;
  try {
    url = activeUrl();
  } catch {
    return;
  }

  if (!url || trimFramesLoadedFor === url) return;
  trimFramesLoadedFor = url;

  try {
    const result = await api("/api/preview/frames", {
      method: "POST",
      body: JSON.stringify({ url, playlist: false }),
    });

    if (!result.frames?.length || trimFramesLoadedFor !== url) return;

    const filmstrip = $("trim-filmstrip");
    filmstrip.innerHTML = result.frames.map((frame) => `
      <div
        class="trim-frame"
        style="background-image:url('${escapeHtml(frame.data_url)}')"
        title="${escapeHtml(formatDuration(frame.time))}"
      ></div>
    `).join("");
  } catch {
    // The static thumbnail placeholders remain; trimming still works.
  }
}

function clipPayload() {
  if (!$("clip-enabled").checked) {
    return { clip_start: null, clip_end: null, precise_clip: false };
  }

  const start = Number($("clip-start-range").value || 0);
  const end = Number($("clip-end-range").value || trimDuration || 0);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("Selecciona un fragmento válido en la línea de tiempo.");
  }

  return {
    clip_start: start,
    clip_end: end,
    precise_clip: $("precise-clip").checked,
  };
}

function renderCapabilities(data) {
  const panel = $("capabilities-panel");
  const box = $("capability-buttons");
  const notes = $("analysis-notes");
  const generic = (data.capabilities || []).filter((cap) =>
    ["web_video", "web_audio", "images", "image_download", "image_max", "dezoom", "browser_capture"].includes(cap.id)
  );

  const labels = {
    web_video: "Descargar video",
    web_audio: "Solo audio",
    images: "Ver imágenes encontradas",
    image_download: "Descargar imagen",
    image_max: "Original / máxima resolución",
    dezoom: "Reconstruir mosaicos",
    browser_capture: "Abrir Douyin y capturar desde Firefox",
  };

  if (!generic.length && !(data.capabilities || []).length) {
    panel.classList.remove("hidden");
    box.innerHTML = '<span class="capability-empty">No detecté una descarga directa en esta página.</span>';
  } else if (generic.length) {
    panel.classList.remove("hidden");
    box.innerHTML = generic.map((cap, index) => `
      <button
        class="${index === 0 ? "primary" : "secondary"}"
        data-cap-action="${escapeHtml(cap.id)}"
        data-source-url="${escapeHtml(cap.source_url || "")}"
        data-needs-install="${cap.needs_install ? "1" : "0"}"
        data-strategy="${escapeHtml(cap.strategy || "")}"
      >
        ${escapeHtml(labels[cap.id] || cap.label || cap.id)}
        ${cap.needs_install
          ? '<small>requiere instalar motor</small>'
          : cap.id === "image_max"
            ? (cap.strategy === "dezoom"
              ? '<small>Dezoomify · visor por mosaicos</small>'
              : '<small>motor nativo de TikSave</small>')
            : ""}
      </button>
    `).join("");
  } else {
    panel.classList.add("hidden");
    box.innerHTML = "";
  }

  if (data.notes?.length) {
    notes.innerHTML = data.notes.map((note) => `<div>${escapeHtml(note)}</div>`).join("");
    notes.classList.remove("hidden");
    panel.classList.remove("hidden");
  } else {
    notes.classList.add("hidden");
    notes.innerHTML = "";
  }
}

function renderPageImages(images) {
  const panel = $("page-images-panel");
  const grid = $("page-images-grid");

  if (!images.length) {
    panel.classList.add("hidden");
    grid.innerHTML = "";
    return;
  }

  $("page-images-title").textContent = `${images.length} imagen${images.length === 1 ? "" : "es"} encontrada${images.length === 1 ? "" : "s"}`;

  grid.innerHTML = images.map((item, index) => `
    <label class="media-item">
      <input type="checkbox" data-page-image-index="${index}" checked>
      <div class="media-thumb">
        <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.alt || `Imagen ${index + 1}`)}" loading="lazy">
        <span class="media-index">${index + 1}</span>
      </div>
      <span class="media-caption">${escapeHtml(item.source || shortUrl(item.url))}</span>
    </label>
  `).join("");

  panel.classList.remove("hidden");
}

function selectedPageImages() {
  if (!currentInspection?.images?.length) return [];
  return [...document.querySelectorAll("[data-page-image-index]:checked")]
    .map((input) => currentInspection.images[Number(input.dataset.pageImageIndex)])
    .filter(Boolean);
}

function renderCarousel(entries) {
  const panel = $("carousel-panel");
  const grid = $("carousel-grid");

  if (entries.length <= 1) {
    panel.classList.add("hidden");
    grid.innerHTML = "";
    return;
  }

  $("carousel-title").textContent = `Esta publicación contiene ${entries.length} elementos`;
  grid.innerHTML = entries.map((entry) => `
    <label class="media-item">
      <input type="checkbox" data-carousel-index="${entry.index}" checked>
      <div class="media-thumb">
        ${entry.thumbnail
          ? `<img src="${escapeHtml(entry.thumbnail)}" alt="Elemento ${entry.index}" loading="lazy">`
          : `<div class="thumb-placeholder">${entry.index}</div>`}
        <span class="media-index">${entry.index}</span>
      </div>
      <span class="media-caption">${escapeHtml(entry.title || `Elemento ${entry.index}`)}</span>
    </label>
  `).join("");

  panel.classList.remove("hidden");
}

function selectedCarouselItems() {
  if (!currentInspection?.entries?.length || currentInspection.entries.length <= 1) {
    return null;
  }

  return [...document.querySelectorAll("[data-carousel-index]:checked")]
    .map((input) => Number(input.dataset.carouselIndex))
    .filter((value) => Number.isInteger(value) && value > 0);
}

$("select-all-items").addEventListener("click", () => {
  document.querySelectorAll("[data-carousel-index]").forEach((input) => {
    input.checked = true;
  });
});

$("select-no-items").addEventListener("click", () => {
  document.querySelectorAll("[data-carousel-index]").forEach((input) => {
    input.checked = false;
  });
});

function renderSubtitleTracks(tracks) {
  const panel = $("subtitle-panel");
  const box = $("subtitle-tracks");

  if (!tracks.length) {
    panel.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  box.innerHTML = tracks.map((track, index) => `
    <label class="subtitle-track" data-subtitle-filter="${escapeHtml(
      `${track.code} ${track.name} ${track.automatic ? "automatico auto" : "manual"}`.toLowerCase()
    )}">
      <input type="checkbox" data-subtitle-code="${escapeHtml(track.code)}" ${index === 0 ? "checked" : ""}>
      <span>
        <strong>${escapeHtml(track.name || track.code)}</strong>
        <small>${escapeHtml(track.code)} · ${track.automatic ? "generado automáticamente" : "incluido por el autor"}${track.formats?.length ? ` · ${escapeHtml(track.formats.join(", "))}` : ""}</small>
      </span>
    </label>
  `).join("");

  panel.classList.remove("hidden");
}

$("subtitle-search").addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll(".subtitle-track").forEach((item) => {
    item.classList.toggle(
      "hidden",
      Boolean(query) && !item.dataset.subtitleFilter.includes(query),
    );
  });
});

function selectedSubtitleLanguages() {
  return [...document.querySelectorAll("[data-subtitle-code]:checked")]
    .map((input) => input.dataset.subtitleCode)
    .filter(Boolean);
}

$("inspect").addEventListener("click", () => inspectFirst());

$("select-all-page-images").addEventListener("click", () => {
  document.querySelectorAll("[data-page-image-index]").forEach((input) => {
    input.checked = true;
  });
});

$("select-no-page-images").addEventListener("click", () => {
  document.querySelectorAll("[data-page-image-index]").forEach((input) => {
    input.checked = false;
  });
});

$("download-page-images").addEventListener("click", async () => {
  armCompletionFeedback();
  const selected = selectedPageImages();
  if (!selected.length) {
    showMessage("Selecciona al menos una imagen.", "error");
    return;
  }

  try {
    showMessage(`Descargando ${selected.length} imagen${selected.length === 1 ? "" : "es"}…`);
    const urls = getUrls();
    const result = await api("/api/images/download", {
      method: "POST",
      body: JSON.stringify({
        urls: selected.map((item) => item.url),
        page_url: urls.length === 1 ? urls[0] : null,
      }),
    });
    showMessage(`${result.count} imagen${result.count === 1 ? "" : "es"} guardada${result.count === 1 ? "" : "s"} en TikSave/Images.`, "ok");
    notifyDirectCompletion(
      `${result.count} imagen${result.count === 1 ? "" : "es"} guardada${result.count === 1 ? "" : "s"}`,
      result.files?.[0] || "TikSave/Images",
    );
  } catch (err) {
    showMessage(err.message, "error");
  }
});

$("capability-buttons").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cap-action]");
  if (!button || !currentInspection) return;

  const action = button.dataset.capAction;
  const sourceUrl = button.dataset.sourceUrl || "";
  if (!["images", "browser_capture"].includes(action)) armCompletionFeedback();
  let url;

  try {
    url = activeUrl();
  } catch (err) {
    showMessage(err.message, "error");
    return;
  }

  const wantsViewer = action === "dezoom" || action === "image_max";
  const viewerWindow = wantsViewer ? window.open("about:blank", "_blank") : null;
  if (viewerWindow) {
    viewerWindow.document.title = "TikSave · Preparando visor";
    viewerWindow.document.body.style.cssText = "margin:0;background:#090b0e;color:#fff;font:14px system-ui;display:grid;place-items:center;height:100vh";
    viewerWindow.document.body.textContent = "TikSave está preparando la máxima resolución…";
  }

  try {
    if (action === "browser_capture") {
      const target = sourceUrl || url;
      window.open(target, "_blank", "noopener");
      showMessage(
        "Abrí Douyin en Firefox. Deja que el video cargue y usa TikSave en esa pestaña; ahora la extensión prioriza la fuente que realmente está reproduciendo el navegador.",
        "ok",
      );
      return;
    }

    if (action === "images") {
      $("page-images-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }

    if (action === "image_download") {
      const result = await api("/api/images/download", {
        method: "POST",
        body: JSON.stringify({
          urls: [sourceUrl || currentInspection.final_url || url],
          page_url: url,
        }),
      });
      showMessage(`Imagen guardada: ${result.files?.[0] || "TikSave/Images"}`, "ok");
      notifyDirectCompletion("Imagen guardada", result.files?.[0] || "TikSave/Images");
      return;
    }

    if (action === "image_max" && button.dataset.strategy !== "dezoom") {
      showMessage("TikSave está buscando la variante original…");

      const resolved = await api("/api/image/resolve", {
        method: "POST",
        body: JSON.stringify({
          url: sourceUrl || currentInspection.images?.[0]?.url || url,
          page_url: url,
        }),
      });

      const bestUrl = resolved.best?.final_url || resolved.best?.url;
      if (viewerWindow && bestUrl) {
        viewerWindow.location.replace(bestUrl);
      }

      const result = await api("/api/image/download", {
        method: "POST",
        body: JSON.stringify({
          url: sourceUrl || currentInspection.images?.[0]?.url || url,
          page_url: url,
        }),
      });
      const resolution = result.resolution?.filter(Boolean).length === 2
        ? ` · ${result.resolution[0]}×${result.resolution[1]}`
        : "";
      showMessage(`Imagen guardada: ${result.path}${resolution}`, "ok");
      notifyDirectCompletion(`Imagen original guardada${resolution}`, result.path);
      return;
    }

    if (action === "image_max" || action === "dezoom") {
      if (button.dataset.needsInstall === "1") {
        showMessage("Instalando el motor de mosaicos la primera vez…");
        await api("/api/dezoom/install", { method: "POST", body: "{}" });
        button.dataset.needsInstall = "0";
      }

      const data = await api("/api/dezoom/download", {
        method: "POST",
        body: JSON.stringify({
          source_url: sourceUrl || currentInspection.zoom_sources?.[0]?.url || currentInspection.final_url || url,
          page_url: url,
          output_format: "jpg",
        }),
      });

      jobsPanel.classList.remove("hidden");
      createJobCard(data.id, url, 1, 1);
      startPolling(data.id);

      const viewerUrl = `/viewer/${encodeURIComponent(data.id)}`;
      if (viewerWindow) viewerWindow.location.replace(viewerUrl);
      else window.open(viewerUrl, "_blank", "noopener");

      showMessage("Reconstrucción iniciada. El visor mostrará el avance y cargará la imagen al terminar.", "ok");
      return;
    }

    if (viewerWindow) viewerWindow.close();

    if (action === "web_video" || action === "web_audio") {
      const clip = action === "web_video" ? clipPayload() : {};
      const data = await api("/api/browser-media", {
        method: "POST",
        body: JSON.stringify({
          page_url: url,
          media_url: sourceUrl || null,
          mode: action === "web_video" ? "video" : "audio",
          quality: $("quality").value,
          ...clip,
        }),
      });

      jobsPanel.classList.remove("hidden");
      createJobCard(data.id, url, 1, 1);
      startPolling(data.id);
      showMessage("Descarga añadida a trabajos.", "ok");
    }
  } catch (err) {
    if (viewerWindow && !viewerWindow.closed) viewerWindow.close();
    showMessage(err.message, "error");
  }
});

urlsInput.addEventListener("input", () => {
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(() => {
    let urls;
    try {
      urls = getUrls();
    } catch {
      analysisItems = [];
      $("analysis-queue").classList.add("hidden");
      resetInspection();
      setAnalysisState("Listo");
      return;
    }

    if (urls.length === 1) {
      inspectFirst({ silent: true });
    } else {
      analysisItems = urls.map((url) => ({ url, status: "pending", data: null, error: null }));
      activeAnalysisIndex = 0;
      resetInspection();
      renderAnalysisQueue();
      setAnalysisState(`${urls.length} enlaces · pulsa Analizar`);
    }
  }, 550);
});

$("playlist").addEventListener("change", () => {
  try {
    if (getUrls().length === 1) inspectFirst({ silent: true });
  } catch {
    // Nothing to inspect yet.
  }
});

async function startDownloads(mode) {
  armCompletionFeedback();
  clearMessage();

  let url;
  try {
    url = activeUrl();
  } catch (err) {
    showMessage(err.message, "error");
    return;
  }

  const quality = $("quality").value;
  const playlist = $("playlist").checked;
  const musicMetadata = mode === "mp3" && $("music-metadata").checked;
  let selectedItems = null;

  if (currentInspection?.entries?.length > 1) {
    selectedItems = selectedCarouselItems();
    if (!selectedItems?.length) {
      showMessage("Selecciona al menos un elemento de la publicación.", "error");
      return;
    }
  }

  try {
    const clip = mode === "video" ? clipPayload() : {};
    const data = await api("/api/download", {
      method: "POST",
      body: JSON.stringify({
        url,
        mode,
        quality,
        playlist,
        selected_items: selectedItems,
        music_metadata: musicMetadata,
        ...clip,
      }),
    });

    jobsPanel.classList.remove("hidden");
    createJobCard(data.id, url, 1, 1);
    startPolling(data.id);
    showMessage("Trabajo añadido. Puedes seleccionar otro enlace y seguir agregando descargas.", "ok");
  } catch (err) {
    createRejectedCard(url, err.message, 1, 1);
    jobsPanel.classList.remove("hidden");
    showMessage(err.message, "error");
  }
}

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => startDownloads(button.dataset.mode));
});

$("download-subtitles").addEventListener("click", async () => {
  armCompletionFeedback();
  clearMessage();

  let urls;
  try {
    urls = getUrls();
  } catch (err) {
    showMessage(err.message, "error");
    return;
  }

  const url = activeAnalysisItem()?.url || urls[0];

  if (!currentInspection) {
    await inspectFirst();
    if (!currentInspection) return;
  }

  const languages = selectedSubtitleLanguages();
  if (!languages.length) {
    showMessage("Selecciona al menos un idioma de subtítulos.", "error");
    return;
  }

  let selectedItems = null;
  if (currentInspection.entries?.length > 1) {
    selectedItems = selectedCarouselItems();
    if (!selectedItems?.length) {
      showMessage("Selecciona al menos un elemento de la colección.", "error");
      return;
    }
  }

  jobsPanel.classList.remove("hidden");

  try {
    const data = await api("/api/download", {
      method: "POST",
      body: JSON.stringify({
        url,
        mode: "subtitles",
        playlist: $("playlist").checked,
        selected_items: selectedItems,
        subtitle_format: $("subtitle-format").value,
        subtitle_languages: languages,
      }),
    });

    createJobCard(data.id, url, 1, 1);
    startPolling(data.id);
    showMessage("Descarga de subtítulos iniciada.", "ok");
  } catch (err) {
    showMessage(err.message, "error");
  }
});

function folderIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l1.7 2H20.5v9H3.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3.5 8.5h17" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
}

function updateJobsCount() {
  const activeCards = [...jobsBox.querySelectorAll(".job-card")];
  $("jobs-count").textContent = `${activeCards.length} activo${activeCards.length === 1 ? "" : "s"}`;
  jobsPanel.classList.toggle("hidden", activeCards.length === 0);

  const historyCards = [...historyBox.querySelectorAll(".job-card")];
  $("history-count").textContent = String(historyCards.length);
  historyPanel.classList.toggle("hidden", historyCards.length === 0);
}

function createJobCard(jobId, url, position = 1, total = 1) {
  if (document.getElementById(`job-${jobId}`)) return;

  const composer = document.querySelector(".composer");
  const analysisQueue = $("analysis-queue");
  const anchor = analysisQueue && !analysisQueue.classList.contains("hidden")
    ? analysisQueue
    : composer;
  if (anchor && anchor.nextElementSibling !== jobsPanel) {
    anchor.insertAdjacentElement("afterend", jobsPanel);
  }

  const card = document.createElement("article");
  card.className = "job-card";
  card.id = `job-${jobId}`;
  card.dataset.jobId = jobId;

  card.innerHTML = `
    <div class="job-head">
      <div class="job-title">
        <strong>${total > 1 ? `${position}/${total} · ` : ""}${escapeHtml(shortUrl(url))}</strong>
        <span data-role="status">En cola…</span>
      </div>
      <span data-role="percent">0%</span>
    </div>
    <div class="track"><div data-role="bar" class="bar"></div></div>
    <div data-role="details" class="details"></div>
    <div class="job-actions">
      <button class="icon-button" data-job-folder="${jobId}" title="Abrir carpeta de descargas" aria-label="Abrir carpeta de descargas" hidden>${folderIcon()}</button>
      <button class="ghost small-button" data-job-view="${jobId}" hidden>Ver progreso</button>
      <button class="ghost small-button danger-button" data-job-cancel="${jobId}">Cancelar</button>
    </div>
  `;

  jobsBox.prepend(card);
  jobsPanel.classList.remove("hidden");
  updateJobsCount();
}

function createRejectedCard(url, error, position = 1, total = 1) {
  const card = document.createElement("article");
  card.className = "job-card failed";
  card.innerHTML = `
    <div class="job-head">
      <div class="job-title">
        <strong>${total > 1 ? `${position}/${total} · ` : ""}${escapeHtml(shortUrl(url))}</strong>
        <span>Falló antes de iniciar</span>
      </div>
      <span>—</span>
    </div>
    <div class="details error-text">${escapeHtml(error)}</div>
  `;
  historyBox.prepend(card);
  updateJobsCount();
}

function startPolling(jobId) {
  const previous = jobPollers.get(jobId);
  if (previous) clearInterval(previous);
  const timer = setInterval(() => updateJob(jobId, true), 650);
  jobPollers.set(jobId, timer);
  updateJob(jobId, true);
}

function moveJobToHistory(card) {
  if (!card || card.parentElement === historyBox) return;
  historyBox.prepend(card);
  updateJobsCount();
}

async function updateJob(jobId, shouldNotify = true) {
  const card = document.getElementById(`job-${jobId}`);
  if (!card) return;

  const statusEl = card.querySelector('[data-role="status"]');
  const percentEl = card.querySelector('[data-role="percent"]');
  const barEl = card.querySelector('[data-role="bar"]');
  const detailsEl = card.querySelector('[data-role="details"]');
  const cancelButton = card.querySelector("[data-job-cancel]");
  const viewButton = card.querySelector("[data-job-view]");
  const folderButton = card.querySelector("[data-job-folder]");

  try {
    const data = await api(`/api/jobs/${jobId}`);
    const pct = Number(data.progress || 0);

    if (data.progress_mode === "indeterminate") {
      barEl.classList.add("indeterminate");
      barEl.style.width = "";
      percentEl.textContent = "Trabajando";
    } else {
      barEl.classList.remove("indeterminate");
      barEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      percentEl.textContent = `${pct.toFixed(pct % 1 ? 1 : 0)}%`;
    }

    const labels = {
      queued: "En cola…",
      starting: "Preparando…",
      downloading: "Descargando…",
      processing: "Procesando…",
      cancelling: "Cancelando…",
      cancelled: "Cancelado",
      done: "Terminado",
      error: "Falló",
    };

    let status = data.phase || labels[data.status] || data.status;
    if (data.total_items && data.current_index) status += ` · ${data.current_index}/${data.total_items}`;
    statusEl.textContent = status;

    detailsEl.textContent = [
      platformLabel(data.platform),
      data.quality !== "best" && data.mode === "video" ? `${data.quality}p máx.` : null,
      data.title,
      data.metadata_note,
      data.speed,
      data.eta && `ETA ${data.eta}`,
      data.status === "done" ? data.filename : null,
      data.error,
    ].filter(Boolean).join(" · ");

    const terminal = ["done", "error", "cancelled"].includes(data.status);
    cancelButton.hidden = terminal || !data.can_cancel;
    folderButton.hidden = data.status !== "done";

    if (data.platform === "dezoom") {
      viewButton.hidden = false;
      viewButton.textContent = data.status === "done" ? "Abrir imagen" : "Ver progreso";
    }

    if (terminal) {
      const timer = jobPollers.get(jobId);
      if (timer) clearInterval(timer);
      jobPollers.delete(jobId);

      if (data.status === "done") card.classList.add("done");
      if (data.status === "error") card.classList.add("failed");
      if (data.status === "cancelled") card.classList.add("cancelled");
      moveJobToHistory(card);
      if (shouldNotify && (data.status === "done" || data.status === "error")) {
        notifyCompletion(data);
      }
    }

    updateJobsCount();
  } catch (err) {
    const timer = jobPollers.get(jobId);
    if (timer) clearInterval(timer);
    jobPollers.delete(jobId);
    card.classList.add("failed");
    statusEl.textContent = "Falló";
    detailsEl.textContent = err.message;
    moveJobToHistory(card);
  }
}

async function handleJobListClick(event) {
  const cancel = event.target.closest("[data-job-cancel]");
  if (cancel) {
    cancel.disabled = true;
    try {
      await api(`/api/jobs/${encodeURIComponent(cancel.dataset.jobCancel)}/cancel`, { method: "POST", body: "{}" });
      await updateJob(cancel.dataset.jobCancel);
    } catch (err) {
      cancel.disabled = false;
      showMessage(err.message, "error");
    }
    return;
  }

  const view = event.target.closest("[data-job-view]");
  if (view) {
    window.open(`/viewer/${encodeURIComponent(view.dataset.jobView)}`, "_blank", "noopener");
    return;
  }

  const folder = event.target.closest("[data-job-folder]");
  if (folder) {
    try {
      await api("/api/open-folder", { method: "POST", body: "{}" });
    } catch (err) {
      showMessage(err.message, "error");
    }
  }
}

jobsBox.addEventListener("click", handleJobListClick);
historyBox.addEventListener("click", handleJobListClick);

async function restoreJobs() {
  try {
    const result = await api("/api/jobs?limit=20");
    const jobs = result.jobs || [];
    for (const job of jobs.reverse()) {
      createJobCard(job.id, job.url || "Trabajo", 1, 1);
      await updateJob(job.id, false);
      if (!["done", "error", "cancelled"].includes(job.status)) startPolling(job.id);
    }
  } catch {
    // No previous in-memory jobs.
  }
}

$("paste").addEventListener("click", async () => {
  urlsInput.focus();

  try {
    if (!navigator.clipboard?.readText) throw new Error("clipboard unavailable");
    const text = (await navigator.clipboard.readText()).trim();

    if (!text) {
      showMessage("El portapapeles está vacío.");
      return;
    }

    urlsInput.value = text;
    clearMessage();
    if (getUrls().length === 1) await inspectFirst({ silent: true });
  } catch {
    showMessage("Firefox protege el portapapeles. El campo ya está activo: presiona Ctrl+V para pegar.");
  }
});

$("clear").addEventListener("click", () => {
  urlsInput.value = "";
  analysisItems = [];
  activeAnalysisIndex = 0;
  $("analysis-queue").classList.add("hidden");
  resetInspection();

  clearMessage();
  setAnalysisState("Listo");
  urlsInput.focus();
});

$("open-folder").addEventListener("click", async () => {
  clearMessage();
  try {
    await api("/api/open-folder", { method: "POST", body: "{}" });
  } catch (err) {
    showMessage(err.message, "error");
  }
});

$("open-log").addEventListener("click", async () => {
  try {
    const result = await api("/api/diagnostics/open-log", { method: "POST", body: "{}" });
    showMessage(`Log abierto: ${result.path}`, "ok");
  } catch (err) {
    showMessage(err.message, "error");
  }
});



$("clip-enabled").addEventListener("change", () => {
  const enabled = $("clip-enabled").checked;
  $("trim-fields").classList.toggle("hidden", !enabled);
  if (enabled) loadTrimFrames();
});

$("clip-start-range").addEventListener("input", updateTrimVisual);
$("clip-end-range").addEventListener("input", updateTrimVisual);

async function loadSystemStatus() {
  try {
    const health = await api("/api/health");

    setStatusPill("status-app", `TikSave ${health.version || ""}`.trim(), "ok");
    setStatusPill("status-image", "Imagen nativa", health.native_image?.installed ? "ok" : "bad");
    setStatusPill(
      "status-dezoom",
      health.dezoomify?.installed ? "Dezoomify listo" : "Dezoomify pendiente",
      health.dezoomify?.installed ? "ok" : "warn",
    );
    setStatusPill(
      "status-ffmpeg",
      health.ffmpeg?.installed ? "FFmpeg listo" : "FFmpeg pendiente",
      health.ffmpeg?.installed ? "ok" : "warn",
    );
  } catch (err) {
    setStatusPill("status-app", "TikSave sin conexión", "bad");
    setStatusPill("status-image", "Imagen nativa", "pending");
    setStatusPill("status-dezoom", "Dezoomify", "pending");
    setStatusPill("status-ffmpeg", "FFmpeg", "pending");
  }
}

async function prefillFromSharedUrl() {
  const params = new URLSearchParams(window.location.search);
  const sharedUrl = params.get("url");
  if (!sharedUrl) return;

  urlsInput.value = sharedUrl;
  try {
    await inspectFirst({ silent: true });
  } catch {
    // The normal UI will show errors when the user requests an action.
  }

  history.replaceState({}, "", window.location.pathname);
}

loadSystemStatus();
restoreJobs();
prefillFromSharedUrl();
