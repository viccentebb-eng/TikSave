const $ = (id) => document.getElementById(id);

const urlsInput = $("urls");
const message = $("message");
const jobsBox = $("jobs");
const jobPollers = new Map();

let currentInspection = null;
let inspectTimer = null;

function setAnalysisState(text, type = "") {
  const node = $("analysis-state");
  if (!node) return;
  node.textContent = text;
  node.className = `analysis-state ${type}`.trim();
}

function setStatusPill(id, text, type = "pending") {
  const node = $(id);
  if (!node) return;
  node.className = `status-pill ${type}`;
  node.innerHTML = `<i></i>${escapeHtml(text)}`;
}

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
    douyin: "Douyin",
    youtube: "YouTube",
    instagram: "Instagram",
    facebook: "Facebook",
    web: "Video del navegador",
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
  $("capabilities-panel").classList.add("hidden");
  $("capability-buttons").innerHTML = "";
  $("analysis-notes").classList.add("hidden");
  $("analysis-notes").innerHTML = "";
  $("media-actions").classList.add("hidden");
  $("page-images-panel").classList.add("hidden");
  $("page-images-grid").innerHTML = "";
}

async function inspectFirst({ silent = false } = {}) {
  const urls = getUrls();
  if (urls.length !== 1) {
    resetInspection();
    setAnalysisState(urls.length > 1 ? `${urls.length} enlaces` : "Listo");
    if (!silent) showMessage("La selección visual y los subtítulos se muestran cuando hay un solo enlace.");
    return null;
  }

  if (!silent) clearMessage();

  const inspectButton = $("inspect");
  inspectButton.disabled = true;
  setAnalysisState("Analizando…", "busy");

  try {
    const data = await api("/api/analyze", {
      method: "POST",
      body: JSON.stringify({
        url: urls[0],
        playlist: $("playlist").checked,
      }),
    });

    currentInspection = data;
    renderInspection(data);
    setAnalysisState(data.cached ? "Listo · caché" : "Listo", "ok");
    return data;
  } catch (err) {
    resetInspection();
    setAnalysisState("No analizado", "error");
    if (!silent) showMessage(err.message, "error");
    return null;
  } finally {
    inspectButton.disabled = false;
  }
}

function capabilityIds(data) {
  return new Set((data.capabilities || []).map((item) => item.id));
}

function renderInspection(data) {
  const ids = capabilityIds(data);
  const isTikTokProfile = data.collection_type === "tiktok_profile";

  $("title").textContent = data.title || "Contenido";
  $("uploader").textContent = [
    platformLabel(data.platform),
    data.uploader || data.host,
  ].filter(Boolean).join(" · ");

  $("playlist-info").textContent = data.is_playlist
    ? isTikTokProfile
      ? \`Perfil de TikTok · \${data.entry_count ?? "varios"} videos\`
      : \`Colección · \${data.entry_count ?? "varios"} elementos\`
    : data.kind && data.kind !== "media"
      ? data.kind === "artwork"
        ? "Obra / imagen ampliable"
        : \`Contenido: \${data.kind}\`
      : "";

  if (data.thumbnail) {
    $("thumb").src = data.thumbnail;
    $("thumb").style.visibility = "visible";
  } else {
    $("thumb").removeAttribute("src");
    $("thumb").style.visibility = "hidden";
  }

  $("preview").classList.remove("hidden");

  const hasNativeMedia = ["video", "mp3", "audio"].some((id) => ids.has(id));
  $("media-actions").classList.toggle("hidden", !hasNativeMedia);

  const videoButton = document.querySelector('[data-mode="video"]');
  const mp3Button = document.querySelector('[data-mode="mp3"]');
  const audioButton = document.querySelector('[data-mode="audio"]');

  videoButton.classList.toggle("hidden", !ids.has("video"));
  mp3Button.classList.toggle("hidden", !ids.has("mp3"));
  audioButton.classList.toggle("hidden", !ids.has("audio"));

  if (isTikTokProfile) {
    videoButton.textContent = "Descargar todos los videos";
    mp3Button.textContent = "MP3 de todo el perfil";
    audioButton.textContent = "Audio de todo el perfil";
  } else {
    videoButton.textContent = "Descargar MP4";
    mp3Button.textContent = "Descargar MP3";
    audioButton.textContent = "Solo audio";
  }

  $("quality-control").classList.toggle(
    "hidden",
    !(ids.has("video") || ids.has("web_video")),
  );

  const showPlaylist = data.platform === "youtube" || ids.has("playlist");
  const playlistControl = $("playlist-control");
  const playlistInput = $("playlist");
  const playlistTitle = playlistControl.querySelector("strong");
  const playlistHelp = playlistControl.querySelector("small");

  playlistControl.classList.toggle("hidden", !showPlaylist);
  playlistInput.disabled = isTikTokProfile;

  if (isTikTokProfile) {
    playlistInput.checked = true;
    playlistTitle.textContent = "Descargar perfil completo";
    playlistHelp.textContent = "Incluye todos los videos públicos que TikTok permita enumerar.";
  } else {
    playlistTitle.textContent = "Descargar lista o canal completo";
    playlistHelp.textContent = "Playlists, colecciones y canales compatibles.";
  }

  $("music-control").classList.toggle("hidden", data.platform !== "youtube");

  renderCapabilities(data);
  renderPageImages(data.images || []);
  renderCarousel(isTikTokProfile ? [] : (data.entries || []));
  renderSubtitleTracks(data.subtitles || data.subtitle_tracks || [], data);
}
function renderCapabilities(data) {
  const panel = $("capabilities-panel");
  const box = $("capability-buttons");
  const notes = $("analysis-notes");
  const generic = (data.capabilities || []).filter((cap) =>
    ["web_video", "web_audio", "images", "image_download", "image_max", "dezoom", "collection_subtitles"].includes(cap.id)
  );

  const labels = {
    web_video: "Descargar video",
    web_audio: "Solo audio",
    images: "Ver imágenes encontradas",
    image_download: "Descargar imagen",
    image_max: "Original / máxima resolución",
    dezoom: "Reconstruir mosaicos",
    collection_subtitles: "Todos los subtítulos del perfil",
  };

  if (!generic.length && !(data.capabilities || []).length) {
    panel.classList.remove("hidden");
    box.innerHTML = '<span class="capability-empty">No detecté una descarga directa en esta página.</span>';
  } else if (generic.length) {
    panel.classList.remove("hidden");
    box.innerHTML = generic.map((cap, index) => `
      <button
        class="${index === 0 ? "primary" : "secondary"}"
        data-cap-action="${escapeHtml(cap.id)}"
        data-source-url="${escapeHtml(cap.source_url || "")}"
        data-needs-install="${cap.needs_install ? "1" : "0"}"
      >
        ${escapeHtml(labels[cap.id] || cap.label || cap.id)}
        ${cap.needs_install ? '<small>requiere instalar motor</small>' : cap.id === "image_max" ? '<small>motor nativo de TikSave</small>' : ""}
      </button>
    `).join("");
  } else {
    panel.classList.add("hidden");
    box.innerHTML = "";
  }

  if (data.notes?.length) {
    notes.innerHTML = data.notes.map((note) => `<div>${escapeHtml(note)}</div>`).join("");
    notes.classList.remove("hidden");
    panel.classList.remove("hidden");
  } else {
    notes.classList.add("hidden");
    notes.innerHTML = "";
  }
}

function renderPageImages(images) {
  const panel = $("page-images-panel");
  const grid = $("page-images-grid");

  if (!images.length) {
    panel.classList.add("hidden");
    grid.innerHTML = "";
    return;
  }

  $("page-images-title").textContent = `${images.length} imagen${images.length === 1 ? "" : "es"} encontrada${images.length === 1 ? "" : "s"}`;

  grid.innerHTML = images.map((item, index) => `
    <label class="media-item">
      <input type="checkbox" data-page-image-index="${index}" checked>
      <div class="media-thumb">
        <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.alt || `Imagen ${index + 1}`)}" loading="lazy">
        <span class="media-index">${index + 1}</span>
      </div>
      <span class="media-caption">${escapeHtml(item.source || shortUrl(item.url))}</span>
    </label>
  `).join("");

  panel.classList.remove("hidden");
}

function selectedPageImages() {
  if (!currentInspection?.images?.length) return [];
  return [...document.querySelectorAll("[data-page-image-index]:checked")]
    .map((input) => currentInspection.images[Number(input.dataset.pageImageIndex)])
    .filter(Boolean);
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

function renderSubtitleTracks(tracks, data = null) {
  const panel = $("subtitle-panel");
  const box = $("subtitle-tracks");
  let visibleTracks = [...tracks];

  if (data?.collection_type === "tiktok_profile") {
    visibleTracks = [
      {
        code: "all",
        name: "Todos los subtítulos disponibles",
        automatic: false,
        formats: [],
        bulk: true,
      },
      ...visibleTracks.filter((track) => track.code !== "all"),
    ];
  }

  if (!visibleTracks.length) {
    panel.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  box.innerHTML = visibleTracks.map((track, index) => \`
    <label class="subtitle-track" data-subtitle-filter="\${escapeHtml(
      \`\${track.code} \${track.name} \${track.bulk ? "todos perfil" : track.automatic ? "automatico auto" : "manual"}\`.toLowerCase()
    )}">
      <input type="checkbox" data-subtitle-code="\${escapeHtml(track.code)}" \${index === 0 ? "checked" : ""}>
      <span>
        <strong>\${escapeHtml(track.name || track.code)}</strong>
        <small>\${
          track.bulk
            ? "todos los videos del perfil · manuales y automáticos cuando existan"
            : \`\${escapeHtml(track.code)} · \${track.automatic ? "generado automáticamente" : "incluido por el autor"}\${track.formats?.length ? \` · \${escapeHtml(track.formats.join(", "))}\` : ""}\`
        }</small>
      </span>
    </label>
  \`).join("");

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

$("select-all-page-images").addEventListener("click", () => {
  document.querySelectorAll("[data-page-image-index]").forEach((input) => {
    input.checked = true;
  });
});

$("select-no-page-images").addEventListener("click", () => {
  document.querySelectorAll("[data-page-image-index]").forEach((input) => {
    input.checked = false;
  });
});

$("download-page-images").addEventListener("click", async () => {
  const selected = selectedPageImages();
  if (!selected.length) {
    showMessage("Selecciona al menos una imagen.", "error");
    return;
  }

  try {
    showMessage(`Descargando ${selected.length} imagen${selected.length === 1 ? "" : "es"}…`);
    const urls = getUrls();
    const result = await api("/api/images/download", {
      method: "POST",
      body: JSON.stringify({
        urls: selected.map((item) => item.url),
        page_url: urls.length === 1 ? urls[0] : null,
      }),
    });
    showMessage(`${result.count} imagen${result.count === 1 ? "" : "es"} guardada${result.count === 1 ? "" : "s"} en TikSave/Images.`, "ok");
  } catch (err) {
    showMessage(err.message, "error");
  }
});

$("capability-buttons").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cap-action]");
  if (!button || !currentInspection) return;

  const action = button.dataset.capAction;
  const sourceUrl = button.dataset.sourceUrl || "";
  let urls;

  try {
    urls = getUrls();
  } catch (err) {
    showMessage(err.message, "error");
    return;
  }

  if (urls.length !== 1) {
    showMessage("Estas opciones se usan con un enlace a la vez.", "error");
    return;
  }

  try {
    if (action === "images") {
      $("page-images-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }

    if (action === "collection_subtitles") {
      $("subtitle-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }

    if (action === "image_download") {
      const result = await api("/api/images/download", {
        method: "POST",
        body: JSON.stringify({
          urls: [sourceUrl || currentInspection.final_url || urls[0]],
          page_url: urls[0],
        }),
      });
      showMessage(`Imagen guardada: ${result.files?.[0] || "TikSave/Images"}`, "ok");
      return;
    }

    if (action === "image_max") {
      showMessage("TikSave está probando variantes de mayor resolución…");
      const result = await api("/api/image/download", {
        method: "POST",
        body: JSON.stringify({
          url: sourceUrl || currentInspection.images?.[0]?.url || urls[0],
          page_url: urls[0],
        }),
      });
      const resolution = result.resolution?.filter(Boolean).length === 2
        ? ` · ${result.resolution[0]}×${result.resolution[1]}`
        : "";
      showMessage(`Imagen guardada: ${result.path}${resolution}`, "ok");
      return;
    }

    if (action === "dezoom") {
      if (button.dataset.needsInstall === "1") {
        showMessage("Instalando el motor de mosaicos la primera vez…");
        await api("/api/dezoom/install", { method: "POST", body: "{}" });
        button.dataset.needsInstall = "0";
      }

      const data = await api("/api/dezoom/download", {
        method: "POST",
        body: JSON.stringify({
          source_url: sourceUrl || currentInspection.zoom_sources?.[0]?.url,
          page_url: urls[0],
          output_format: "jpg",
        }),
      });

      jobsBox.innerHTML = "";
      jobsBox.classList.remove("hidden");
      createJobCard(data.id, urls[0], 1, 1);
      startPolling(data.id);
      showMessage("Reconstrucción de alta resolución iniciada.", "ok");
      return;
    }

    if (action === "web_video" || action === "web_audio") {
      const data = await api("/api/browser-media", {
        method: "POST",
        body: JSON.stringify({
          page_url: urls[0],
          media_url: sourceUrl || null,
          mode: action === "web_video" ? "video" : "audio",
          quality: $("quality").value,
        }),
      });

      jobsBox.innerHTML = "";
      jobsBox.classList.remove("hidden");
      createJobCard(data.id, urls[0], 1, 1);
      startPolling(data.id);
      showMessage("Descarga iniciada.", "ok");
    }
  } catch (err) {
    showMessage(err.message, "error");
  }
});

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
  }, 550);
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
  const playlist = $("playlist").checked || currentInspection?.collection_type === "tiktok_profile";
  const musicMetadata = mode === "mp3" && $("music-metadata").checked;
  let selectedItems = null;

  if (
    urls.length === 1 &&
    currentInspection?.collection_type !== "tiktok_profile" &&
    currentInspection?.entries?.length > 1
  ) {
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
  if (
    currentInspection.collection_type !== "tiktok_profile" &&
    currentInspection.entries?.length > 1
  ) {
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
        playlist: $("playlist").checked || currentInspection?.collection_type === "tiktok_profile",
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
  setAnalysisState("Listo");
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

$("open-log").addEventListener("click", async () => {
  try {
    const result = await api("/api/diagnostics/open-log", { method: "POST", body: "{}" });
    showMessage(`Log abierto: ${result.path}`, "ok");
  } catch (err) {
    showMessage(err.message, "error");
  }
});



async function loadSystemStatus() {
  try {
    const health = await api("/api/health");

    setStatusPill("status-app", `TikSave ${health.version || ""}`.trim(), "ok");
    setStatusPill("status-image", "Imagen nativa", health.native_image?.installed ? "ok" : "bad");
    setStatusPill(
      "status-dezoom",
      health.dezoomify?.installed ? "Dezoomify listo" : "Dezoomify pendiente",
      health.dezoomify?.installed ? "ok" : "warn",
    );
    setStatusPill(
      "status-ffmpeg",
      health.ffmpeg?.installed ? "FFmpeg listo" : "FFmpeg pendiente",
      health.ffmpeg?.installed ? "ok" : "warn",
    );
  } catch (err) {
    setStatusPill("status-app", "TikSave sin conexión", "bad");
    setStatusPill("status-image", "Imagen nativa", "pending");
    setStatusPill("status-dezoom", "Dezoomify", "pending");
    setStatusPill("status-ffmpeg", "FFmpeg", "pending");
  }
}

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

loadSystemStatus();
prefillFromSharedUrl();
