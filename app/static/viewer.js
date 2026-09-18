const $ = (id) => document.getElementById(id);

const jobId = decodeURIComponent(
  location.pathname.split("/").filter(Boolean).pop() || "",
);

let timer = null;
let zoom = 1;
let fitZoom = 1;
let naturalWidth = 0;
let naturalHeight = 0;
let panFrame = 0;
let panTargetX = 0;
let panTargetY = 0;
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragScrollX = 0;
let dragScrollY = 0;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `Error ${response.status}`);
  return data;
}

function viewportPoint(clientX, clientY) {
  const rect = $("viewport").getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function updatePanMode() {
  const viewport = $("viewport");
  const hint = $("pan-hint");
  const canPan =
    !$("image").classList.contains("hidden") &&
    (viewport.scrollWidth > viewport.clientWidth + 2 ||
      viewport.scrollHeight > viewport.clientHeight + 2);

  viewport.classList.toggle("pannable", canPan);
  hint.classList.toggle("hidden", !canPan);
}

function applyZoom() {
  if (!naturalWidth || !naturalHeight) return;
  const image = $("image");
  image.style.width = `${Math.max(1, Math.round(naturalWidth * zoom))}px`;
  image.style.height = `${Math.max(1, Math.round(naturalHeight * zoom))}px`;
  $("zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  requestAnimationFrame(updatePanMode);
}

function setZoom(value, anchor = null) {
  if (!naturalWidth || !naturalHeight) return;

  const viewport = $("viewport");
  const oldZoom = zoom;
  const point = anchor
    ? viewportPoint(anchor.clientX, anchor.clientY)
    : { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };

  const oldContentX = viewport.scrollLeft + point.x;
  const oldContentY = viewport.scrollTop + point.y;

  zoom = clamp(value, 0.04, 8);
  applyZoom();

  requestAnimationFrame(() => {
    const ratio = oldZoom > 0 ? zoom / oldZoom : 1;
    viewport.scrollLeft = Math.max(0, oldContentX * ratio - point.x);
    viewport.scrollTop = Math.max(0, oldContentY * ratio - point.y);
    updatePanMode();
  });
}

function fit() {
  if (!naturalWidth || !naturalHeight) return;

  const viewport = $("viewport");
  const maxWidth = Math.max(240, viewport.clientWidth - 48);
  const maxHeight = Math.max(180, viewport.clientHeight - 48);
  fitZoom = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
  zoom = fitZoom;
  applyZoom();

  requestAnimationFrame(() => {
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    updatePanMode();
  });
}

function stopPanAnimation() {
  if (panFrame) cancelAnimationFrame(panFrame);
  panFrame = 0;
}

function animatePan() {
  const viewport = $("viewport");
  const dx = panTargetX - viewport.scrollLeft;
  const dy = panTargetY - viewport.scrollTop;

  viewport.scrollLeft += dx * 0.15;
  viewport.scrollTop += dy * 0.15;

  if (Math.abs(dx) > 0.7 || Math.abs(dy) > 0.7) {
    panFrame = requestAnimationFrame(animatePan);
  } else {
    viewport.scrollLeft = panTargetX;
    viewport.scrollTop = panTargetY;
    panFrame = 0;
  }
}

function panTowardPointer(event) {
  const viewport = $("viewport");
  if (
    dragging ||
    !viewport.classList.contains("pannable") ||
    $("image").classList.contains("hidden")
  ) {
    return;
  }

  const rect = viewport.getBoundingClientRect();
  const edge = 0.10;
  const xRatio = clamp(
    ((event.clientX - rect.left) / rect.width - edge) / (1 - edge * 2),
    0,
    1,
  );
  const yRatio = clamp(
    ((event.clientY - rect.top) / rect.height - edge) / (1 - edge * 2),
    0,
    1,
  );

  panTargetX = Math.max(0, viewport.scrollWidth - viewport.clientWidth) * xRatio;
  panTargetY = Math.max(0, viewport.scrollHeight - viewport.clientHeight) * yRatio;

  if (!panFrame) panFrame = requestAnimationFrame(animatePan);
}

function startDrag(event) {
  const viewport = $("viewport");
  if (
    event.button !== 0 ||
    !viewport.classList.contains("pannable") ||
    event.target.closest(".viewer-bar")
  ) {
    return;
  }

  dragging = true;
  stopPanAnimation();
  viewport.classList.add("dragging");
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragScrollX = viewport.scrollLeft;
  dragScrollY = viewport.scrollTop;
  viewport.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function drag(event) {
  if (!dragging) {
    panTowardPointer(event);
    return;
  }

  const viewport = $("viewport");
  viewport.scrollLeft = dragScrollX - (event.clientX - dragStartX);
  viewport.scrollTop = dragScrollY - (event.clientY - dragStartY);
}

function stopDrag(event) {
  if (!dragging) return;
  dragging = false;
  $("viewport").classList.remove("dragging");
  $("viewport").releasePointerCapture?.(event.pointerId);
}

function done(job) {
  clearInterval(timer);
  timer = null;
  $("working").classList.add("hidden");
  $("error").classList.add("hidden");
  $("cancel").classList.add("hidden");

  const image = $("image");
  image.onload = () => {
    naturalWidth = image.naturalWidth || 0;
    naturalHeight = image.naturalHeight || 0;
    $("phase").textContent =
      `${naturalWidth} × ${naturalHeight} · ${job.title || "Imagen lista"}`;
    fit();
  };
  image.src = `/api/jobs/${encodeURIComponent(jobId)}/file?t=${Date.now()}`;
  image.classList.remove("hidden");
}

function render(job) {
  $("phase").textContent = job.phase || job.status || "Procesando";
  $("working-title").textContent = job.phase || "Reconstruyendo máxima resolución";
  $("detail").textContent =
    job.metadata_note || "TikSave está descargando y uniendo los mosaicos.";
  $("filename").textContent = job.filename
    ? job.filename.split(/[\\/]/).pop()
    : "";

  $("cancel").disabled =
    !job.can_cancel || ["done", "error", "cancelled"].includes(job.status);

  const bar = $("progress-bar");
  if (job.progress_mode === "indeterminate") {
    bar.classList.add("indeterminate");
    bar.style.width = "";
    $("percent").textContent = "Trabajando…";
  } else {
    bar.classList.remove("indeterminate");
    bar.style.width =
      `${clamp(Number(job.progress || 0), 0, 100)}%`;
    const value = Number(job.progress || 0);
    $("percent").textContent =
      `${value.toFixed(value % 1 ? 1 : 0)}%`;
  }

  if (job.status === "done") {
    done(job);
  } else if (job.status === "error" || job.status === "cancelled") {
    clearInterval(timer);
    timer = null;
    $("working").classList.add("hidden");
    $("image").classList.add("hidden");
    $("error").textContent =
      job.status === "cancelled"
        ? "Trabajo cancelado."
        : job.error || "El trabajo terminó con un error.";
    $("error").classList.remove("hidden");
    $("cancel").disabled = true;
  }
}

async function refresh() {
  try {
    render(await api(`/api/jobs/${encodeURIComponent(jobId)}`));
  } catch (error) {
    clearInterval(timer);
    $("working").classList.add("hidden");
    $("error").textContent = error.message;
    $("error").classList.remove("hidden");
  }
}

$("minus").addEventListener("click", () => setZoom(zoom / 1.2));
$("plus").addEventListener("click", () => setZoom(zoom * 1.2));
$("actual").addEventListener("click", () => setZoom(1));
$("fit").addEventListener("click", fit);
$("open-folder").addEventListener("click", () => {
  api("/api/open-folder", { method: "POST" }).catch(() => {});
});

$("cancel").addEventListener("click", async () => {
  $("cancel").disabled = true;
  try {
    render(
      await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
      }),
    );
  } catch {
    $("cancel").disabled = false;
  }
});

const viewport = $("viewport");
viewport.addEventListener(
  "wheel",
  (event) => {
    if ($("image").classList.contains("hidden")) return;
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event);
  },
  { passive: false },
);
viewport.addEventListener("pointerdown", startDrag);
viewport.addEventListener("pointermove", drag);
viewport.addEventListener("pointerup", stopDrag);
viewport.addEventListener("pointercancel", stopDrag);

$("image").addEventListener("dblclick", () => {
  if (Math.abs(zoom - fitZoom) < 0.01) setZoom(1);
  else fit();
});

window.addEventListener("resize", () => {
  if (naturalWidth && naturalHeight && zoom <= fitZoom + 0.01) fit();
  else updatePanMode();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "+" || event.key === "=") setZoom(zoom * 1.2);
  if (event.key === "-") setZoom(zoom / 1.2);
  if (event.key === "0") fit();
});

timer = setInterval(refresh, 500);
refresh();
