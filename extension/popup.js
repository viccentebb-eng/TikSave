const API = "http://127.0.0.1:8173";
const urlEl = document.getElementById("url");
const message = document.getElementById("message");
const quality = document.getElementById("quality");
let currentUrl = "";

async function getCurrentTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function supportedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();

    return (
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com") ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host === "instagram.com" ||
      host.endsWith(".instagram.com") ||
      host === "facebook.com" ||
      host.endsWith(".facebook.com") ||
      host === "fb.watch"
    );
  } catch {
    return false;
  }
}

function say(text, type = "") {
  message.textContent = text;
  message.className = type;
}

async function ping() {
  const res = await fetch(`${API}/api/health`);
  if (!res.ok) throw new Error("TikSave no está abierto.");
}

async function init() {
  try {
    const tab = await getCurrentTab();
    currentUrl = tab?.url || "";
    urlEl.textContent = currentUrl || "No se pudo leer la pestaña actual.";

    if (!supportedUrl(currentUrl)) {
      document.querySelectorAll("[data-mode]").forEach((button) => {
        button.disabled = true;
      });
      quality.disabled = true;
      say(
        "Abre contenido público de TikTok, YouTube, Instagram o Facebook.",
        "error",
      );
      return;
    }

    await ping();
    say("TikSave está listo.", "ok");
  } catch {
    say("Abre TikSave en tu computadora primero.", "error");
  }
}

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await ping();

      const res = await fetch(`${API}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: currentUrl,
          mode: button.dataset.mode,
          quality: quality.value,
          playlist: false,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || "No se pudo iniciar la descarga.");
      }

      say("Descarga enviada a TikSave.", "ok");
    } catch (err) {
      say(err.message || "No se pudo conectar.", "error");
    }
  });
});

document.getElementById("open").addEventListener("click", () => {
  browser.tabs.create({ url: `${API}/?url=${encodeURIComponent(currentUrl)}` });
});

init();
