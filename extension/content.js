(() => {
  const ROOT_ID = "tiksave-floating-root";
  if (document.getElementById(ROOT_ID)) return;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <button class="tiksave-fab" type="button" aria-label="Abrir TikSave">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 5v13m0 0 5-5m-5 5-5-5M8 23h16" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <section class="tiksave-panel" hidden>
      <div class="tiksave-panel-head">
        <div class="tiksave-brand">
          <span class="tiksave-brand-icon">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M16 5v13m0 0 5-5m-5 5-5-5M8 23h16" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <div>
            <strong>TikSave</strong>
            <small>Descarga rápida</small>
          </div>
        </div>
        <button class="tiksave-close" type="button" aria-label="Cerrar">×</button>
      </div>

      <label class="tiksave-label">
        Calidad de video
        <select class="tiksave-quality">
          <option value="best">Mejor disponible</option>
          <option value="2160">2160p / 4K</option>
          <option value="1440">1440p</option>
          <option value="1080">1080p</option>
          <option value="720">720p</option>
          <option value="480">480p</option>
          <option value="360">360p</option>
        </select>
      </label>

      <label class="tiksave-check tiksave-collection-row">
        <input class="tiksave-collection" type="checkbox">
        <span>
          <strong class="tiksave-collection-title">Descargar lista completa</strong>
          <small class="tiksave-collection-help">Úsalo para playlists o colecciones.</small>
        </span>
      </label>

      <label class="tiksave-check tiksave-metadata-row">
        <input class="tiksave-metadata" type="checkbox" checked>
        <span>
          <strong>Completar datos de la canción</strong>
          <small>Para MP3: artista, álbum y portada.</small>
        </span>
      </label>

      <div class="tiksave-actions">
        <button data-tiksave-mode="video" class="tiksave-primary" type="button">Video MP4</button>
        <button data-tiksave-mode="mp3" type="button">MP3</button>
        <button data-tiksave-mode="audio" type="button">Solo audio</button>
      </div>

      <section class="tiksave-progress" hidden>
        <div class="tiksave-progress-head">
          <div>
            <strong class="tiksave-progress-title">Descargando…</strong>
            <small class="tiksave-progress-status">Preparando</small>
          </div>
          <strong class="tiksave-progress-percent">0%</strong>
        </div>
        <div class="tiksave-track"><div class="tiksave-bar"></div></div>
        <div class="tiksave-progress-details"></div>
        <button class="tiksave-folder" type="button" hidden>Abrir carpeta</button>
      </section>

      <button class="tiksave-more" type="button">Más opciones, carruseles y subtítulos</button>
      <div class="tiksave-status" aria-live="polite"></div>
    </section>
  `;

  document.documentElement.appendChild(root);

  const fab = root.querySelector(".tiksave-fab");
  const panel = root.querySelector(".tiksave-panel");
  const close = root.querySelector(".tiksave-close");
  const quality = root.querySelector(".tiksave-quality");
  const collection = root.querySelector(".tiksave-collection");
  const collectionTitle = root.querySelector(".tiksave-collection-title");
  const collectionHelp = root.querySelector(".tiksave-collection-help");
  const metadata = root.querySelector(".tiksave-metadata");
  const metadataRow = root.querySelector(".tiksave-metadata-row");
  const status = root.querySelector(".tiksave-status");
  const more = root.querySelector(".tiksave-more");
  const progress = root.querySelector(".tiksave-progress");
  const progressTitle = root.querySelector(".tiksave-progress-title");
  const progressStatus = root.querySelector(".tiksave-progress-status");
  const progressPercent = root.querySelector(".tiksave-progress-percent");
  const progressBar = root.querySelector(".tiksave-bar");
  const progressDetails = root.querySelector(".tiksave-progress-details");
  const folder = root.querySelector(".tiksave-folder");

  let activeJobId = null;
  let pollTimer = null;

  function currentUrl() {
    return window.location.href;
  }

  function isYouTube() {
    return /(^|\.)youtube\.com$|^youtu\.be$/i.test(location.hostname);
  }

  function isYouTubeChannel() {
    if (!isYouTube()) return false;
    return (
      /^\/@[^/]+(?:\/(?:videos|shorts|streams|releases))?\/?$/.test(location.pathname) ||
      /^\/(?:channel|c|user)\/[^/]+(?:\/(?:videos|shorts|streams|releases))?\/?$/.test(location.pathname)
    );
  }

  function updateContext() {
    metadataRow.hidden = !isYouTube();

    if (isYouTubeChannel()) {
      collection.checked = true;
      collectionTitle.textContent = "Descargar canal completo";
      collectionHelp.textContent = "Incluye los videos disponibles de este canal.";
    } else {
      collectionTitle.textContent = "Descargar lista completa";
      collectionHelp.textContent = "Úsalo para playlists o colecciones.";
    }
  }

  function say(text, type = "") {
    status.textContent = text;
    status.dataset.type = type;
  }

  function statusLabel(value) {
    return {
      queued: "En cola",
      starting: "Preparando",
      downloading: "Descargando",
      processing: "Procesando",
      done: "Terminado",
      error: "Error",
    }[value] || value;
  }

  async function send(message) {
    return browser.runtime.sendMessage(message);
  }

  function renderJob(job) {
    if (!job) return;

    activeJobId = job.id;
    progress.hidden = false;

    const pct = Number(job.progress || 0);
    progressPercent.textContent = `${pct.toFixed(pct % 1 ? 1 : 0)}%`;
    progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    progressTitle.textContent = job.title || "Descarga de TikSave";
    progressStatus.textContent = statusLabel(job.status);
    progressDetails.textContent = [
      job.speed,
      job.eta && `ETA ${job.eta}`,
      job.metadata_note,
      job.filename,
      job.error,
    ].filter(Boolean).join(" · ");

    const finished = job.status === "done";
    folder.hidden = !finished;

    if (finished) {
      say("Archivo listo.", "ok");
      stopPolling();
    } else if (job.status === "error") {
      say(job.error || "No se pudo descargar.", "error");
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
    pollTimer = setInterval(refreshJob, 800);
    refreshJob();
  }

  function stopPolling(clearId = false) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (clearId) activeJobId = null;
  }

  async function quickDownload(mode) {
    say("Iniciando…");

    try {
      const job = await send({
        type: "startDownload",
        payload: {
          url: currentUrl(),
          mode,
          quality: quality.value,
          playlist: collection.checked,
          music_metadata: mode === "mp3" && metadata.checked && isYouTube(),
        },
      });

      renderJob(job);
      startPolling(job.id);
    } catch (error) {
      say(error?.message || "Abre TikSave en tu computadora y vuelve a intentarlo.", "error");
    }
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "jobUpdate" && message.job?.id === activeJobId) {
      renderJob(message.job);
    }
  });

  fab.addEventListener("click", async () => {
    updateContext();
    panel.hidden = false;
    fab.hidden = true;
    say("");

    try {
      await send({ type: "health" });
      const active = await send({ type: "getActiveJobs" });
      if (active?.length) {
        renderJob(active[0]);
        startPolling(active[0].id);
      }
    } catch {
      say("Abre TikSave en tu computadora para descargar.", "error");
    }
  });

  close.addEventListener("click", () => {
    panel.hidden = true;
    fab.hidden = false;
  });

  root.querySelectorAll("[data-tiksave-mode]").forEach((button) => {
    button.addEventListener("click", () => quickDownload(button.dataset.tiksaveMode));
  });

  folder.addEventListener("click", async () => {
    try {
      await send({ type: "openFolder" });
    } catch (error) {
      say(error?.message || "No se pudo abrir la carpeta.", "error");
    }
  });

  more.addEventListener("click", async () => {
    try {
      await send({ type: "health" });
      window.open(
        `http://127.0.0.1:8173/?url=${encodeURIComponent(currentUrl())}`,
        "_blank",
        "noopener,noreferrer",
      );
      say("Opciones abiertas en TikSave.", "ok");
    } catch {
      say("Primero abre TikSave en tu computadora.", "error");
    }
  });

  updateContext();
})();
