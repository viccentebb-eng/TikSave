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
  ].slice(0, 12);

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

(async () => {
  try {
    await setCleanMode(await getCleanMode());
  } catch {
    // The rest of TikSave continues working even if clean mode cannot initialize.
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
    // It is normal to have no popup/content listener at a given moment.
  }
}

async function updateBadge() {
  const count = activeJobs.size;
  await browser.action.setBadgeText({ text: count ? String(count) : "" });
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
    title: success ? "TikSave · Descarga terminada" : "TikSave · No se pudo descargar",
    message: success
      ? shortText(job.title || job.filename || "El archivo ya está listo.")
      : shortText(job.error || "La descarga terminó con un error."),
  });

  if (!result.ok) {
    await broadcastJob({
      ...job,
      notification_error: result.error,
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
      await broadcastJob({
        id: jobId,
        status: "error",
        progress: 0,
        error: error?.message || "No se pudo consultar TikSave.",
      });
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

    case "openFolder":
      return api("/api/open-folder", {
        method: "POST",
        body: "{}",
      });

    case "testNotification":
      return createNotification(`tiksave-test-${Date.now()}`, {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/tiksave.svg"),
        title: "TikSave · Notificación de prueba",
        message: "Si ves este aviso, Firefox puede mostrar las notificaciones de TikSave.",
      });

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
