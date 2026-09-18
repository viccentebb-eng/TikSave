const $ = (id) => document.getElementById(id);
const urlsInput = $("urls");
const message = $("message");
const jobsBox = $("jobs");
const jobPollers = new Map();

function showMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

function clearMessage() {
  message.textContent = "";
  message.className = "message hidden";
}

function getUrls() {
  const urls = urlsInput.value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (!urls.length) {
    throw new Error("Pega al menos un enlace.");
  }

  return [...new Set(urls)];
}

function platformLabel(platform) {
  return {
    tiktok: "TikTok",
    youtube: "YouTube",
    instagram: "Instagram",
    facebook: "Facebook",
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

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.detail || `Error ${res.status}`);
  }

  return data;
}

$("inspect").addEventListener("click", async () => {
  clearMessage();

  try {
    const [url] = getUrls();
    const data = await api("/api/inspect", {
      method: "POST",
      body: JSON.stringify({
        url,
        playlist: $("playlist").checked,
      }),
    });

    $("title").textContent = data.title || "Contenido";
    $("uploader").textContent = [
      platformLabel(data.platform),
      data.uploader,
    ].filter(Boolean).join(" · ");

    $("playlist-info").textContent = data.is_playlist
      ? `Lista / colección · ${data.entry_count ?? "varios"} elementos`
      : "";

    $("thumb").src = data.thumbnail || "";
    $("preview").classList.remove("hidden");
  } catch (err) {
    showMessage(err.message, "error");
  }
});

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", async () => {
    clearMessage();

    let urls;
    try {
      urls = getUrls();
    } catch (err) {
      showMessage(err.message, "error");
      return;
    }

    const mode = button.dataset.mode;
    const quality = $("quality").value;
    const playlist = $("playlist").checked;

    jobsBox.innerHTML = "";
    jobsBox.classList.remove("hidden");

    for (const timer of jobPollers.values()) {
      clearInterval(timer);
    }
    jobPollers.clear();

    let started = 0;
    let failed = 0;

    const requests = urls.map(async (url, index) => {
      try {
        const data = await api("/api/download", {
          method: "POST",
          body: JSON.stringify({
            url,
            mode,
            quality,
            playlist,
          }),
        });

        started += 1;
        createJobCard(data.id, url, index + 1, urls.length);
        startPolling(data.id);
      } catch (err) {
        failed += 1;
        createRejectedCard(url, err.message, index + 1, urls.length);
      }
    });

    await Promise.all(requests);

    if (failed) {
      showMessage(
        `${started} descarga(s) iniciada(s); ${failed} enlace(s) rechazado(s).`,
        "error",
      );
    } else {
      showMessage(
        `${started} descarga(s) iniciada(s). Puedes dejar esta ventana abierta para ver el progreso.`,
        "ok",
      );
    }
  });
});

function createJobCard(jobId, url, position, total) {
  const card = document.createElement("article");
  card.className = "job-card";
  card.id = `job-${jobId}`;

  card.innerHTML = `
    <div class="job-head">
      <div class="job-title">
        <strong>${position}/${total} · ${escapeHtml(shortUrl(url))}</strong>
        <span data-role="status">En cola…</span>
      </div>
      <span data-role="percent">0%</span>
    </div>
    <div class="track"><div data-role="bar" class="bar"></div></div>
    <div data-role="details" class="details"></div>
  `;

  jobsBox.appendChild(card);
}

function createRejectedCard(url, error, position, total) {
  const card = document.createElement("article");
  card.className = "job-card failed";
  card.innerHTML = `
    <div class="job-head">
      <div class="job-title">
        <strong>${position}/${total} · ${escapeHtml(shortUrl(url))}</strong>
        <span>Error antes de iniciar</span>
      </div>
      <span>—</span>
    </div>
    <div class="details error-text">${escapeHtml(error)}</div>
  `;
  jobsBox.appendChild(card);
}

function startPolling(jobId) {
  const timer = setInterval(() => updateJob(jobId), 700);
  jobPollers.set(jobId, timer);
  updateJob(jobId);
}

async function updateJob(jobId) {
  const card = document.getElementById(`job-${jobId}`);
  if (!card) return;

  const statusEl = card.querySelector('[data-role="status"]');
  const percentEl = card.querySelector('[data-role="percent"]');
  const barEl = card.querySelector('[data-role="bar"]');
  const detailsEl = card.querySelector('[data-role="details"]');

  try {
    const data = await api(`/api/jobs/${jobId}`);
    const pct = Number(data.progress || 0);

    barEl.style.width = `${pct}%`;
    percentEl.textContent = `${pct.toFixed(pct % 1 ? 1 : 0)}%`;

    const labels = {
      queued: "En cola…",
      starting: "Preparando…",
      downloading: "Descargando…",
      processing: "Procesando archivo…",
      done: "Terminado",
      error: "Error",
    };

    let status = labels[data.status] || data.status;

    if (data.total_items && data.current_index) {
      status += ` · ${data.current_index}/${data.total_items}`;
    }

    statusEl.textContent = status;

    detailsEl.textContent = [
      platformLabel(data.platform),
      data.quality !== "best" && data.mode === "video" ? `${data.quality}p máx.` : null,
      data.title,
      data.speed,
      data.eta && `ETA ${data.eta}`,
      data.filename,
    ].filter(Boolean).join(" · ");

    if (data.status === "done" || data.status === "error") {
      const timer = jobPollers.get(jobId);
      if (timer) clearInterval(timer);
      jobPollers.delete(jobId);

      if (data.status === "done") {
        card.classList.add("done");
      } else {
        card.classList.add("failed");
        detailsEl.textContent = data.error || "La descarga falló.";
      }
    }
  } catch (err) {
    const timer = jobPollers.get(jobId);
    if (timer) clearInterval(timer);
    jobPollers.delete(jobId);
    card.classList.add("failed");
    statusEl.textContent = "Error";
    detailsEl.textContent = err.message;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

$("paste").addEventListener("click", async () => {
  urlsInput.focus();

  try {
    if (!navigator.clipboard?.readText) {
      throw new Error("clipboard unavailable");
    }

    const text = (await navigator.clipboard.readText()).trim();

    if (!text) {
      showMessage("El portapapeles está vacío.");
      return;
    }

    urlsInput.value = text;
    clearMessage();
  } catch {
    showMessage(
      "Firefox protege el portapapeles. El campo ya está activo: presiona Ctrl+V para pegar.",
    );
  }
});

$("clear").addEventListener("click", () => {
  urlsInput.value = "";
  $("preview").classList.add("hidden");
  jobsBox.innerHTML = "";
  jobsBox.classList.add("hidden");

  for (const timer of jobPollers.values()) {
    clearInterval(timer);
  }
  jobPollers.clear();
  clearMessage();
  urlsInput.focus();
});

$("open-folder").addEventListener("click", async () => {
  clearMessage();

  try {
    await api("/api/open-folder", {
      method: "POST",
      body: "{}",
    });
  } catch (err) {
    showMessage(err.message, "error");
  }
});
