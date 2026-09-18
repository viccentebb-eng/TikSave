const $ = (id) => document.getElementById(id);

let currentTab = null;
let currentUrl = "";
let activeJobId = null;
let pollTimer = null;
let browserMedia = null;

function supportedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com") ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host === "instagram.com" ||
      host.endsWith(".instagram.com") ||
      host === "facebook.com" ||
      host.endsWith(".facebook.com") ||
      host === "fb.watch"
    );
  } catch {
    return false;
  }
}

function isYouTube(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function isYouTubeChannel(url) {
  try {
    const parsed = new URL(url);
    if (!isYouTube(url)) return false;
    const path = parsed.pathname;
    return (
      /^\/@[^/]+(?:\/(?:videos|shorts|streams|releases))?\/?$/.test(path) ||
      /^\/(?:channel|c|user)\/[^/]+(?:\/(?:videos|shorts|streams|releases))?\/?$/.test(path)
    );
  } catch {
    return false;
  }
}

function setAppStatus(text, type = "") {
  const node = $("app-status");
  node.className = type;
  node.innerHTML = `<i></i> ${text}`;
}

function say(text, type = "") {
  $("message").textContent = text;
  $("message").className = `message ${type}`.trim();
}

async function send(message) {
  return browser.runtime.sendMessage(message);
}

async function getCurrentTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function detectPlayingMedia(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const videos = [...document.querySelectorAll("video")];
        if (!videos.length) return { found: false };

        const ranked = videos.map((video) => {
          const rect = video.getBoundingClientRect();
          const area = Math.max(0, rect.width) * Math.max(0, rect.height);
          const playing = !video.paused && !video.ended && video.readyState >= 2;
          return { video, score: area + (playing ? 100000000 : 0) };
        }).sort((a, b) => b.score - a.score);

        const video = ranked[0].video;
        let protectedMedia = false;
        try {
          protectedMedia = Boolean(video.mediaKeys);
        } catch {}

        const source = video.currentSrc || video.src || "";
        const direct = /^https?:\/\//i.test(source) ? source : null;

        return {
          found: true,
          playing: !video.paused && !video.ended,
          protected: protectedMedia,
          source: direct,
          sourceKind: source.startsWith("blob:") ? "blob" : direct ? "http" : "unknown",
          title: document.title || "Video de la pestaña",
          duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
          currentTime: Number.isFinite(video.currentTime) ? Math.round(video.currentTime) : null,
        };
      },
    });

    return results?.[0]?.result || { found: false };
  } catch {
    return { found: false };
  }
}

function configureContext() {
  const supported = supportedUrl(currentUrl);
  const youtube = isYouTube(currentUrl);
  const channel = isYouTubeChannel(currentUrl);

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.disabled = !supported;
  });

  $("metadata-row").classList.toggle("hidden", !youtube);
  $("collection-row").classList.toggle("hidden", !supported);

  if (channel) {
    $("collection").checked = true;
    $("collection-title").textContent = "Descargar canal completo";
    $("collection-help").textContent = "Incluye los videos disponibles del canal o de esta pestaña del canal.";
    $("source-title").textContent = "Canal de YouTube";
  } else {
    $("collection-title").textContent = "Descargar lista completa";
    $("collection-help").textContent = "Úsalo para playlists o colecciones.";
    $("source-title").textContent = supported ? "Contenido compatible" : "Pestaña actual";
  }
}

function renderBrowserMedia(media) {
  browserMedia = media;
  const card = $("browser-media");

  if (!media?.found) {
    card.classList.add("hidden");
    return;
  }

  card.classList.remove("hidden");

  if (media.protected) {
    $("browser-media-info").textContent = "El reproductor usa contenido protegido (DRM); TikSave no lo captura.";
    $("download-browser-media").disabled = true;
    return;
  }

  $("download-browser-media").disabled = false;
  const parts = [
    media.playing ? "Reproduciéndose ahora" : "Video detectado",
    media.duration ? `${Math.floor(media.duration / 60)}:${String(media.duration % 60).padStart(2, "0")}` : null,
    media.sourceKind === "blob" ? "se intentará desde la página" : null,
  ].filter(Boolean);

  $("browser-media-info").textContent = parts.join(" · ");
}

function statusLabel(status) {
  return {
    queued: "En cola",
    starting: "Preparando",
    downloading: "Descargando",
    processing: "Procesando archivo",
    done: "Terminado",
    error: "Error",
  }[status] || status;
}

function renderJob(job) {
  if (!job) return;

  activeJobId = job.id;
  $("progress-card").classList.remove("hidden");

  const pct = Number(job.progress || 0);
  $("progress-percent").textContent = `${pct.toFixed(pct % 1 ? 1 : 0)}%`;
  $("progress-bar").style.width = `${Math.min(100, Math.max(0, pct))}%`;
  $("progress-title").textContent = job.title || "Descarga de TikSave";
  $("progress-status").textContent = statusLabel(job.status);
  $("progress-details").textContent = [
    job.speed,
    job.eta && `ETA ${job.eta}`,
    job.metadata_note,
    job.filename,
    job.error,
  ].filter(Boolean).join(" · ");

  const finished = job.status === "done";
  $("open-folder").classList.toggle("hidden", !finished);

  if (finished) {
    say("Archivo listo.", "ok");
    stopPolling();
  } else if (job.status === "error") {
    say(job.error || "La descarga terminó con un error.", "error");
    stopPolling();
  }
}

async function refreshJob() {
  if (!activeJobId) return;
  try {
    const job = await send({ type: "getJob", jobId: activeJobId });
    renderJob(job);
  } catch (error) {
    say(error?.message || "No se pudo consultar el progreso.", "error");
    stopPolling();
  }
}

function startPolling(jobId) {
  activeJobId = jobId;
  stopPolling(false);
  pollTimer = setInterval(refreshJob, 700);
  refreshJob();
}

function stopPolling(clearId = false) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (clearId) activeJobId = null;
}

async function startRegularDownload(mode) {
  say("Iniciando descarga…");

  try {
    const job = await send({
      type: "startDownload",
      payload: {
        url: currentUrl,
        mode,
        quality: $("quality").value,
        playlist: $("collection").checked,
        music_metadata: mode === "mp3" && !$("metadata-row").classList.contains("hidden") && $("metadata").checked,
      },
    });

    renderJob(job);
    startPolling(job.id);
  } catch (error) {
    say(error?.message || "No se pudo iniciar la descarga.", "error");
  }
}

async function startBrowserMedia() {
  if (!browserMedia?.found || browserMedia.protected) return;

  say("Preparando el video de esta pestaña…");

  try {
    const job = await send({
      type: "startBrowserMedia",
      payload: {
        page_url: currentUrl,
        media_url: browserMedia.source || null,
        mode: "video",
        quality: $("quality").value,
      },
    });

    renderJob(job);
    startPolling(job.id);
  } catch (error) {
    say(error?.message || "No se pudo extraer el video de esta pestaña.", "error");
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "jobUpdate" && message.job?.id === activeJobId) {
    renderJob(message.job);
  }
});

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => startRegularDownload(button.dataset.mode));
});

$("download-browser-media").addEventListener("click", startBrowserMedia);

$("open-folder").addEventListener("click", async () => {
  try {
    await send({ type: "openFolder" });
  } catch (error) {
    say(error?.message || "No se pudo abrir la carpeta.", "error");
  }
});

$("open").addEventListener("click", () => {
  browser.tabs.create({
    url: `http://127.0.0.1:8173/?url=${encodeURIComponent(currentUrl)}`,
  });
});

async function init() {
  currentTab = await getCurrentTab();
  currentUrl = currentTab?.url || "";

  $("url").textContent = currentUrl || "No se pudo leer la pestaña actual.";
  configureContext();

  try {
    await send({ type: "health" });
    setAppStatus("TikSave está abierto", "ready");
  } catch {
    setAppStatus("Abre TikSave en tu computadora", "error");
  }

  if (!supportedUrl(currentUrl) && currentTab?.id) {
    renderBrowserMedia(await detectPlayingMedia(currentTab.id));
  } else {
    $("browser-media").classList.add("hidden");
  }

  try {
    const active = await send({ type: "getActiveJobs" });
    if (active?.length) {
      renderJob(active[0]);
      startPolling(active[0].id);
    }
  } catch {
    // No active local service is fine here.
  }
}

init();
