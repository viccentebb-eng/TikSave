const API = "http://127.0.0.1:8173";
const activeJobs = new Map();
const recentJobs = [];
const notificationJobs = new Map();
const streamsByTab = new Map();

function rememberStream(details) {
  if (details.tabId == null || details.tabId < 0) return;

  const url = String(details.url || "");
  if (!/(?:\.m3u8|\.mpd)(?:[?#]|$)/i.test(url)) return;

  const current = streamsByTab.get(details.tabId) || [];
  const next = [
    {
      url,
      frameId: details.frameId,
      type: /\.m3u8(?:[?#]|$)/i.test(url) ? "hls" : "dash",
      timeStamp: details.timeStamp || Date.now(),
    },
    ...current.filter((item) => item.url !== url),
  ].slice(0, 20);

  streamsByTab.set(details.tabId, next);
}

browser.webRequest.onBeforeRequest.addListener(
  rememberStream,
  {
    urls: ["<all_urls>"],
    types: ["xmlhttprequest", "media", "other"],
  },
);

browser.tabs.onRemoved.addListener((tabId) => {
  streamsByTab.delete(tabId);
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

browser.runtime.onMessage.addListener(async (message) => {
  switch (message?.type) {
    case "health":
      return api("/api/health");

    case "startDownload":
      return startJob("/api/download", message.payload);

    case "startBrowserMedia":
      return startJob("/api/browser-media", message.payload);

    case "getJob":
      return api(`/api/jobs/${message.jobId}`);

    case "getActiveJobs":
      return [...activeJobs.values()];

    case "getRecentJobs":
      return recentJobs;

    case "getDetectedStreams":
      return streamsByTab.get(message.tabId) || [];

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
