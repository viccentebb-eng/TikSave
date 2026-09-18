(() => {
  const ATTR = "data-tiksave-popup-guard";

  function apply(enabled) {
    const root = document.documentElement;
    if (!root) return;
    if (enabled) {
      root.setAttribute(ATTR, "1");
    } else {
      root.removeAttribute(ATTR);
    }
  }

  async function refresh() {
    try {
      const stored = await browser.storage.local.get("popupGuard");
      apply(Boolean(stored.popupGuard));
    } catch {
      apply(false);
    }
  }

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !("popupGuard" in changes)) return;
    apply(Boolean(changes.popupGuard.newValue));
  });

  if (document.documentElement) {
    refresh();
  } else {
    document.addEventListener("readystatechange", refresh, { once: true });
  }
})();
