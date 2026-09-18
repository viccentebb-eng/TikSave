const $ = (id) => document.getElementById(id);
const urlInput = $("url");
const message = $("message");
const jobBox = $("job");
const bar = $("bar");
const percent = $("percent");
const statusEl = $("status");
const details = $("details");
let pollTimer = null;

function showMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

function clearMessage() {
  message.textContent = "";
  message.className = "message hidden";
}

function getUrl() {
  const value = urlInput.value.trim();
  if (!value) throw new Error("Pega primero un enlace de TikTok.");
  return value;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Error ${res.status}`);
  return data;
}

$("inspect").addEventListener("click", async () => {
  clearMessage();
  try {
    const data = await api("/api/inspect", {
      method: "POST",
      body: JSON.stringify({ url: getUrl() }),
    });
    $("title").textContent = data.title || "TikTok";
    $("uploader").textContent = data.uploader ? `@${String(data.uploader).replace(/^@/, "")}` : "";
    $("thumb").src = data.thumbnail || "";
    $("preview").classList.remove("hidden");
  } catch (err) {
    showMessage(err.message, "error");
  }
});

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", async () => {
    clearMessage();
    try {
      const data = await api("/api/download", {
        method: "POST",
        body: JSON.stringify({ url: getUrl(), mode: button.dataset.mode }),
      });
      startPolling(data.id);
    } catch (err) {
      showMessage(err.message, "error");
    }
  });
});

function startPolling(jobId) {
  if (pollTimer) clearInterval(pollTimer);
  jobBox.classList.remove("hidden");
  bar.style.width = "0%";
  percent.textContent = "0%";
  statusEl.textContent = "Preparando…";
  details.textContent = "";
  pollTimer = setInterval(() => updateJob(jobId), 650);
  updateJob(jobId);
}

async function updateJob(jobId) {
  try {
    const data = await api(`/api/jobs/${jobId}`);
    const pct = Number(data.progress || 0);
    bar.style.width = `${pct}%`;
    percent.textContent = `${pct.toFixed(pct % 1 ? 1 : 0)}%`;
    const labels = {
      queued: "En cola…",
      starting: "Preparando…",
      downloading: "Descargando…",
      processing: "Procesando archivo…",
      done: "Terminado",
      error: "Error",
    };
    statusEl.textContent = labels[data.status] || data.status;
    details.textContent = [data.speed, data.eta && `ETA ${data.eta}`, data.filename].filter(Boolean).join(" · ");

    if (data.status === "done") {
      clearInterval(pollTimer);
      pollTimer = null;
      showMessage("Archivo guardado correctamente.", "ok");
    } else if (data.status === "error") {
      clearInterval(pollTimer);
      pollTimer = null;
      showMessage(data.error || "La descarga falló.", "error");
    }
  } catch (err) {
    clearInterval(pollTimer);
    pollTimer = null;
    showMessage(err.message, "error");
  }
}

$("paste").addEventListener("click", async () => {
  clearMessage();
  try {
    urlInput.value = (await navigator.clipboard.readText()).trim();
    urlInput.focus();
  } catch {
    showMessage("Firefox no permitió leer el portapapeles. Usa Ctrl+V dentro del campo.", "error");
  }
});

$("open-folder").addEventListener("click", async () => {
  clearMessage();
  try {
    await api("/api/open-folder", { method: "POST", body: "{}" });
  } catch (err) {
    showMessage(err.message, "error");
  }
});
