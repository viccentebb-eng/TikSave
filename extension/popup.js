const API = "http://127.0.0.1:8173";
const urlEl = document.getElementById("url");
const message = document.getElementById("message");
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
      host === "youtu.be"
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
  if (!res.ok) throw new Error("TikSave Local no está disponible.");
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
      say("Abre un video público de TikTok o YouTube y vuelve a pulsar la extensión.", "error");
      return;
    }

    await ping();
    say("TikSave Local está listo.", "ok");
  } catch {
    say("Abre TikSave Local primero.", "error");
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
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "No se pudo iniciar la descarga.");

      say("Descarga enviada a TikSave.", "ok");
    } catch (err) {
      say(err.message || "No se pudo conectar.", "error");
    }
  });
});

document.getElementById("open").addEventListener("click", () => {
  browser.tabs.create({ url: API });
});

init();
