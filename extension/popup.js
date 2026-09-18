const $ = (id) => document.getElementById(id);

let currentTab = null;
let currentUrl = "";
let activeJobId = null;
let pollTimer = null;
let browserMedia = null;
let popupGuardEnabled = false;
let cleanModeEnabled = false;
let detectedImages = [];
let detectedZoomSources = [];
let dezoomInstalled = false;

function supportedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com") ||
      host === "douyin.com" ||
      host.endsWith(".douyin.com") ||
      host.endsWith(".iesdouyin.com") ||
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

        function manifestScore(name) {
          const lower = String(name || "").toLowerCase();
          let score = /\.mpd(?:[?#]|$)/i.test(lower) ? 90 : 70;
          if (/(?:master|manifest|playlist)[^/]*\.m3u8/.test(lower)) score += 220;
          if (/(?:index-v\d+|video|avc|h264|h265|hevc|1080|720|2160|1440)/.test(lower)) score += 110;
          if (/(?:index-a\d+|audio|aac|opus|m4a)(?:[?&/_.-]|$)/.test(lower)) score -= 280;
          return score;
        }

        const manifest =
          [...manifests].sort((a, b) => manifestScore(b) - manifestScore(a))[0] ||
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

    let networkStreams = [];
    try {
      networkStreams = await send({ type: "getDetectedStreams", tabId });
    } catch {
      networkStreams = [];
    }

    if (networkStreams?.length) {
      const stream = networkStreams[0];
      const audioOnly = Number(stream.score || 0) < 0;

      candidates.push({
        found: true,
        playing: true,
        protected: false,
        source: audioOnly ? null : stream.url,
        sourceKind: audioOnly ? "audio-hls" : stream.type,
        title: "Stream detectado",
        duration: null,
        currentTime: null,
        score: audioOnly ? 1000 : 170000000 + Number(stream.score || 0) * 1000,
      });

      candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    return candidates[0] || { found: false };
  } catch {
    return { found: false };
  }
}

async function detectPageImages(tabId) {
  const merged = new Map();

  function absorb(items = []) {
    for (const item of items) {
      if (!item?.url) continue;

      let key = item.url;
      try {
        const parsed = new URL(item.url);
        const host = parsed.hostname.toLowerCase();
        key = /(fbcdn\.net|cdninstagram\.com|tiktokcdn|muscdn|byteimg|douyincdn)/i.test(host)
          ? `${host}${parsed.pathname}`
          : parsed.href;
      } catch {}

      const existing = merged.get(key);
      if (!existing || Number(item.score || 0) > Number(existing.score || 0)) {
        merged.set(key, item);
      }
    }
  }

  try {
    const scan = browser.tabs.sendMessage(tabId, { type: "scanSocialImages" });
    const timeout = new Promise((resolve) => setTimeout(() => resolve([]), 6500));
    absorb(await Promise.race([scan, timeout]));
  } catch {
    // Older/open tabs may not have the new scanner until they are reloaded.
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        function bestSrcset(srcset) {
          if (!srcset) return null;
          return srcset
            .split(",")
            .map((part) => {
              const pieces = part.trim().split(/\s+/);
              const url = pieces[0] || "";
              let score = 0;
              const descriptor = pieces[1] || "";
              if (/\d+w$/i.test(descriptor)) score = Number(descriptor.slice(0, -1)) || 0;
              else if (/\d+(?:\.\d+)?x$/i.test(descriptor)) score = (Number(descriptor.slice(0, -1)) || 0) * 1000;
              return { url, score };
            })
            .filter((item) => /^https?:\/\//i.test(item.url))
            .sort((a, b) => b.score - a.score)[0]?.url || null;
        }

        function candidateFromImage(img) {
          const rect = img.getBoundingClientRect();
          const area = Math.max(0, rect.width) * Math.max(0, rect.height);
          const naturalArea = (img.naturalWidth || 0) * (img.naturalHeight || 0);
          const inContent = Boolean(img.closest("article, main, [role='dialog']"));
          const smallSquare =
            (img.naturalWidth || 0) <= 240 &&
            (img.naturalHeight || 0) <= 240 &&
            Math.abs((img.naturalWidth || 0) - (img.naturalHeight || 0)) < 10;

          const url = bestSrcset(img.getAttribute("srcset")) || img.currentSrc || img.src || "";
          if (!/^https?:\/\//i.test(url)) return null;

          const score =
            area +
            Math.min(naturalArea / 4, 500000) +
            (inContent ? 300000 : 0) -
            (smallSquare ? 220000 : 0);

          return {
            url,
            score,
            width: img.naturalWidth || Math.round(rect.width),
            height: img.naturalHeight || Math.round(rect.height),
            alt: img.alt || "",
          };
        }

        const images = [...document.images]
          .map(candidateFromImage)
          .filter(Boolean);

        const metaUrls = [
          document.querySelector('meta[property="og:image"]')?.content,
          document.querySelector('meta[name="twitter:image"]')?.content,
        ].filter((url) => /^https?:\/\//i.test(url || ""));

        for (const url of metaUrls) {
          images.push({
            url,
            score: 350000,
            width: 0,
            height: 0,
            alt: "",
          });
        }

        return images
          .sort((a, b) => b.score - a.score)
          .slice(0, 40);
      },
    });

    for (const frame of results) absorb(frame.result || []);
  } catch {
    // The social scanner may still have produced useful results.
  }

  return [...merged.values()]
    .filter((item) => {
      const lower = `${item.url} ${item.alt || ""}`.toLowerCase();
      if (/(profile|avatar|sprite|emoji|logo)/.test(lower) && Number(item.score || 0) < 260000) {
        return false;
      }
      return Number(item.score || 0) > 20000;
    })
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 30);
}

function currentPlatform() {
  try {
    const host = new URL(currentUrl).hostname.toLowerCase();

    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "TikTok";
    if (host === "douyin.com" || host.endsWith(".douyin.com") || host.endsWith(".iesdouyin.com")) return "Douyin";
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "Instagram";
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "YouTube";
    if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch") return "Facebook";
  } catch {}

  return "web";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderImages(images) {
  detectedImages = images || [];
  const card = $("image-card");
  const grid = $("image-grid");

  if (!detectedImages.length) {
    card.classList.add("hidden");
    grid.innerHTML = "";
    return;
  }

  card.classList.remove("hidden");
  $("image-title").textContent = `${detectedImages.length} imagen${detectedImages.length === 1 ? "" : "es"} detectada${detectedImages.length === 1 ? "" : "s"}`;
  $("image-info").textContent = "Todas están seleccionadas. Desmarca las que no quieras.";

  grid.innerHTML = detectedImages.map((item, index) => `
    <label class="image-choice">
      <img
        src="${escapeHtml(item.url)}"
        alt="${escapeHtml(item.alt || `Imagen ${index + 1}`)}"
        data-view-image-index="${index}"
        title="Abrir en visor grande"
      >
      <input type="checkbox" data-image-index="${index}" checked>
      <span>${index + 1}</span>
    </label>
  `).join("");
}

function selectedImages() {
  return [...document.querySelectorAll("[data-image-index]:checked")]
    .map((input) => detectedImages[Number(input.dataset.imageIndex)])
    .filter(Boolean);
}

$("image-grid").addEventListener("click", async (event) => {
  const target = event.target.closest("[data-view-image-index]");
  if (!target || !currentTab?.id) return;

  event.preventDefault();
  event.stopPropagation();

  const index = Number(target.dataset.viewImageIndex);
  const urls = detectedImages.map((item) => item.url).filter(Boolean);
  if (!Number.isInteger(index) || !urls[index]) return;

  try {
    await browser.tabs.sendMessage(currentTab.id, {
      type: "showImageOverlay",
      urls,
      index,
      pageUrl: currentUrl,
      note: urls.length > 1 ? `Carrusel · ${index + 1} / ${urls.length}` : "",
    });
  } catch (error) {
    say(error?.message || "Recarga la pestaña para activar el visor de TikSave.", "error");
  }
});

function renderDezoomSources(sources) {
  detectedZoomSources = sources || [];
  const card = $("dezoom-card");

  if (!detectedZoomSources.length) {
    card.classList.add("hidden");
    return;
  }

  const source = detectedZoomSources[0];
  card.classList.remove("hidden");
  $("dezoom-info").textContent = `${source.kind} detectado. TikSave puede reconstruir la resolución máxima.`;
  $("dezoom-source").textContent = source.url;
  $("dezoom-download").disabled = !dezoomInstalled;
  $("dezoom-install").classList.toggle("hidden", dezoomInstalled);
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

  if (media.sourceKind === "audio-hls") {
    $("browser-media-info").textContent =
      "Solo detecté una pista HLS de audio. Reproduce unos segundos más y vuelve a abrir TikSave.";
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
    "audio-hls": "pista de audio HLS",
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
  const result = await send({
    type: "setPopupGuard",
    enabled: Boolean(enabled),
  });

  popupGuardEnabled = Boolean(result?.enabled);
  $("popup-guard").textContent = popupGuardEnabled ? "Desactivar" : "Activar";
  return popupGuardEnabled;
}

async function refreshPopupGuardState() {
  try {
    const result = await send({ type: "getPopupGuard" });
    popupGuardEnabled = Boolean(result?.enabled);
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
  try {
    const enabled = await setPopupGuard(!popupGuardEnabled);
    say(
      enabled
        ? "Bloqueo global de pop-ups activado. Seguirá activo en nuevas pestañas."
        : "Bloqueo global de pop-ups desactivado.",
      "ok",
    );
  } catch (error) {
    say(error?.message || "No se pudo cambiar el bloqueo de pop-ups.", "error");
  }
});

$("clean-mode").addEventListener("click", async () => {
  try {
    const result = await send({
      type: "setCleanMode",
      enabled: !cleanModeEnabled,
    });

    cleanModeEnabled = Boolean(result?.enabled);
    $("clean-mode").textContent = cleanModeEnabled ? "Desactivar" : "Activar";

    say(
      cleanModeEnabled
        ? "Modo limpio activado: TikSave bloqueará redes publicitarias y trackers comunes."
        : "Modo limpio desactivado.",
      "ok",
    );
  } catch (error) {
    say(error?.message || "No se pudo cambiar el modo limpio.", "error");
  }
});

$("reader-mode").addEventListener("click", async () => {
  if (!currentTab?.id) return;

  if (!currentTab.isArticle && !currentTab.isInReaderMode) {
    say("Firefox no reconoce esta página como un artículo compatible con Modo lectura.", "error");
    return;
  }

  try {
    await browser.tabs.toggleReaderMode(currentTab.id);
    window.close();
  } catch (error) {
    say(error?.message || "No se pudo abrir el Modo lectura.", "error");
  }
});

$("open-diagnostics-log").addEventListener("click", async () => {
  try {
    const result = await send({ type: "openDiagnosticsLog" });
    say(`Log abierto: ${result?.path || "TikSave/logs/tiksave.log"}`, "ok");
  } catch (error) {
    say(error?.message || "No se pudo abrir el log de diagnóstico.", "error");
  }
});

$("test-notification").addEventListener("click", async () => {
  try {
    const result = await send({ type: "testNotification" });

    if (result?.ok) {
      say(
        result?.toast
          ? "TikSave mostró el aviso dentro de la pestaña. La notificación del sistema depende de Firefox y Windows."
          : "Firefox aceptó la notificación del sistema, pero no pude mostrar el aviso dentro de esta pestaña.",
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

$("images-all").addEventListener("click", () => {
  document.querySelectorAll("[data-image-index]").forEach((input) => {
    input.checked = true;
  });
});

$("images-none").addEventListener("click", () => {
  document.querySelectorAll("[data-image-index]").forEach((input) => {
    input.checked = false;
  });
});

$("download-images").addEventListener("click", async () => {
  const selected = selectedImages();

  if (!selected.length) {
    say("Selecciona al menos una imagen.", "error");
    return;
  }

  try {
    const result = await send({
      type: "downloadImages",
      payload: {
        images: selected.map((item) => item.url),
        platform: currentPlatform(),
        page_url: currentUrl,
      },
    });

    say(
      `${result?.count || 0} imagen${result?.count === 1 ? "" : "es"} enviada${result?.count === 1 ? "" : "s"} a Descargas/TikSave/Images.`,
      "ok",
    );
  } catch (error) {
    say(error?.message || "No se pudieron descargar las imágenes.", "error");
  }
});

$("dezoom-install").addEventListener("click", async () => {
  $("dezoom-install").disabled = true;
  $("dezoom-install").textContent = "Instalando…";
  say("Descargando el motor oficial dezoomify-rs desde GitHub…");

  try {
    const result = await send({ type: "installDezoom" });
    dezoomInstalled = Boolean(result?.installed);
    $("dezoom-install").classList.toggle("hidden", dezoomInstalled);
    $("dezoom-download").disabled = !dezoomInstalled;
    say(
      dezoomInstalled
        ? `Motor de imágenes instalado${result?.version ? `: ${result.version}` : "."}`
        : "No se pudo confirmar la instalación.",
      dezoomInstalled ? "ok" : "error",
    );
  } catch (error) {
    say(error?.message || "No se pudo instalar el motor de imágenes.", "error");
  } finally {
    $("dezoom-install").disabled = false;
    $("dezoom-install").textContent = "Instalar motor de imágenes";
  }
});

$("dezoom-download").addEventListener("click", async () => {
  const source = detectedZoomSources[0];
  if (!source) {
    say("No hay un visor de alta resolución detectado.", "error");
    return;
  }

  try {
    const job = await send({
      type: "startDezoom",
      payload: {
        source_url: source.url,
        page_url: currentUrl,
        output_format: $("dezoom-format").value,
      },
    });

    renderJob(job);
    startPolling(job.id);
    say("Reconstrucción de la imagen iniciada.", "ok");
  } catch (error) {
    say(error?.message || "No se pudo iniciar la reconstrucción de la imagen.", "error");
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
    const cleanMode = await send({ type: "getCleanMode" });
    cleanModeEnabled = Boolean(cleanMode?.enabled);
    $("clean-mode").textContent = cleanModeEnabled ? "Desactivar" : "Activar";
  } catch {
    $("clean-mode").disabled = true;
  }

  $("reader-mode").disabled = !(currentTab?.isArticle || currentTab?.isInReaderMode);
  $("reader-mode").textContent = currentTab?.isInReaderMode ? "Salir" : "Abrir";

  try {
    const health = await send({ type: "health" });
    setAppStatus("TikSave está abierto", "ready");
    dezoomInstalled = Boolean(health?.dezoomify?.installed);
  } catch {
    setAppStatus("Abre TikSave en tu computadora", "error");
  }

  if (!supportedUrl(currentUrl) && currentTab?.id) {
    renderBrowserMedia(await detectPlayingMedia(currentTab.id));
  } else {
    $("browser-media").classList.add("hidden");
  }

  if (currentTab?.id) {
    const platform = currentPlatform();

    if (["Instagram", "TikTok", "Douyin"].includes(platform)) {
      detectPageImages(currentTab.id)
        .then((images) => renderImages(images))
        .catch(() => renderImages([]));
    } else {
      $("image-card").classList.add("hidden");
    }

    try {
      const sources = await send({
        type: "getDetectedZoomSources",
        tabId: currentTab.id,
      });
      renderDezoomSources(sources);
    } catch {
      $("dezoom-card").classList.add("hidden");
    }
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
