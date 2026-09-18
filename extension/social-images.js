(() => {
  const CDN_RE = /(fbcdn\.net|cdninstagram\.com|scontent[^/]*\.cdninstagram\.com|tiktokcdn|tiktokcdn-us|muscdn|byteimg|douyincdn|p16-|p19-)/i;

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
    const items = srcset
      .split(",")
      .map((part) => {
        const pieces = part.trim().split(/\s+/);
        const url = absoluteUrl(pieces[0]);
        if (!url) return null;
        let score = 0;
        const descriptor = pieces[1] || "";
        if (/\d+w$/i.test(descriptor)) score = Number(descriptor.slice(0, -1)) || 0;
        else if (/\d+(?:\.\d+)?x$/i.test(descriptor)) score = (Number(descriptor.slice(0, -1)) || 0) * 1000;
        return { url, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return items[0]?.url || null;
  }

  function keyFor(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (CDN_RE.test(host)) {
        return `${host}${parsed.pathname}`;
      }
      return parsed.href;
    } catch {
      return url;
    }
  }

  function collectFromRoot(root = document) {
    const map = new Map();

    function add(url, score = 0, meta = {}) {
      url = absoluteUrl(url);
      if (!url) return;
      if (!CDN_RE.test(url) && !/\.(?:jpe?g|png|webp|avif)(?:[?#]|$)/i.test(url)) return;

      const key = keyFor(url);
      const current = map.get(key);
      const item = {
        url,
        score,
        width: meta.width || 0,
        height: meta.height || 0,
        alt: meta.alt || "",
      };

      if (!current || item.score > current.score) map.set(key, item);
    }

    for (const img of root.querySelectorAll?.("img") || []) {
      const rect = img.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const naturalArea = (img.naturalWidth || 0) * (img.naturalHeight || 0);
      const contentBoost = img.closest("article,[role='dialog'],main") ? 300000 : 0;
      const avatarPenalty =
        (img.naturalWidth || 0) <= 240 &&
        (img.naturalHeight || 0) <= 240 &&
        Math.abs((img.naturalWidth || 0) - (img.naturalHeight || 0)) < 10
          ? 250000
          : 0;

      const best = bestSrcset(img.getAttribute("srcset")) || img.currentSrc || img.src;
      add(best, area + Math.min(naturalArea / 4, 500000) + contentBoost - avatarPenalty, {
        width: img.naturalWidth || Math.round(rect.width),
        height: img.naturalHeight || Math.round(rect.height),
        alt: img.alt || "",
      });

      for (const attr of ["src", "data-src", "data-original"]) {
        const value = img.getAttribute(attr);
        if (value) add(value, area + contentBoost - avatarPenalty, {
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          alt: img.alt || "",
        });
      }
    }

    const html = document.documentElement?.innerHTML || "";
    const patterns = [
      /https?:\\?\/\\?\/[^"'<>\s]+/g,
      /https?:\/\/[^"'<>\s]+/g,
    ];

    for (const pattern of patterns) {
      const matches = html.match(pattern) || [];
      for (const raw of matches.slice(0, 1000)) {
        const cleaned = raw
          .replaceAll("\\/", "/")
          .replaceAll("\\u0026", "&")
          .replaceAll("&amp;", "&")
          .replace(/[),}]]+$/, "");
        if (CDN_RE.test(cleaned)) add(cleaned, 120000);
      }
    }

    return [...map.values()]
      .filter((item) => {
        const lower = `${item.url} ${item.alt}`.toLowerCase();
        if (/(profile|avatar|sprite|emoji|icon|logo)/.test(lower) && item.score < 250000) return false;
        return item.score > 10000;
      })
      .sort((a, b) => b.score - a.score)
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
        return { node, area };
      })
      .sort((a, b) => b.area - a.area)[0]?.node || document;
  }

  function findCarouselButton(root, direction) {
    const terms = direction === "next"
      ? ["next", "siguiente", "suivant", "weiter", "avanti", "próximo", "proximo", "下一步", "下一张"]
      : ["previous", "prev", "anterior", "précédent", "zurück", "indietro", "上一张"];

    const all = [...root.querySelectorAll("button,[role='button'],[aria-label]")];

    for (const node of all) {
      const label = [
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.textContent,
        node.querySelector?.("[aria-label]")?.getAttribute?.("aria-label"),
      ].filter(Boolean).join(" ").toLowerCase();

      if (terms.some((term) => label.includes(term))) {
        const button = node.matches?.("button,[role='button']") ? node : node.closest?.("button,[role='button']");
        if (button && !button.disabled) return button;
      }
    }

    return null;
  }

  async function scanCarousel() {
    const host = location.hostname.toLowerCase();
    const root = findMainPostRoot();
    const merged = new Map();

    function absorb(items) {
      for (const item of items) {
        const key = keyFor(item.url);
        const old = merged.get(key);
        if (!old || item.score > old.score) merged.set(key, item);
      }
    }

    absorb(collectFromRoot(root));

    if (!host.includes("instagram.com")) {
      return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 30);
    }

    let moved = 0;
    let stagnant = 0;
    let lastSignature = "";

    for (let step = 0; step < 20; step += 1) {
      const next = findCarouselButton(root, "next");
      if (!next) break;

      const before = collectFromRoot(root);
      absorb(before);
      const signature = before.map((item) => keyFor(item.url)).slice(0, 8).join("|");

      next.click();
      moved += 1;
      await sleep(230);

      const after = collectFromRoot(root);
      absorb(after);
      const nextSignature = after.map((item) => keyFor(item.url)).slice(0, 8).join("|");

      if (nextSignature === signature || nextSignature === lastSignature) stagnant += 1;
      else stagnant = 0;

      lastSignature = nextSignature;
      if (stagnant >= 2) break;
    }

    for (let step = 0; step < moved; step += 1) {
      const prev = findCarouselButton(root, "previous");
      if (!prev) break;
      prev.click();
      await sleep(80);
    }

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "scanSocialImages") {
      return scanCarousel();
    }
    return undefined;
  });
})();
