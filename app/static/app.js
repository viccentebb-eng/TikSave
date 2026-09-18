const $ = (id) => document.getElementById(id);

const urlsInput = $("urls");
const message = $("message");
const jobsBox = $("jobs");
const jobPollers = new Map();

let currentInspection = null;
let inspectTimer = null;

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

  if (!urls.length) throw new Error("Pega al menos un enlace.");
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function resetInspection() {
  currentInspection = null;
  $("preview").classList.add("hidden");
  $("carousel-panel").classList.add("hidden");
  $("carousel-grid").innerHTML = "";
  $("subtitle-panel").classList.add("hidden");
  $("subtitle-tracks").innerHTML = "";
}

async function inspectFirst({ silent = false } = {}) {
  const urls = getUrls();
  if (urls.length !== 1) {
    resetInspection();
    if (!silent) showMessage("La selección visual y los subtítulos se muestran cuando hay un solo enlace.");
    return null;
  }

  if (!silent) clearMessage();

  try {
    const data = await api("/api/inspect", {
      method: "POST",
      body: JSON.stringify({
        url: urls[0],
        playlist: $("playlist").checked,
      }),
    });

    currentInspection = data;
    renderInspection(data);
    return data;
  } catch (err) {
    resetInspection();
    if (!silent) showMessage(err.message, "error");
    return null;
  }
}

function renderInspection(data) {
  $("title").textContent = data.title || "Contenido";
  $("uploader").textContent = [
    platformLabel(data.platform),
    data.uploader,
  ].filter(Boolean).join(" · ");

  $("playlist-info").textContent = data.is_playlist
    ? `Colección · ${data.entry_count ?? "varios"} elementos`
    : "";

  if (data.thumbnail) {
    $("thumb").src = data.thumbnail;
    $("thumb").style.visibility = "visible";
  } else {
    $("thumb").removeAttribute("src");
    $("thumb").style.visibility = "hidden";
  }

  $("preview").classList.remove("hidden");
  renderCarousel(data.entries || []);
  renderSubtitleTracks(data.subtitles || []);
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

urlsInput.addEventListener("input", () => {
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(() => {
    let urls;
    try {
      urls = getUrls();
    } catch {
      resetInspection();
      return;
    }

    if (urls.length === 1) {
      inspectFirst({ silent: true });
    } else {
      resetInspection();
    }
  }, 900);
});

$("playlist").addEventListener("change", () => {
  try {
    if (getUrls().length === 1) inspectFirst({ silent: true });
  } catch {
    // Nothing to inspect yet.
  }
});

async function startDownloads(mode) {
  clearMessage();

  let urls;
  try {
    urls = getUrls();
  } catch (err) {
    showMessage(err.message, "error");
    return;
  }

  const quality = $("quality").value;
  const playlist = $("playlist").checked;
  const musicMetadata = mode === "mp3" && $("music-metadata").checked;
  let selectedItems = null;

  if (urls.length === 1 && currentInspection?.entries?.length > 1) {
    selectedItems = selectedCarouselItems();
    if (!selectedItems?.length) {
      showMessage("Selecciona al menos un elemento de la publicación.", "error");
      return;
    }
  }

  jobsBox.innerHTML = "";
  jobsBox.classList.remove("hidden");

  for (const timer of jobPollers.values()) clearInterval(timer);
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
          selected_items: urls.length === 1 ? selectedItems : null,
          music_metadata: musicMetadata,
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

  showMessage(
    failed
      ? `${started} descarga(s) iniciada(s); ${failed} enlace(s) rechazado(s).`
      : `${started} descarga(s) iniciada(s). Puedes ver el progreso debajo.`,
    failed ? "error" : "ok",
  );
}

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => startDownloads(button.dataset.mode));
});

$("download-subtitles").addEventListener("click", async () => {
  clearMessage();

  let urls;
  try {
    urls = getUrls();
  } catch (err) {
    showMessage(err.message, "error");
    return;
  }

  if (urls.length !== 1) {
    showMessage("Para elegir idiomas de subtítulos usa un enlace por vez.", "error");
    return;
  }

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

  jobsBox.innerHTML = "";
  jobsBox.classList.remove("hidden");

  try {
    const data = await api("/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: urls[0],
        mode: "subtitles",
        playlist: $("playlist").checked,
        selected_items: selectedItems,
        subtitle_format: $("subtitle-format").value,
        subtitle_languages: languages,
      }),
    });

    createJobCard(data.id, urls[0], 1, 1);
    startPolling(data.id);
    showMessage("Descarga de subtítulos iniciada.", "ok");
  } catch (err) {
    showMessage(err.message, "error");
  }
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
      data.metadata_note,
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
  resetInspection();
  jobsBox.innerHTML = "";
  jobsBox.classList.add("hidden");

  for (const timer of jobPollers.values()) clearInterval(timer);
  jobPollers.clear();

  clearMessage();
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

prefillFromSharedUrl();
