(() => {
  const KEY = "__tiksavePersistentPopupGuard";
  const ATTR = "data-tiksave-popup-guard";

  if (window[KEY]) return;

  const originalOpen = window.open;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;

  function enabled() {
    return document.documentElement?.getAttribute(ATTR) === "1";
  }

  window.open = function (...args) {
    if (enabled()) return null;
    return originalOpen.apply(this, args);
  };

  HTMLAnchorElement.prototype.click = function (...args) {
    if (enabled()) {
      try {
        const href = this.href ? new URL(this.href, location.href) : null;
        if (href && this.target === "_blank" && href.origin !== location.origin) {
          return;
        }
      } catch {}
    }

    return originalAnchorClick.apply(this, args);
  };

  document.addEventListener(
    "click",
    (event) => {
      if (!enabled()) return;

      const anchor = event.target?.closest?.("a[target='_blank']");
      if (!anchor) return;

      try {
        const href = new URL(anchor.href, location.href);
        if (href.origin !== location.origin) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      } catch {}
    },
    true,
  );

  window[KEY] = true;
})();
