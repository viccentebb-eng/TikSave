const $ = (id) => document.getElementById(id);

let currentTab = null;
let currentUrl = "";
let activeJobId = null;
let pollTimer = null;
let browserMedia = null;
let popupGuardEnabled = false;

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

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Number(text);
  }

  const parts = text.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === "")) {
    throw new Error("Usa tiempos como 1:25 o 01:02:15.");
  }

  const numbers = parts.map(Number);
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("El tiempo del fragmento no es válido.");
  }

  if (parts.length === 2) {
    return numbers[0] * 60 + numbers[1];
  }

  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

function getClipPayload() {
  if (!$("clip-enabled").checked) {
    return {
      clip_start: null,
      clip_end: null,
      precise_clip: false,
    };
  }

  const start = parseTime($("clip-start").value) ?? 0;
  const end = parseTime($("clip-end").value);

  if (end !== null && end <= start) {
    throw new Error("El final del fragmento debe ser posterior al inicio.");
  }

  return {
    clip_start: start,
    clip_end: end,
    precise_clip: $("precise-clip").checked,
  };
}

async function detectPlayingMedia(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const resources = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => /^https?:\/\//i.test(name));

        const manifests = resources.filter((name) =>
          /(?:\.m3u8|\.mpd)(?:[?#]|$)/i.test(name),
        );

        const videos = [...document.querySelectorAll("video")];
        const ranked = videos
          .map((video) => {
            const rect = video.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            const playing = !video.paused && !video.ended && video.readyState >= 2;
            return {
              video,
              score: area + (playing ? 100000000 : 0),
            };
          })
          .sort((a, b) => b.score - a.score);

        const video = ranked[0]?.video || null;
        const areaScore = ranked[0]?.score || 0;

        let protectedMedia = false;
        try {
          protectedMedia = Boolean(video?.mediaKeys);
        } catch {}

        const currentSrc = video?.currentSrc || video?.src || "";
        const sourceElement =
          [...(video?.querySelectorAll("source[src]") || [])]
            .map((node) => node.src)
            .find((src) => /^https?:\/\//i.test(src)) || null;

        const direct = /^https?:\/\//i.test(currentSrc)
          ? currentSrc
          : sourceElement;

        const manifest =
          manifests.findLast?.((name) => /\.m3u8(?:[?#]|$)/i.test(name)) ||
          manifests[manifests.length - 1] ||
          null;

        const visibleIframes = [...document.querySelectorAll("iframe[src]")]
          .map((frame) => {
            const rect = frame.getBoundingClientRect();
            return {
              src: frame.src,
              area: Math.max(0, rect.width) * Math.max(0, rect.height),
            };
          })
          .filter((frame) => /^https?:\/\//i.test(frame.src))
          .sort((a, b) => b.area - a.area);

        const iframeUrl = visibleIframes[0]?.src || null;
        const source = direct || manifest || iframeUrl || null;

        return {
          found: Boolean(video || manifest || iframeUrl),
          playing: Boolean(video && !video.paused && !video.ended),
          protected: protectedMedia,
          source,
          sourceKind: direct
            ? "http"
            : manifest
              ? (/\.m3u8/i.test(manifest) ? "hls" : "dash")
              : currentSrc.startsWith("blob:")
                ? "blob"
                : iframeUrl
                  ? "iframe"
                  : "unknown",
          title: document.title || "Video de la pestaña",
          duration: video && Number.isFinite(video.duration)
            ? Math.round(video.duration)
            : null,
          currentTime: video && Number.isFinite(video.currentTime)
            ? video.currentTime
            : null,
          score:
            areaScore +
            (manifest ? 50000000 : 0) +
            (direct ? 30000000 : 0) +
            (iframeUrl ? Math.min(visibleIframes[0]?.area || 0, 10000000) : 0),
        };
      },
    });

    const candidates = results
      .map((item) => item.result)
      .filter((item) => item?.found)
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    return candidates[0] || { found: false };
  } catch {
    return { found: false };
  }
}

async function currentPlaybackTime() {
  if (!currentTab?.id) return null;
  const media = await detectPlayingMedia(currentTab.id);
  return Number.isFinite(media?.currentTime) ? media.currentTime : null;
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
    $("collection-help").textContent =
      "Incluye los videos disponibles del canal o de esta pestaña del canal.";
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
    $("browser-media-info").textContent =
      "El reproductor usa contenido protegido (DRM); TikSave no lo captura.";
    $("download-browser-media").disabled = true;
    return;
  }

  $("download-browser-media").disabled = false;

  const kind = {
    hls: "HLS detectado",
    dash: "DASH detectado",
    iframe: "reproductor incrustado",
    blob: "video blob; se intentará desde la página",
    http: "fuente directa",
  }[media.sourceKind];

  const parts = [
    media.playing ? "Reproduciéndose ahora" : "Video detectado",
    media.duration ? formatTime(media.duration) : null,
    kind,
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

  $("open-folder").classList.toggle("hidden", job.status !== "done");

  if (job.notification_error) {
    say(
      `El archivo terminó, pero Firefox no pudo crear la notificación: ${job.notification_error}`,
      "error",
    );
  } else if (job.status === "done") {
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
    renderJob(await send({ type: "getJob", jobId: activeJobId }));
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
    if ($("collection").checked && $("clip-enabled").checked) {
      throw new Error("El recorte por tiempo se usa con un solo video, no con una lista o canal.");
    }

    const clip = getClipPayload();

    const job = await send({
      type: "startDownload",
      payload: {
        url: currentUrl,
        mode,
        quality: $("quality").value,
        playlist: $("collection").checked,
        music_metadata:
          mode === "mp3" &&
          !$("metadata-row").classList.contains("hidden") &&
          $("metadata").checked,
        ...clip,
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
    const clip = getClipPayload();

    const job = await send({
      type: "startBrowserMedia",
      payload: {
        page_url: currentUrl,
        media_url: browserMedia.source || null,
        mode: "video",
        quality: $("quality").value,
        ...clip,
      },
    });

    renderJob(job);
    startPolling(job.id);
  } catch (error) {
    say(error?.message || "No se pudo extraer el video de esta pestaña.", "error");
  }
}

async function setPopupGuard(enabled) {
  if (!currentTab?.id) return false;

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      world: "MAIN",
      args: [enabled],
      func: (turnOn) => {
        const KEY = "__tiksavePopupGuard";

        if (!turnOn) {
          const state = window[KEY];
          if (state) {
            try {
              window.open = state.originalOpen;
              HTMLAnchorElement.prototype.click = state.originalAnchorClick;
            } catch {}
            delete window[KEY];
          }
          return false;
        }

        if (window[KEY]) return true;

        const originalOpen = window.open;
        const originalAnchorClick = HTMLAnchorElement.prototype.click;

        window.open = function () {
          return null;
        };

        HTMLAnchorElement.prototype.click = function (...args) {
          try {
            const href = this.href && new URL(this.href, location.href);
            if (
              href &&
              this.target === "_blank" &&
              href.origin !== location.origin
            ) {
              return;
            }
          } catch {}

          return originalAnchorClick.apply(this, args);
        };

        window[KEY] = {
          originalOpen,
          originalAnchorClick,
        };

        return true;
      },
    });

    return results.some((item) => item.result === enabled);
  } catch {
    return false;
  }
}

async function refreshPopupGuardState() {
  if (!currentTab?.id) return;

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      world: "MAIN",
      func: () => Boolean(window.__tiksavePopupGuard),
    });

    popupGuardEnabled = results.some((item) => item.result === true);
  } catch {
    popupGuardEnabled = false;
  }

  $("popup-guard").textContent = popupGuardEnabled ? "Desactivar" : "Activar";
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

$("clip-enabled").addEventListener("change", () => {
  $("clip-panel").classList.toggle("hidden", !$("clip-enabled").checked);

  if ($("clip-enabled").checked && $("collection").checked) {
    $("collection").checked = false;
    say("Desactivé la lista completa porque el recorte se aplica a un solo video.");
  }
});

$("collection").addEventListener("change", () => {
  if ($("collection").checked && $("clip-enabled").checked) {
    $("clip-enabled").checked = false;
    $("clip-panel").classList.add("hidden");
    say("Desactivé el recorte porque elegiste una lista o canal completo.");
  }
});

$("mark-start").addEventListener("click", async () => {
  const value = await currentPlaybackTime();
  if (value === null) {
    say("No pude leer el tiempo actual del reproductor.", "error");
    return;
  }
  $("clip-start").value = formatTime(value);
  say(`Inicio marcado en ${formatTime(value)}.`, "ok");
});

$("mark-end").addEventListener("click", async () => {
  const value = await currentPlaybackTime();
  if (value === null) {
    say("No pude leer el tiempo actual del reproductor.", "error");
    return;
  }
  $("clip-end").value = formatTime(value);
  say(`Final marcado en ${formatTime(value)}.`, "ok");
});

$("popup-guard").addEventListener("click", async () => {
  const target = !popupGuardEnabled;
  const changed = await setPopupGuard(target);

  if (!changed && target) {
    say("Firefox no permitió activar el bloqueo en esta página.", "error");
    return;
  }

  popupGuardEnabled = target;
  $("popup-guard").textContent = popupGuardEnabled ? "Desactivar" : "Activar";
  say(
    popupGuardEnabled
      ? "Ventanas emergentes programáticas bloqueadas hasta recargar la pestaña."
      : "Bloqueo de ventanas emergentes desactivado.",
    "ok",
  );
});

$("test-notification").addEventListener("click", async () => {
  try {
    const result = await send({ type: "testNotification" });

    if (result?.ok) {
      say(
        "Firefox aceptó la notificación. Si no aparece en Windows, revisa los permisos de notificaciones de Firefox.",
        "ok",
      );
    } else {
      say(
        `Firefox rechazó la notificación: ${result?.error || "error desconocido"}`,
        "error",
      );
    }
  } catch (error) {
    say(error?.message || "No se pudo probar la notificación.", "error");
  }
});

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
  await refreshPopupGuardState();

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
