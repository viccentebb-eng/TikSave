(() => {
  const ROOT_ID = "tiksave-notify-toast";

  function removeToast() {
    document.getElementById(ROOT_ID)?.remove();
  }

  function playChime(success) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      const now = context.currentTime;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(success ? 0.10 : 0.06, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (success ? 0.42 : 0.28));
      gain.connect(context.destination);

      const notes = success ? [659.25, 783.99, 987.77] : [311.13, 246.94];
      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, now + index * 0.085);
        oscillator.connect(gain);
        oscillator.start(now + index * 0.085);
        oscillator.stop(now + index * 0.085 + 0.18);
      });
      setTimeout(() => context.close().catch(() => {}), 900);
    } catch {
      // Firefox can block page audio on sites that have never received interaction.
    }
  }

  function showToast(job) {
    removeToast();

    const success = job?.status === "done";
    playChime(success);
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.cssText = [
      "position:fixed",
      "right:20px",
      "top:20px",
      "z-index:2147483647",
      "width:min(360px,calc(100vw - 40px))",
      "padding:14px",
      "border-radius:14px",
      "background:#111318",
      "border:1px solid #3a3f48",
      "box-shadow:0 18px 50px rgba(0,0,0,.45)",
      "color:#f5f6f7",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    ].join(";");

    root.innerHTML = `
      <div style="display:flex;gap:10px;align-items:flex-start">
        <div style="width:34px;height:34px;border-radius:10px;background:${success ? "#dff7e7" : "#f7dde0"};color:#111318;display:grid;place-items:center;font-weight:900;flex:none">
          ${success ? "✓" : "!"}
        </div>
        <div style="min-width:0;flex:1">
          <strong style="display:block;font-size:13px">${success ? "Descarga terminada" : "TikSave encontró un problema"}</strong>
          <div style="margin-top:3px;color:#aab1bc;font-size:11px;line-height:1.35;overflow-wrap:anywhere">
            ${escapeHtml(job?.title || job?.error || job?.filename || (success ? "El archivo ya está listo." : "No se pudo completar la descarga."))}
          </div>
          <div style="display:flex;gap:7px;margin-top:10px">
            ${success ? '<button data-tiksave-open-folder style="border:1px solid #405446;border-radius:8px;padding:7px 9px;background:#203027;color:#b9edca;font:inherit;font-size:10px;font-weight:800;cursor:pointer">Abrir carpeta</button>' : ""}
            <button data-tiksave-close style="border:1px solid #3c414a;border-radius:8px;padding:7px 9px;background:#25282f;color:#fff;font:inherit;font-size:10px;font-weight:800;cursor:pointer">Cerrar</button>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    root.querySelector("[data-tiksave-close]")?.addEventListener("click", removeToast);
    root.querySelector("[data-tiksave-open-folder]")?.addEventListener("click", async () => {
      try {
        await browser.runtime.sendMessage({ type: "openFolder" });
      } catch {}
    });

    setTimeout(removeToast, 12000);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "showTikSaveToast") {
      showToast(message.job || {});
    }
  });
})();
