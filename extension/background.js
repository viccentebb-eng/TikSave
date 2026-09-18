const API = "http://127.0.0.1:8173";
const activeJobs = new Map();
const recentJobs = [];
const notificationJobs = new Map();

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

async function notifyFinished(job) {
  const success = job.status === "done";
  const notificationId = `tiksave-${job.id}-${Date.now()}`;

  notificationJobs.set(notificationId, job.id);

  await browser.notifications.create(notificationId, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/tiksave.svg"),
    title: success ? "TikSave · Descarga terminada" : "TikSave · No se pudo descargar",
    message: success
      ? shortText(job.title || job.filename || "El archivo ya está listo.")
      : shortText(job.error || "La descarga terminó con un error."),
  });
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

    case "openFolder":
      return api("/api/open-folder", {
        method: "POST",
        body: "{}",
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
