(() => {
  const CDN_RE = /(fbcdn\.net|cdninstagram\.com|scontent|tiktokcdn|tiktokcdn-us|muscdn|byteimg|douyinpic|douyincdn|p16-|p19-)/i;
  const JUNK_RE = /(profile|avatar|sprite|emoji|icon|logo|badge|google[-_ ]?play|app[-_ ]?store|qr(?:code)?|instagram[-_ ]?glyph)/i;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function absoluteUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      return /^https?:$/i.test(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function bestSrcset(srcset) {
    if (!srcset) return null;
    return srcset
      .split(",")
      .map((part) => {
        const pieces = part.trim().split(/\s+/);
        const url = absoluteUrl(pieces[0]);
        if (!url) return null;
        const descriptor = pieces[1] || "";
        let score = 0;
        if (/\d+w$/i.test(descriptor)) score = Number(descriptor.slice(0, -1)) || 0;
        else if (/\d+(?:\.\d+)?x$/i.test(descriptor)) {
          score = (Number(descriptor.slice(0, -1)) || 0) * 1000;
        }
        return { url, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0]?.url || null;
  }

  function keyFor(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return CDN_RE.test(host) ? `${host}${parsed.pathname}` : parsed.href;
    } catch {
      return String(url || "");
    }
  }

  function isVisible(img) {
    const rect = img.getBoundingClientRect();
    return (
      rect.width >= 100 &&
      rect.height >= 100 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  }

  function isJunk(item) {
    const lower = `${item.url || ""} ${item.alt || ""}`.toLowerCase();
    if (JUNK_RE.test(lower)) return true;

    const width = Number(item.width || 0);
    const height = Number(item.height || 0);
    return (
      width > 0 &&
      height > 0 &&
      width <= 320 &&
      height <= 320 &&
      Math.abs(width - height) <= 24
    );
  }

  function collectFromRoot(root = document, { visibleOnly = false } = {}) {
    const map = new Map();

    function add(url, score = 0, meta = {}) {
      url = absoluteUrl(url);
      if (!url) return;
      if (!CDN_RE.test(url) && !/\.(?:jpe?g|png|webp|avif)(?:[?#]|$)/i.test(url)) return;

      const item = {
        url,
        score,
        width: Number(meta.width || 0),
        height: Number(meta.height || 0),
        alt: meta.alt || "",
        area: Number(meta.area || 0),
        visible: Boolean(meta.visible),
      };
      if (isJunk(item)) return;

      const key = keyFor(url);
      const current = map.get(key);
      if (!current || item.score > current.score) map.set(key, item);
    }

    for (const img of root.querySelectorAll?.("img") || []) {
      const visible = isVisible(img);
      if (visibleOnly && !visible) continue;

      const rect = img.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const naturalArea = (img.naturalWidth || 0) * (img.naturalHeight || 0);
      const contentBoost = img.closest("article,[role='dialog'],main") ? 300000 : 0;
      const visibleBoost = visible ? 500000 : 0;
      const common = {
        width: img.naturalWidth || Math.round(rect.width),
        height: img.naturalHeight || Math.round(rect.height),
        alt: img.alt || "",
        area,
        visible,
      };

      const best = bestSrcset(img.getAttribute("srcset")) || img.currentSrc || img.src;
      add(best, area + Math.min(naturalArea / 4, 500000) + contentBoost + visibleBoost, common);

      for (const attr of ["src", "data-src", "data-original", "data-lazy-src"]) {
        const value = img.getAttribute(attr);
        if (value) add(value, area + contentBoost + visibleBoost, common);
      }
    }

    return [...map.values()]
      .filter((item) => item.score > 20000)
      .sort((a, b) => (b.area - a.area) || (b.score - a.score))
      .slice(0, 40);
  }

  function findMainPostRoot() {
    const candidates = [...document.querySelectorAll("article,[role='dialog']")];
    if (!candidates.length) return document;

    return candidates
      .map((node) => {
        const images = [...node.querySelectorAll("img")];
        const area = images.reduce((sum, img) => {
          const rect = img.getBoundingClientRect();
          return sum + Math.max(0, rect.width) * Math.max(0, rect.height);
        }, 0);
        const rect = node.getBoundingClientRect();
        const visible = rect.bottom > 0 && rect.top < innerHeight;
        return { node, area: area + (visible ? 1000000 : 0) };
      })
      .sort((a, b) => b.area - a.area)[0]?.node || document;
  }

  function findCarouselButton(root, direction) {
    const terms = direction === "next"
      ? ["next", "siguiente", "suivant", "weiter", "avanti", "próximo", "proximo", "下一步", "下一张", "次へ"]
      : ["previous", "prev", "anterior", "précédent", "zurück", "indietro", "上一张", "前へ"];

    const all = [...root.querySelectorAll("button,[role='button'],[aria-label]")];
    for (const node of all) {
      const label = [
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.textContent,
        node.querySelector?.("[aria-label]")?.getAttribute?.("aria-label"),
      ].filter(Boolean).join(" ").toLowerCase();

      if (!terms.some((term) => label.includes(term))) continue;
      const button = node.matches?.("button,[role='button']")
        ? node
        : node.closest?.("button,[role='button']");
      if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") continue;

      const rect = button.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return button;
    }
    return null;
  }

  function primaryImage(root) {
    return collectFromRoot(root, { visibleOnly: true })[0] || null;
  }

  function signature(root) {
    const item = primaryImage(root);
    return item ? keyFor(item.url) : "";
  }

  async function clickAndWait(root, button, before, timeout = 1200) {
    if (!button) return false;
    button.click();

    const started = Date.now();
    while (Date.now() - started < timeout) {
      await sleep(70);
      const after = signature(root);
      if (after && after !== before) return true;
    }
    return false;
  }

  function hintedCarouselCount(root) {
    let max = 0;
    const nodes = root.querySelectorAll?.("[aria-label],[title]") || [];
    for (const node of nodes) {
      const label = [
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
      ].filter(Boolean).join(" ");

      const totalMatch = label.match(/(?:of|de)\s+(\d{1,3})\b/i);
      if (totalMatch) max = Math.max(max, Number(totalMatch[1]) || 0);

      const indexMatch = label.match(/(?:slide|diapositiva|photo|foto|image|imagen)\D{0,10}(\d{1,3})\b/i);
      if (indexMatch) max = Math.max(max, Number(indexMatch[1]) || 0);
    }
    return max;
  }

  async function scanInstagramCarousel(root) {
    const initialKey = signature(root);
    const hintedCount = hintedCarouselCount(root);
    let toStart = 0;

    for (let step = 0; step < 29; step += 1) {
      const prev = findCarouselButton(root, "previous");
      if (!prev) break;

      const before = signature(root);
      if (!before || !await clickAndWait(root, prev, before)) break;
      toStart += 1;
    }

    const ordered = [];
    const seen = new Set();

    function capture() {
      const item = primaryImage(root);
      if (!item) return;
      const key = keyFor(item.url);
      if (seen.has(key)) return;
      seen.add(key);
      ordered.push({
        ...item,
        carouselIndex: ordered.length + 1,
        source: "carousel",
      });
    }

    capture();
    let forwardMoves = 0;

    for (let step = 0; step < 29; step += 1) {
      if (hintedCount && ordered.length >= hintedCount) break;

      const next = findCarouselButton(root, "next");
      if (!next) break;

      const before = signature(root);
      if (!before || !await clickAndWait(root, next, before)) break;
      forwardMoves += 1;
      capture();
    }

    const movesBack = Math.max(0, forwardMoves - toStart);
    for (let step = 0; step < movesBack; step += 1) {
      const prev = findCarouselButton(root, "previous");
      if (!prev) break;
      const before = signature(root);
      if (!before || !await clickAndWait(root, prev, before, 700)) break;
    }

    const restoredKey = signature(root);

    browser.runtime.sendMessage({
      type: "diagnosticEvent",
      payload: {
        component: "firefox-extension",
        action: "carousel-scan",
        level: "info",
        message: location.href,
        details: {
          platform: "instagram",
          hinted_count: hintedCount || null,
          image_count: ordered.length,
          start_offset: toStart,
          restored: Boolean(initialKey && restoredKey === initialKey),
        },
      },
    }).catch(() => {});

    return ordered;
  }

  async function scanCarousel() {
    const host = location.hostname.toLowerCase();
    const root = findMainPostRoot();

    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      const carousel = await scanInstagramCarousel(root);
      if (carousel.length > 1) return carousel;

      const single = primaryImage(root);
      return single ? [{ ...single, carouselIndex: 1, source: "post" }] : [];
    }

    return collectFromRoot(root)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "scanSocialImages") return scanCarousel();
    return undefined;
  });
})();
