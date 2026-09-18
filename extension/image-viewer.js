(() => {
  const ROOT_ID = "tiksave-image-viewer";

  let root = null;
  let image = null;
  let viewport = null;
  let info = null;
  let counter = null;
  let prevButton = null;
  let nextButton = null;
  let downloadAllButton = null;
  let items = [];
  let currentIndex = 0;
  let currentUrl = "";
  let pageUrl = "";
  let currentNote = "";
  let zoom = 1;
  let naturalWidth = 0;
  let naturalHeight = 0;
  let loadToken = 0;
  const zoomByIndex = new Map();

  function buttonStyle(width = "30px") {
    return [
      `min-width:${width}`,
      "height:30px",
      "padding:0 9px",
      "border:1px solid #464b55",
      "border-radius:8px",
      "background:#25282f",
      "color:#fff",
      "font:700 10px/1 inherit",
      "cursor:pointer",
    ].join(";");
  }

  function ensureViewer() {
    if (root && document.documentElement.contains(root)) return root;

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:none",
      "background:rgba(8,9,12,.94)",
      "backdrop-filter:blur(10px)",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "color:#fff",
    ].join(";");

    root.innerHTML = `
      <div data-ts-toolbar style="
        position:absolute;left:12px;right:12px;top:12px;z-index:3;
        display:flex;align-items:center;justify-content:space-between;gap:10px;
        min-height:44px;padding:7px 9px;border:1px solid rgba(255,255,255,.15);
        border-radius:12px;background:rgba(17,19,24,.92);box-shadow:0 12px 35px rgba(0,0,0,.35);
      ">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <button data-ts-close aria-label="Cerrar" style="
            width:30px;height:30px;padding:0;border:1px solid #464b55;border-radius:8px;
            background:#25282f;color:#fff;font:700 18px/1 inherit;cursor:pointer
          ">×</button>
          <div style="min-width:0">
            <strong style="display:block;font-size:11px">TikSave · Imagen original</strong>
            <span data-ts-info style="
              display:block;margin-top:2px;color:#aeb5bf;font-size:9px;
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38vw
            ">Cargando…</span>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:5px;flex:none">
          <div data-ts-nav style="display:flex;align-items:center;gap:4px">
            <button data-ts-prev title="Anterior (←)" style="${buttonStyle()}">←</button>
            <span data-ts-counter style="
              min-width:42px;text-align:center;color:#d9dde5;font:700 10px/1 inherit
            ">1 / 1</span>
            <button data-ts-next title="Siguiente (→)" style="${buttonStyle()}">→</button>
          </div>
          <button data-ts-minus title="Alejar" style="${buttonStyle()}">−</button>
          <button data-ts-fit title="Ajustar a pantalla" style="${buttonStyle("auto")}">Ajustar</button>
          <button data-ts-actual title="Tamaño real" style="${buttonStyle("auto")}">100%</button>
          <button data-ts-plus title="Acercar" style="${buttonStyle()}">+</button>
          <button data-ts-download title="Descargar imagen actual" style="${buttonStyle("auto")}">Descargar</button>
          <button data-ts-download-all title="Descargar todas" style="${buttonStyle("auto")}">Todas</button>
          <button data-ts-tab title="Abrir en pestaña" style="${buttonStyle("auto")}">Pestaña</button>
        </div>
      </div>

      <div data-ts-viewport style="
        position:absolute;inset:0;overflow:auto;padding:72px 20px 24px;
        display:flex;align-items:flex-start;justify-content:center;
      ">
        <img data-ts-image alt="" draggable="false" style="
          display:block;max-width:none;max-height:none;object-fit:contain;
          box-shadow:0 18px 70px rgba(0,0,0,.55);user-select:none
        ">
      </div>
    `;

    document.documentElement.appendChild(root);

    image = root.querySelector("[data-ts-image]");
    viewport = root.querySelector("[data-ts-viewport]");
    info = root.querySelector("[data-ts-info]");
    counter = root.querySelector("[data-ts-counter]");
    prevButton = root.querySelector("[data-ts-prev]");
    nextButton = root.querySelector("[data-ts-next]");
    downloadAllButton = root.querySelector("[data-ts-download-all]");

    root.querySelector("[data-ts-close]").addEventListener("click", close);
    root.querySelector("[data-ts-minus]").addEventListener("click", () => setZoom(zoom / 1.2));
    root.querySelector("[data-ts-plus]").addEventListener("click", () => setZoom(zoom * 1.2));
    root.querySelector("[data-ts-fit]").addEventListener("click", fit);
    root.querySelector("[data-ts-actual]").addEventListener("click", () => setZoom(1));
    prevButton.addEventListener("click", () => navigate(-1));
    nextButton.addEventListener("click", () => navigate(1));

    root.querySelector("[data-ts-tab]").addEventListener("click", () => {
      if (currentUrl) {
        browser.runtime.sendMessage({ type: "openImageInTab", url: currentUrl }).catch(() => {});
      }
    });

    root.querySelector("[data-ts-download]").addEventListener("click", () => {
      if (currentUrl) {
        browser.runtime.sendMessage({ type: "downloadDirectImage", url: currentUrl }).catch(() => {});
      }
    });

    downloadAllButton.addEventListener("click", () => {
      const urls = items
        .map((item) => item.resolvedUrl || item.url)
        .filter((url) => /^https?:\/\//i.test(url || ""));
      if (!urls.length) return;

      browser.runtime.sendMessage({
        type: "downloadImages",
        payload: {
          images: urls,
          platform: "viewer",
          page_url: pageUrl || location.href,
        },
      }).catch(() => {});
    });

    root.addEventListener("click", (event) => {
      if (event.target === root || event.target === viewport) close();
    });

    viewport.addEventListener(
      "wheel",
      (event) => {
        if (!image?.src) return;
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        setZoom(zoom * factor, {
          clientX: event.clientX,
          clientY: event.clientY,
        });
      },
      { passive: false },
    );

    document.addEventListener("keydown", (event) => {
      if (!root || root.style.display === "none") return;

      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigate(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        navigate(1);
      }
      if (event.key === "+" || event.key === "=") setZoom(zoom * 1.2);
      if (event.key === "-") setZoom(zoom / 1.2);
      if (event.key === "0") fit();
    });

    return root;
  }

  function normalizeItems(message) {
    const raw = Array.isArray(message?.items) && message.items.length
      ? message.items
      : Array.isArray(message?.urls) && message.urls.length
        ? message.urls
        : [message?.url];

    const seen = new Set();
    const normalized = [];

    for (const value of raw) {
      const item = typeof value === "string" ? { url: value } : { ...(value || {}) };
      const url = String(item.url || "").trim();
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      normalized.push({ ...item, url });
    }

    return normalized;
  }

  function updateNavigation() {
    const count = items.length || 1;
    if (counter) counter.textContent = `${Math.min(currentIndex + 1, count)} / ${count}`;

    const multiple = items.length > 1;
    if (prevButton) {
      prevButton.disabled = !multiple || currentIndex <= 0;
      prevButton.style.opacity = prevButton.disabled ? ".4" : "1";
    }
    if (nextButton) {
      nextButton.disabled = !multiple || currentIndex >= items.length - 1;
      nextButton.style.opacity = nextButton.disabled ? ".4" : "1";
    }
    if (downloadAllButton) downloadAllButton.style.display = multiple ? "" : "none";
  }

  function updateInfo(extra = "") {
    if (!info) return;
    const dims = naturalWidth && naturalHeight ? `${naturalWidth}×${naturalHeight}` : "Cargando";
    const pct = naturalWidth ? `${Math.round(zoom * 100)}%` : "";
    info.textContent = [dims, pct, extra].filter(Boolean).join(" · ");
  }

  function computeFit() {
    if (!naturalWidth || !naturalHeight) return 1;
    const maxW = Math.max(240, window.innerWidth - 48);
    const maxH = Math.max(180, window.innerHeight - 96);
    return Math.min(1, maxW / naturalWidth, maxH / naturalHeight);
  }

  function applyZoom() {
    if (!image || !naturalWidth || !naturalHeight) return;
    image.style.width = `${Math.max(1, Math.round(naturalWidth * zoom))}px`;
    image.style.height = `${Math.max(1, Math.round(naturalHeight * zoom))}px`;
    zoomByIndex.set(currentIndex, zoom);
    updateInfo(currentNote);
  }

  function setZoom(value, anchor = null) {
    if (!naturalWidth) return;
    const oldZoom = zoom;
    zoom = Math.min(8, Math.max(0.05, value));

    let oldX = 0;
    let oldY = 0;
    if (anchor && viewport) {
      oldX = viewport.scrollLeft + anchor.clientX;
      oldY = viewport.scrollTop + anchor.clientY;
    }

    applyZoom();

    if (anchor && viewport && oldZoom > 0) {
      const ratio = zoom / oldZoom;
      viewport.scrollLeft = oldX * ratio - anchor.clientX;
      viewport.scrollTop = oldY * ratio - anchor.clientY;
    }
  }

  function fit() {
    zoom = computeFit();
    applyZoom();
    if (viewport) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
  }

  function preloadNeighbors() {
    for (const index of [currentIndex - 1, currentIndex + 1]) {
      const item = items[index];
      const url = item?.resolvedUrl || item?.url;
      if (!url) continue;
      const preload = new Image();
      preload.src = url;
    }
  }

  async function resolveCurrent(index, sourceUrl, token) {
    try {
      const result = await browser.runtime.sendMessage({
        type: "resolveViewerImage",
        url: sourceUrl,
        pageUrl: pageUrl || location.href,
      });

      if (token !== loadToken || index !== currentIndex) return;
      const target = result?.best?.final_url || result?.best?.url;
      if (!target || target === currentUrl) return;

      items[index].resolvedUrl = target;
      loadImage(index, {
        note: result?.best?.width && result?.best?.height
          ? `${result.best.width}×${result.best.height} · máxima encontrada`
          : "Máxima variante encontrada",
        resolve: false,
      });
    } catch {
      // Keep the detected image if the local service is unavailable.
    }
  }

  function loadImage(index, { note = "", resolve = true } = {}) {
    ensureViewer();
    if (!items.length || index < 0 || index >= items.length) return;

    currentIndex = index;
    currentNote = note;
    const item = items[index];
    currentUrl = item.resolvedUrl || item.url;
    const token = ++loadToken;

    root.style.display = "block";
    document.documentElement.style.setProperty("overflow", "hidden", "important");

    naturalWidth = 0;
    naturalHeight = 0;
    info.textContent = note || "Cargando imagen…";
    image.style.width = "auto";
    image.style.height = "auto";
    image.removeAttribute("src");
    updateNavigation();

    image.onload = () => {
      if (token !== loadToken) return;
      naturalWidth = image.naturalWidth || 0;
      naturalHeight = image.naturalHeight || 0;

      const savedZoom = zoomByIndex.get(index);
      if (Number.isFinite(savedZoom)) {
        zoom = savedZoom;
        applyZoom();
      } else {
        fit();
      }

      updateInfo(currentNote);
      preloadNeighbors();
    };

    image.onerror = () => {
      if (token !== loadToken) return;
      info.textContent = "No pude cargar esta variante. TikSave intentará otra si está disponible.";
      browser.runtime.sendMessage({
        type: "imageOverlayLoadFailed",
        url: currentUrl,
      }).catch(() => {});
    };

    image.src = currentUrl;
    if (resolve && item.url) resolveCurrent(index, item.url, token);
  }

  function navigate(delta) {
    const next = currentIndex + delta;
    if (next < 0 || next >= items.length) return;
    loadImage(next, { note: "" });
  }

  function show(message) {
    ensureViewer();
    items = normalizeItems(message);
    pageUrl = String(message?.pageUrl || location.href || "");
    currentNote = String(message?.note || "");
    zoomByIndex.clear();
    if (!items.length) return;

    const requested = Number(message?.index);
    currentIndex = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 0), items.length - 1)
      : 0;
    loadImage(currentIndex, { note: currentNote });
  }

  function update(url, note = "") {
    if (!root || root.style.display === "none" || !items.length) {
      show({ url, note, pageUrl: location.href });
      return;
    }

    const target = String(url || "");
    if (!target) return;
    items[currentIndex].resolvedUrl = target;
    loadImage(currentIndex, { note, resolve: false });
  }

  function close() {
    if (!root) return;
    ++loadToken;
    root.style.display = "none";
    image?.removeAttribute("src");
    document.documentElement.style.removeProperty("overflow");
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "showImageOverlay") {
      show(message);
      return { ok: true };
    }
    if (message?.type === "updateImageOverlay") {
      update(message.url, message.note || "");
      return { ok: true };
    }
    if (message?.type === "closeImageOverlay") {
      close();
      return { ok: true };
    }
    return undefined;
  });
})();
