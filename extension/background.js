const API = "http://127.0.0.1:8173";
const activeJobs = new Map();
const recentJobs = [];
const notificationJobs = new Map();
const streamsByTab = new Map();
const zoomSourcesByTab = new Map();
const contextTargetsByTab = new Map();

function streamScore(url, type) {
  const lower = String(url || "").toLowerCase();
  let score = type === "dash" ? 90 : 70;

  if (/(?:master|manifest|playlist)[^/]*\.m3u8/.test(lower)) score += 220;
  if (/(?:^|[/_.-])index(?:[?._-]|$)/.test(lower)) score += 35;
  if (/(?:index-v\d+|video|avc|h264|h265|hevc|1080|720|2160|1440)/.test(lower)) score += 110;

  if (/(?:index-a\d+|audio|aac|opus|m4a)(?:[?&/_.-]|$)/.test(lower)) score -= 280;

  return score;
}

function rememberStream(details) {
  if (details.tabId == null || details.tabId < 0) return;

  const url = String(details.url || "");
  if (!/(?:\.m3u8|\.mpd)(?:[?#]|$)/i.test(url)) return;

  const type = /\.m3u8(?:[?#]|$)/i.test(url) ? "hls" : "dash";
  const current = streamsByTab.get(details.tabId) || [];

  const next = [
    {
      url,
      frameId: details.frameId,
      type,
      score: streamScore(url, type),
      timeStamp: details.timeStamp || Date.now(),
    },
    ...current.filter((item) => item.url !== url),
  ]
    .sort((a, b) => (b.score - a.score) || (b.timeStamp - a.timeStamp))
    .slice(0, 24);

  streamsByTab.set(details.tabId, next);
}

function zoomCandidateFromUrl(rawUrl) {
  const url = String(rawUrl || "");
  const clean = url.split("#")[0];
  const noQuery = clean.split("?")[0];

  if (/\/info\.json$/i.test(noQuery)) {
    return { url, kind: "IIIF", score: 240 };
  }

  if (/\.dzi$/i.test(noQuery)) {
    return { url, kind: "Deep Zoom", score: 235 };
  }

  if (/\/ImageProperties\.xml$/i.test(noQuery)) {
    return { url, kind: "Zoomify", score: 235 };
  }

  if (/\/manifest(?:\.json)?$/i.test(noQuery) && /iiif/i.test(url)) {
    return { url, kind: "IIIF manifest", score: 210 };
  }

  const zoomifyTile = noQuery.match(/^(.*)\/TileGroup\d+\/\d+-\d+-\d+\.(?:jpe?g|png|webp)$/i);
  if (zoomifyTile) {
    return {
      url: `${zoomifyTile[1]}/ImageProperties.xml`,
      kind: "Zoomify",
      score: 190,
    };
  }

  const deepZoomTile = noQuery.match(/^(.*)_files\/\d+\/\d+_\d+\.(?:jpe?g|png|webp)$/i);
  if (deepZoomTile) {
    return {
      url: `${deepZoomTile[1]}.dzi`,
      kind: "Deep Zoom",
      score: 185,
    };
  }

  if (/\/(?:tour|krpano)[^/]*\.xml$/i.test(noQuery)) {
    return { url, kind: "Krpano", score: 160 };
  }

  return null;
}

function rememberZoomSource(details) {
  if (details.tabId == null || details.tabId < 0) return;

  const candidate = zoomCandidateFromUrl(details.url);
  if (!candidate) return;

  const current = zoomSourcesByTab.get(details.tabId) || [];
  const next = [
    {
      ...candidate,
      frameId: details.frameId,
      timeStamp: details.timeStamp || Date.now(),
    },
    ...current.filter((item) => item.url !== candidate.url),
  ]
    .sort((a, b) => (b.score - a.score) || (b.timeStamp - a.timeStamp))
    .slice(0, 16);

  zoomSourcesByTab.set(details.tabId, next);
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    rememberStream(details);
    rememberZoomSource(details);
  },
  {
    urls: ["<all_urls>"],
    types: ["xmlhttprequest", "media", "other", "image", "main_frame", "sub_frame"],
  },
);

browser.tabs.onRemoved.addListener((tabId) => {
  streamsByTab.delete(tabId);
  zoomSourcesByTab.delete(tabId);
  contextTargetsByTab.delete(tabId);
});

async function getCleanMode() {
  const stored = await browser.storage.local.get("cleanMode");
  return Boolean(stored.cleanMode);
}

async function setCleanMode(enabled) {
  if (enabled) {
    await browser.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: ["clean_ads"],
    });
  } else {
    await browser.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: ["clean_ads"],
    });
  }

  await browser.storage.local.set({ cleanMode: Boolean(enabled) });
  return { enabled: Boolean(enabled) };
}

async function getPopupGuard() {
  const stored = await browser.storage.local.get("popupGuard");
  return Boolean(stored.popupGuard);
}

async function setPopupGuard(enabled) {
  await browser.storage.local.set({ popupGuard: Boolean(enabled) });
  return { enabled: Boolean(enabled) };
}

(async () => {
  try {
    await setCleanMode(await getCleanMode());
  } catch {
    // TikSave can continue even if the ruleset cannot initialize.
  }
})();

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    cache: "no-store",
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `Error ${response.status}`);
  return data;
}


async function resolveNativeImage(url, pageUrl = null) {
  return api("/api/image/resolve", {
    method: "POST",
    body: JSON.stringify({
      url,
      page_url: pageUrl || null,
    }),
  });
}

async function downloadResolvedImage(inputUrl, pageUrl = null) {
  return api("/api/image/download", {
    method: "POST",
    body: JSON.stringify({
      url: inputUrl,
      page_url: pageUrl || null,
    }),
  });
}

async function logExtensionError(action, error, details = {}) {
  try {
    await api("/api/diagnostics/event", {
      method: "POST",
      body: JSON.stringify({
        component: "firefox-extension",
        action,
        level: "error",
        message: error?.message || String(error),
        details,
      }),
    });
  } catch {
    // Diagnostics must never break the user action.
  }
}

async function ensureDezoomEngine() {
  let state = await api("/api/dezoom/status");
  if (!state || !state.installed) {
    state = await api("/api/dezoom/install", {
      method: "POST",
      body: "{}",
    });
  }
  return state;
}

function safeFilenameFromUrl(value, fallback) {
  fallback = fallback || "image";
  try {
    const parsed = new URL(value);
    const leaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    const cleaned = leaf.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
    if (cleaned) return cleaned.slice(0, 120);
  } catch {}
  return fallback;
}

function fastOriginalCandidate(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    let changed = false;

    if (host.endsWith("pinimg.com")) {
      const nextPath = url.pathname.replace(
        /^\/(?:originals|75x75_RS|\d{2,5}x(?:\d{2,5})?)\//i,
        "/originals/",
      );
      if (nextPath !== url.pathname) {
        url.pathname = nextPath;
        changed = true;
      }
    }

    if (
      host.endsWith(".googleusercontent.com") ||
      host.endsWith(".ggpht.com") ||
      host === "googleusercontent.com" ||
      host === "ggpht.com"
    ) {
      const nextPath = url.pathname.replace(
        /=(?:s\d+|w\d+(?:-h\d+)?|h\d+(?:-w\d+)?)(?:-[a-z0-9_-]+)*$/i,
        "=s0",
      );
      if (nextPath !== url.pathname) {
        url.pathname = nextPath;
        url.search = "";
        changed = true;
      }
    }

    if (host === "pbs.twimg.com") {
      if (url.searchParams.has("name")) {
        url.searchParams.set("name", "orig");
        changed = true;
      } else if (/:(?:small|medium|large|thumb)$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/:(?:small|medium|large|thumb)$/i, ":orig");
        changed = true;
      }
    }

    if (/\.(?:jpe?g|png|webp|avif)$/i.test(url.pathname)) {
      const nextPath = url.pathname
        .replace(/-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp|avif)$)/i, "")
        .replace(/-scaled(?=\.(?:jpe?g|png|webp|avif)$)/i, "");
      if (nextPath !== url.pathname) {
        url.pathname = nextPath;
        changed = true;
      }
    }

    return changed ? url.toString() : null;
  } catch {
    return null;
  }
}

async function showImageOverlay(tabId, url, note = "") {
  if (tabId == null) throw new Error("No pude identificar la pestaña actual.");

  try {
    await browser.tabs.sendMessage(tabId, {
      type: "showImageOverlay",
      url,
      note,
    });
    return true;
  } catch (error) {
    await logExtensionError("image-overlay-open", error, { tabId, url });
    return false;
  }
}

async function updateImageOverlay(tabId, url, note = "") {
  if (tabId == null) return false;
  try {
    await browser.tabs.sendMessage(tabId, {
      type: "updateImageOverlay",
      url,
      note,
    });
    return true;
  } catch {
    return false;
  }
}

async function openOriginalImage(source, pageUrl = null, tabId = null) {
  const fast = fastOriginalCandidate(source);
  const initial = fast || source;

  const shown = await showImageOverlay(
    tabId,
    initial,
    fast ? "Versión ampliada detectada" : "Buscando una versión mayor…",
  );

  if (!shown) {
    await browser.tabs.create({ url: initial });
  }

  try {
    const result = await resolveNativeImage(source, pageUrl);
    const target = result?.best?.final_url || result?.best?.url || initial;

    if (shown && target !== initial) {
      await updateImageOverlay(
        tabId,
        target,
        result?.best?.width && result?.best?.height
          ? `${result.best.width}×${result.best.height}`
          : "Mejor variante encontrada",
      );
    }

    api("/api/diagnostics/event", {
      method: "POST",
      body: JSON.stringify({
        component: "firefox-extension",
        action: "open-original-overlay",
        level: "info",
        message: target,
        details: { source, pageUrl, fast: Boolean(fast) },
      }),
    }).catch(() => {});

    return { url: target, fast: Boolean(fast), result };
  } catch (error) {
    if (!fast && shown) {
      await updateImageOverlay(
        tabId,
        source,
        "No encontré una variante mayor; mostrando la imagen disponible.",
      );
    }
    throw error;
  }
}

function contextSource(info, tab) {
  const remembered = contextTargetsByTab.get(tab && tab.id) || {};
  return (info && info.srcUrl) || remembered.url || (info && info.linkUrl) || (tab && tab.url) || null;
}

async function startContextVideo(tab) {
  const pageUrl = tab && tab.url;
  if (!pageUrl) throw new Error("No pude leer la URL de esta pestaña.");

  const supported = /(?:youtube\.com|youtu\.be|tiktok\.com|douyin\.com|iesdouyin\.com|instagram\.com|facebook\.com|fb\.watch)/i.test(pageUrl);

  if (supported) {
    return startJob("/api/download", {
      url: pageUrl,
      mode: "video",
      quality: "best",
      playlist: false,
      music_metadata: false,
    });
  }

  const list = streamsByTab.get(tab.id) || [];
  const stream = list.find((item) => Number(item.score || 0) >= 0);

  return startJob("/api/browser-media", {
    page_url: pageUrl,
    media_url: stream ? stream.url : null,
    mode: "video",
    quality: "best",
  });
}

function createContextMenus() {
  try {
    browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({
        id: "tiksave-root",
        title: "TikSave",
        contexts: ["page", "link", "image", "video", "audio"],
      });

      browser.contextMenus.create({
        id: "tiksave-original-open",
        parentId: "tiksave-root",
        title: "Abrir imagen original",
        contexts: ["image", "page"],
      });

      browser.contextMenus.create({
        id: "tiksave-original-download",
        parentId: "tiksave-root",
        title: "Descargar imagen original / máxima resolución",
        contexts: ["image", "page"],
      });

      browser.contextMenus.create({
        id: "tiksave-dezoom",
        parentId: "tiksave-root",
        title: "Reconstruir imagen por mosaicos",
        contexts: ["image", "page", "link"],
      });

      browser.contextMenus.create({
        id: "tiksave-separator-1",
        parentId: "tiksave-root",
        type: "separator",
        contexts: ["page", "link", "image", "video", "audio"],
      });

      browser.contextMenus.create({
        id: "tiksave-download-video",
        parentId: "tiksave-root",
        title: "Descargar video de esta página",
        contexts: ["page", "video"],
      });

      browser.contextMenus.create({
        id: "tiksave-open-app",
        parentId: "tiksave-root",
        title: "Abrir esta página en TikSave",
        contexts: ["page", "link", "image", "video", "audio"],
      });

      browser.contextMenus.create({
        id: "tiksave-open-log",
        parentId: "tiksave-root",
        title: "Abrir log de diagnóstico",
        contexts: ["page", "link", "image", "video", "audio"],
      });
    }).catch(() => {});
  } catch {}
}

createContextMenus();
if (browser.runtime.onInstalled) {
  browser.runtime.onInstalled.addListener(createContextMenus);
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const source = contextSource(info, tab);

    if (info.menuItemId === "tiksave-original-open") {
      if (!source) throw new Error("No encontré una imagen debajo del cursor.");
      const pageUrl = (contextTargetsByTab.get(tab && tab.id) || {}).pageUrl || (tab && tab.url) || null;
      await openOriginalImage(source, pageUrl, tab && tab.id);
      return;
    }

    if (info.menuItemId === "tiksave-original-download") {
      if (!source) throw new Error("No encontré una imagen debajo del cursor.");
      const pageUrl = (contextTargetsByTab.get(tab && tab.id) || {}).pageUrl || (tab && tab.url) || null;
      const result = await downloadResolvedImage(source, pageUrl);
      await sendToastToActiveTab({
        status: "done",
        title: "Imagen guardada",
        filename: result.path || "TikSave/Originals",
      });
      await showFinishedBadge(true);
      return;
    }

    if (info.menuItemId === "tiksave-dezoom") {
      const detectedList = zoomSourcesByTab.get(tab && tab.id) || [];
      const detected = detectedList[0];
      const zoomSource = (detected && detected.url) || source;
      if (!zoomSource) throw new Error("No encontré una fuente de imagen para reconstruir.");

      await ensureDezoomEngine();
      const job = await startJob("/api/dezoom/download", {
        source_url: zoomSource,
        page_url: (tab && tab.url) || null,
        output_format: "jpg",
      });
      await sendToastToActiveTab({
        status: "done",
        title: "Reconstrucción iniciada",
        filename: (job && job.id) || "",
      });
      return;
    }

    if (info.menuItemId === "tiksave-download-video") {
      await startContextVideo(tab);
      return;
    }

    if (info.menuItemId === "tiksave-open-app") {
      const target = (info && info.linkUrl) || (tab && tab.url) || source;
      if (!target) throw new Error("No encontré un enlace para abrir.");
      await browser.tabs.create({
        url: API + "/?url=" + encodeURIComponent(target),
      });
      return;
    }

    if (info.menuItemId === "tiksave-open-log") {
      await api("/api/diagnostics/open-log", {
        method: "POST",
        body: "{}",
      });
      return;
    }
  } catch (error) {
    await logExtensionError("context-menu", error, {
      menuItemId: info && info.menuItemId,
      pageUrl: tab && tab.url,
      source: contextSource(info, tab),
    });
    await sendToastToActiveTab({
      status: "error",
      title: "TikSave",
      error: (error && error.message) || String(error),
    });
    await showFinishedBadge(false);
  }
});

async function broadcastJob(job) {
  try {
    await browser.runtime.sendMessage({ type: "jobUpdate", job });
  } catch {
    // No extension page is listening right now.
  }
}

async function sendToastToActiveTab(job) {
  try {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab?.id) return false;

    await browser.tabs.sendMessage(tab.id, {
      type: "showTikSaveToast",
      job,
    });
    return true;
  } catch {
    return false;
  }
}

async function updateBadge() {
  const count = activeJobs.size;
  await browser.action.setBadgeBackgroundColor({ color: "#5c6675" });
  await browser.action.setBadgeText({ text: count ? String(count) : "" });
}

async function showFinishedBadge(success) {
  await browser.action.setBadgeBackgroundColor({
    color: success ? "#2e7d4f" : "#a34552",
  });
  await browser.action.setBadgeText({ text: success ? "✓" : "!" });

  setTimeout(async () => {
    if (!activeJobs.size) {
      await browser.action.setBadgeText({ text: "" });
    } else {
      await updateBadge();
    }
  }, 10000);
}

function shortText(value, max = 160) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function createNotification(notificationId, options) {
  try {
    const createdId = await browser.notifications.create(notificationId, options);
    return { ok: true, id: createdId };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function notifyFinished(job) {
  const success = job.status === "done";
  const notificationId = `tiksave-${job.id}-${Date.now()}`;

  notificationJobs.set(notificationId, job.id);

  const result = await createNotification(notificationId, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/tiksave.svg"),
    title: success ? "TikSave · Descarga terminada" : "TikSave · Descarga fallida",
    message: success
      ? shortText(job.title || job.filename || "El archivo ya está listo.")
      : shortText(job.error || "No se pudo completar la descarga."),
  });

  const toastShown = await sendToastToActiveTab(job);
  await showFinishedBadge(success);

  if (!result.ok) {
    await broadcastJob({
      ...job,
      notification_error: result.error,
      toast_shown: toastShown,
    });
  }
}

async function trackJob(jobId, initialJob = null) {
  if (activeJobs.has(jobId)) return;

  activeJobs.set(jobId, initialJob || { id: jobId, status: "queued", progress: 0 });
  await updateBadge();

  while (activeJobs.has(jobId)) {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      activeJobs.set(jobId, job);
      await broadcastJob(job);

      if (job.status === "done" || job.status === "error") {
        activeJobs.delete(jobId);
        recentJobs.unshift(job);
        recentJobs.splice(5);
        await updateBadge();
        await notifyFinished(job);
        return;
      }
    } catch (error) {
      activeJobs.delete(jobId);
      await updateBadge();
      const failed = {
        id: jobId,
        status: "error",
        progress: 0,
        error: error?.message || "No se pudo consultar TikSave.",
      };
      await broadcastJob(failed);
      await sendToastToActiveTab(failed);
      await showFinishedBadge(false);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 900));
  }
}

async function startJob(path, payload) {
  const job = await api(path, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  trackJob(job.id, job);
  return job;
}

function imageExtension(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const match = path.match(/\.(jpe?g|png|webp|avif|gif)(?:$|\/)/i);
    if (match) return match[1] === "jpeg" ? "jpg" : match[1];
  } catch {}
  return "jpg";
}

function safeSegment(value) {
  return String(value || "images")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "images";
}

async function downloadImages(payload) {
  const images = [...new Set((payload?.images || []).filter((url) => /^https?:\/\//i.test(url)))].slice(0, 50);
  if (!images.length) throw new Error("No hay imágenes para descargar.");

  const platform = safeSegment(payload?.platform || "web");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ids = [];

  for (let index = 0; index < images.length; index += 1) {
    const url = images[index];
    const ext = imageExtension(url);
    const filename = `TikSave/Images/${platform}/${stamp}-${String(index + 1).padStart(2, "0")}.${ext}`;

    const id = await browser.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    ids.push(id);
  }

  return { count: ids.length, ids };
}

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message && message.type === "rememberContextTarget" && message.target && sender && sender.tab && sender.tab.id != null) {
    contextTargetsByTab.set(sender.tab.id, message.target);
    return { ok: true };
  }


  switch (message?.type) {
    case "health":
      return api("/api/health");

    case "startDownload":
      return startJob("/api/download", message.payload);

    case "startBrowserMedia":
      return startJob("/api/browser-media", message.payload);

    case "startDezoom":
      return startJob("/api/dezoom/download", message.payload);

    case "getDezoomStatus":
      return api("/api/dezoom/status");

    case "installDezoom":
      return api("/api/dezoom/install", {
        method: "POST",
        body: "{}",
      });

    case "getJob":
      return api(`/api/jobs/${message.jobId}`);

    case "getActiveJobs":
      return [...activeJobs.values()];

    case "getRecentJobs":
      return recentJobs;

    case "getDetectedStreams":
      return streamsByTab.get(message.tabId) || [];

    case "getDetectedZoomSources":
      return zoomSourcesByTab.get(message.tabId) || [];

    case "getContextTarget":
      return contextTargetsByTab.get(message.tabId) || null;

    case "getMaxUrlStatus":
      return api("/api/image/status");

    case "installMaxUrl":
      return api("/api/image/status");

    case "resolveMaxUrl":
      return resolveNativeImage(message.url, message.pageUrl || null);

    case "downloadMaxUrl":
      return downloadResolvedImage(message.url, message.pageUrl || null);

    case "openDiagnosticsLog":
      return api("/api/diagnostics/open-log", {
        method: "POST",
        body: "{}",
      });

    case "openImageInTab":
      if (!message.url) throw new Error("Falta la URL de imagen.");
      return browser.tabs.create({ url: message.url });

    case "downloadDirectImage":
      if (!message.url) throw new Error("Falta la URL de imagen.");
      return browser.downloads.download({
        url: message.url,
        filename: "TikSave/Originals/" + safeFilenameFromUrl(message.url, "imagen-original.jpg"),
        conflictAction: "uniquify",
        saveAs: false,
      });

    case "getCleanMode":
      return { enabled: await getCleanMode() };

    case "setCleanMode":
      return setCleanMode(Boolean(message.enabled));

    case "getPopupGuard":
      return { enabled: await getPopupGuard() };

    case "setPopupGuard":
      return setPopupGuard(Boolean(message.enabled));

    case "downloadImages":
      return downloadImages(message.payload || {});

    case "openFolder":
      return api("/api/open-folder", {
        method: "POST",
        body: "{}",
      });

    case "testNotification": {
      const testJob = {
        id: `test-${Date.now()}`,
        status: "done",
        title: "Notificación de prueba de TikSave",
        filename: "TikSave está listo para avisarte cuando termine una descarga.",
      };

      const system = await createNotification(`tiksave-test-${Date.now()}`, {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/tiksave.svg"),
        title: "TikSave · Notificación de prueba",
        message: "También debería aparecer un aviso dentro de la pestaña activa.",
      });

      const toast = await sendToastToActiveTab(testJob);
      await showFinishedBadge(true);
      return { ...system, toast };
    }

    default:
      return null;
  }
});

browser.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationJobs.has(notificationId)) return;
  try {
    await api("/api/open-folder", { method: "POST", body: "{}" });
  } catch {
    // The local app may have been closed after the download finished.
  }
});

browser.notifications.onClosed.addListener((notificationId) => {
  notificationJobs.delete(notificationId);
});
