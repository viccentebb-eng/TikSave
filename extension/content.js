// Boton flotante "Guardar" sobre los videos. Se inyecta en todas las paginas (con permiso del usuario).
(() => {
  if (window.__tiksaveFloat) return;
  window.__tiksaveFloat = true;
  const ext = globalThis.browser ?? globalThis.chrome;
  const MIN_W = 200, MIN_H = 120;
  const VIDEO_LINK = /\/(video|videos|reel|reels|shorts|status|watch|clip|clips)\/|[?&]v=/i;
  let enabled = true;
  let current = null; // <video> sobre el que esta el boton
  let menuOpen = false;
  let hideTimer = null;
  let activeJob = null;

  ext.storage.local.get({ floatEnabled: true }).then((v) => { enabled = v.floatEnabled !== false; }, () => {});
  ext.storage.onChanged.addListener((changes) => { if (changes.floatEnabled) { enabled = changes.floatEnabled.newValue !== false; if (!enabled) hide(); } });

  // ---------- interfaz (shadow DOM cerrado: la pagina no puede tocarla) ----------
  const host = document.createElement("tiksave-float");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host{all:initial}
      .wrap{position:fixed;display:none;font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff}
      .btn{display:flex;align-items:center;gap:7px;border:0;border-radius:99px;padding:8px 13px 8px 10px;cursor:pointer;color:#fff;
        background:linear-gradient(135deg,#fe2c55,#ff6a3d);box-shadow:0 4px 18px rgba(0,0,0,.45);font:inherit}
      .btn:hover{filter:brightness(1.1)}
      svg{width:16px;height:16px}
      .menu{margin-top:6px;background:#1b1d24;border:1px solid #343844;border-radius:12px;padding:5px;min-width:210px;box-shadow:0 10px 30px rgba(0,0,0,.5);display:none}
      .menu.open{display:block}
      .item{display:block;width:100%;text-align:left;background:none;border:0;color:#f2f4f8;padding:9px 11px;border-radius:8px;cursor:pointer;font:inherit}
      .item:hover{background:#2a2e3a}
      .item small{display:block;color:#98a1b3;font-weight:500;margin-top:2px}
      .done{background:linear-gradient(135deg,#1fa971,#3ddc97)} .err{background:#c62840}
    </style>
    <div class="wrap" id="wrap">
      <button class="btn" id="btn" type="button" aria-label="Guardar este video con TikSave">
        <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span id="label">Guardar</span>
      </button>
      <div class="menu" id="menu" role="menu">
        <button class="item" data-mode="video" role="menuitem">Video (MP4)</button>
        <button class="item" data-mode="video-here" id="here" role="menuitem">Desde aquí hasta el final<small id="here-t"></small></button>
        <button class="item" data-mode="mp3" role="menuitem">Solo audio (MP3)</button>
        <button class="item" data-mode="transcript" role="menuitem">Kit para IA<small>texto + ficha + portada</small></button>
        <button class="item" data-mode="record" role="menuitem">Grabar mientras se reproduce<small>para videos que no se pueden bajar (blob)</small></button>
        <button class="item" data-mode="record-start" role="menuitem">Grabar desde el inicio</button>
      </div>
    </div>`;
  const $ = (id) => root.getElementById(id);
  const wrap = $("wrap"), btn = $("btn"), label = $("label"), menu = $("menu");

  function attach() { if (!host.isConnected) (document.documentElement || document).appendChild(host); }

  // ---------- posicion ----------
  function place() {
    if (!current || !current.isConnected) return hide();
    const r = current.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H || r.bottom < 0 || r.top > innerHeight) return hide();
    wrap.style.display = "block";
    wrap.style.left = `${Math.max(6, Math.min(innerWidth - 150, r.right - 140))}px`;
    wrap.style.top = `${Math.max(6, r.top + 10)}px`;
  }
  function hide() { if (menuOpen) return; wrap.style.display = "none"; current = null; }
  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 1400); }

  let last = 0;
  document.addEventListener("mousemove", (ev) => {
    if (!enabled) return;
    const now = Date.now();
    if (now - last < 90) return;
    last = now;
    if (ev.composedPath().includes(host)) { clearTimeout(hideTimer); return; }
    const video = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el instanceof HTMLVideoElement);
    if (video) {
      const r = video.getBoundingClientRect();
      if (r.width >= MIN_W && r.height >= MIN_H) {
        attach(); clearTimeout(hideTimer); current = video; place(); scheduleHide(); return;
      }
    }
    if (current) scheduleHide();
  }, { passive: true });
  addEventListener("scroll", () => current && place(), { passive: true, capture: true });
  addEventListener("resize", () => current && place());
  document.addEventListener("click", (ev) => { if (menuOpen && !ev.composedPath().includes(host)) closeMenu(); }, true);

  // ---------- enlace especifico del video (feeds: TikTok, Instagram, X...) ----------
  function candidateUrl(video) {
    if (VIDEO_LINK.test(location.href)) return null; // la pagina ya ES la del video
    let node = video.parentElement;
    for (let i = 0; i < 12 && node; i++, node = node.parentElement) {
      const links = new Map();
      for (const a of node.querySelectorAll("a[href]")) {
        if (VIDEO_LINK.test(a.href)) links.set(new URL(a.href, location.href).pathname, a.href);
      }
      if (links.size === 1) return [...links.values()][0];
      if (links.size > 1) return null; // el contenedor ya agrupa varios videos: ambiguo
    }
    return null;
  }

  // ---------- menu y envio ----------
  function openMenu() {
    const v = current;
    const t = v && isFinite(v.currentTime) ? v.currentTime : 0;
    $("here").style.display = t > 3 && v.duration > t + 3 ? "block" : "none";
    $("here-t").textContent = `desde ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    menu.classList.add("open"); menuOpen = true;
  }
  function closeMenu() { menu.classList.remove("open"); menuOpen = false; scheduleHide(); }

  btn.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return; // ignora clics sinteticos de scripts de la pagina
    if (rec) { rec.stop(); return; } // durante una grabacion, el boton la detiene
    menuOpen ? closeMenu() : openMenu();
  });
  menu.addEventListener("click", async (ev) => {
    if (!ev.isTrusted) return;
    const item = ev.target.closest(".item");
    if (!item || !current) return;
    const video = current;
    if (item.dataset.mode === "record" || item.dataset.mode === "record-start") {
      closeMenu();
      startRecording(video, item.dataset.mode === "record-start");
      return;
    }
    const here = item.dataset.mode === "video-here";
    const msg = {
      type: "save", mode: here ? "video" : item.dataset.mode, start: here ? Math.floor(video.currentTime) : 0,
      candidate: candidateUrl(video), directSrc: video.currentSrc || video.src || "", pageUrl: location.href, title: document.title,
    };
    closeMenu();
    setState("Enviando…");
    try {
      const res = await ext.runtime.sendMessage(msg);
      if (!res || res.error) throw new Error(res?.error || "Sin respuesta");
      activeJob = res.job.id;
      setState("En cola…");
    } catch (err) {
      setState(/fetch|conect|Failed/i.test(err.message) ? "Abre TikSave primero" : err.message.slice(0, 60), "err", 4500);
    }
  });


  // ---------- grabador en tiempo real (blob:/MSE) ----------
  let rec = null;
  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  async function startRecording(video, fromStart) {
    const capture = video.captureStream || video.mozCaptureStream;
    if (!capture || typeof MediaRecorder === "undefined") { setState("Este navegador no puede grabar", "err", 4500); return; }
    let stream;
    try { stream = capture.call(video); } catch { setState("El sitio bloquea la grabacion", "err", 4500); return; }
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    let job;
    try {
      job = await ext.runtime.sendMessage({ type: "rec-start", title: document.title, pageUrl: location.href });
      if (!job || job.error) throw new Error(job?.error || "Sin respuesta");
    } catch (err) {
      setState(/fetch|conect|Failed/i.test(err.message) ? "Abre TikSave primero" : err.message.slice(0, 60), "err", 4500);
      return;
    }
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
    let seq = 0, chain = Promise.resolve(), stopped = false, cancelled = false;
    const started = Date.now();
    const ticker = setInterval(() => setState(`● Grabando ${fmtTime((Date.now() - started) / 1000)} · clic para detener`, "err"), 1000);

    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      chain = chain.then(async () => {
        if (cancelled) return;
        const res = await ext.runtime.sendMessage({ type: "rec-chunk", id: job.id, seq: seq++, data: await blobToBase64(e.data) });
        if (!res || res.error || res.cancelled) { cancelled = true; stop(); }
      }).catch(() => { cancelled = true; stop(); });
    };
    recorder.onstop = async () => {
      clearInterval(ticker);
      await chain;
      video.removeEventListener("ended", stop);
      rec = null;
      if (cancelled) { setState("Grabacion cancelada", "", 3000); return; }
      setState("Guardando grabacion…");
      try {
        const res = await ext.runtime.sendMessage({ type: "rec-finish", id: job.id });
        if (!res || res.error) throw new Error(res?.error || "Sin respuesta");
        activeJob = job.id; // el fondo reenviara el progreso por /api/jobs
        setState("Procesando…");
        pollRecording(job.id);
      } catch (err) { setState(String(err.message).slice(0, 60), "err", 5000); }
    };
    function stop() { if (!stopped) { stopped = true; if (recorder.state !== "inactive") recorder.stop(); } }

    rec = { stop };
    video.addEventListener("ended", stop);
    recorder.start(2000);
    try { if (fromStart) video.currentTime = 0; await video.play(); } catch { /* el usuario puede darle play */ }
    setState("● Grabando 0:00 · clic para detener", "err");
  }

  async function pollRecording(id) {
    for (let i = 0; i < 1800; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (activeJob !== id) return;
      try {
        const res = await ext.runtime.sendMessage({ type: "job-status", id });
        if (res?.status === "done") { setState("Guardado ✓", "done", 3500); activeJob = null; return; }
        if (res?.status === "error") { setState((res.error || "Falló").slice(0, 60), "err", 6000); activeJob = null; return; }
      } catch { return; }
    }
  }

  let stateTimer = null;
  function setState(text, cls = "", ms = 0) {
    attach(); wrap.style.display = "block";
    label.textContent = text;
    btn.classList.remove("done", "err"); if (cls) btn.classList.add(cls);
    clearTimeout(stateTimer);
    if (ms) stateTimer = setTimeout(() => { label.textContent = "Guardar"; btn.classList.remove("done", "err"); scheduleHide(); }, ms);
  }

  ext.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "progress" || msg.jobId !== activeJob) return;
    if (msg.status === "done") { setState("Guardado ✓", "done", 3500); activeJob = null; }
    else if (msg.status === "error") { setState((msg.error || "Falló").slice(0, 60), "err", 6000); activeJob = null; }
    else if (msg.status === "cancelled") { setState("Cancelado", "", 2500); activeJob = null; }
    else setState(msg.progress > 0 ? `Descargando ${Math.round(msg.progress)}%` : "Procesando…");
  });
})();
