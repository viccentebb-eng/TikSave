(() => {
  const API = "http://127.0.0.1:8173";
  const ROOT_ID = "tiksave-floating-root";

  if (document.getElementById(ROOT_ID)) return;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <button class="tiksave-fab" type="button" aria-label="Abrir TikSave">TS</button>
    <section class="tiksave-panel" hidden>
      <div class="tiksave-panel-head">
        <div>
          <strong>TikSave</strong>
          <small>Descarga rápida</small>
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

      <label class="tiksave-check">
        <input class="tiksave-metadata" type="checkbox" checked>
        <span>Completar datos de la canción al bajar MP3</span>
      </label>

      <div class="tiksave-actions">
        <button data-tiksave-mode="video" class="tiksave-primary" type="button">Video MP4</button>
        <button data-tiksave-mode="mp3" type="button">MP3</button>
        <button data-tiksave-mode="audio" type="button">Solo audio</button>
      </div>

      <button class="tiksave-more" type="button">Más opciones y subtítulos</button>
      <div class="tiksave-status" aria-live="polite"></div>
    </section>
  `;

  document.documentElement.appendChild(root);

  const fab = root.querySelector(".tiksave-fab");
  const panel = root.querySelector(".tiksave-panel");
  const close = root.querySelector(".tiksave-close");
  const quality = root.querySelector(".tiksave-quality");
  const metadata = root.querySelector(".tiksave-metadata");
  const status = root.querySelector(".tiksave-status");
  const more = root.querySelector(".tiksave-more");

  function currentUrl() {
    return window.location.href;
  }

  function isYouTube() {
    return /(^|\.)youtube\.com$|^youtu\.be$/i.test(location.hostname);
  }

  function updateContext() {
    metadata.closest(".tiksave-check").hidden = !isYouTube();
  }

  function say(text, type = "") {
    status.textContent = text;
    status.dataset.type = type;
  }

  async function health() {
    const response = await fetch(`${API}/api/health`, { cache: "no-store" });
    if (!response.ok) throw new Error("TikSave no está abierto.");
  }

  async function quickDownload(mode) {
    say("Enviando…");
    try {
      await health();
      const response = await fetch(`${API}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: currentUrl(),
          mode,
          quality: quality.value,
          playlist: false,
          music_metadata: mode === "mp3" && metadata.checked && isYouTube(),
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "No se pudo iniciar la descarga.");

      say("Descarga enviada a TikSave.", "ok");
    } catch (error) {
      say(
        error?.message || "Abre TikSave en tu computadora y vuelve a intentarlo.",
        "error",
      );
    }
  }

  fab.addEventListener("click", () => {
    updateContext();
    panel.hidden = false;
    fab.hidden = true;
    say("");
  });

  close.addEventListener("click", () => {
    panel.hidden = true;
    fab.hidden = false;
  });

  root.querySelectorAll("[data-tiksave-mode]").forEach((button) => {
    button.addEventListener("click", () => quickDownload(button.dataset.tiksaveMode));
  });

  more.addEventListener("click", async () => {
    try {
      await health();
      window.open(
        `${API}/?url=${encodeURIComponent(currentUrl())}`,
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
