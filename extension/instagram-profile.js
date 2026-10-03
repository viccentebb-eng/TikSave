(() => {
  const RESERVED = new Set([
    "accounts", "direct", "explore", "reels", "reel", "p", "stories",
    "about", "developer", "legal", "web", "challenge"
  ]);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isInstagram() {
    const host = location.hostname.toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  }

  function profileUsername() {
    if (!isInstagram()) return null;
    const match = location.pathname.match(/^\\/([A-Za-z0-9._]+)\\/?$/);
    if (!match) return null;
    if (RESERVED.has(match[1].toLowerCase())) return null;
    return match[1];
  }

  function absoluteUrl(value) {
    if (!value) return null;
    try {
      return new URL(value, location.href).toString();
    } catch {
      return null;
    }
  }

  function bestSrcset(srcset) {
    if (!srcset) return null;
    return srcset
      .split(",")
      .map((part) => {
        const bits = part.trim().split(/\\s+/);
        const url = absoluteUrl(bits[0]);
        if (!url) return null;
        const d = bits[1] || "";
        let score = 0;
        if (/^\\d+w$/i.test(d)) score = Number(d.slice(0, -1)) || 0;
        else if (/^\\d+(?:\\.\\d+)?x$/i.test(d)) score = (Number(d.slice(0, -1)) || 0) * 1000;
        return { url, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0]?.url || null;
  }

  function thumbnailFromAnchor(anchor) {
    const img = anchor.querySelector("img");
    if (!img) return null;
    return bestSrcset(img.getAttribute("srcset")) || absoluteUrl(img.currentSrc) || absoluteUrl(img.src);
  }

  function classifyPostAnchor(anchor) {
    const url = absoluteUrl(anchor.href);
    if (!url) return null;

    const path = new URL(url).pathname;

    if (/^\\/reels?\\/[^/]+\\/?/i.test(path)) {
      return { kind: "reel", url, thumbnail: thumbnailFromAnchor(anchor), label: "Reel" };
    }

    if (!/^\\/p\\/[^/]+\\/?/i.test(path)) return null;

    const accessibility = [...anchor.querySelectorAll("[aria-label], title")]
      .map((node) => [
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.textContent
      ].filter(Boolean).join(" "))
      .join(" ")
      .toLowerCase();

    let label = "Publicación";
    if (/(carousel|carrusel|secuencia|multiple|múltiple)/i.test(accessibility)) {
      label = "Carrusel";
    } else if (/(video|reel)/i.test(accessibility)) {
      label = "Video/publicación";
    } else if (anchor.querySelector("img")) {
      label = "Foto/publicación";
    }

    return { kind: "post", url, thumbnail: thumbnailFromAnchor(anchor), label };
  }

  function collectProfileItems(username) {
    const result = new Map();
    const escapedUser = username.replace(/[-\\/^$*+?.()|[\\]{}]/g, "\\$&");

    for (const anchor of document.querySelectorAll("a[href]")) {
      const item = classifyPostAnchor(anchor);
      if (item) {
        const key = new URL(item.url).pathname.replace(/\\/+$/, "");
        const current = result.get(key);
        if (!current || (!current.thumbnail && item.thumbnail)) result.set(key, item);
        continue;
      }

      const url = absoluteUrl(anchor.href);
      if (!url) continue;
      const path = new URL(url).pathname;

      if (new RegExp("^/stories/" + escapedUser + "(?:/|$)", "i").test(path)) {
        result.set("story:" + username, {
          kind: "story",
          url,
          thumbnail: thumbnailFromAnchor(anchor),
          label: "Story activa"
        });
        continue;
      }

      const highlight = path.match(/^\\/stories\\/highlights\\/(\\d+)\\/?/i);
      if (highlight) {
        result.set("highlight:" + highlight[1], {
          kind: "highlight",
          url,
          thumbnail: thumbnailFromAnchor(anchor),
          label: "Historia destacada"
        });
      }
    }

    return [...result.values()];
  }

  function countsFor(items) {
    const counts = { posts: 0, reels: 0, stories: 0, highlights: 0, total: items.length };
    for (const item of items) {
      if (item.kind === "reel") counts.reels += 1;
      else if (item.kind === "post") counts.posts += 1;
      else if (item.kind === "story") counts.stories += 1;
      else if (item.kind === "highlight") counts.highlights += 1;
    }
    return counts;
  }

  async function scanProfile() {
    const username = profileUsername();
    if (!username) throw new Error("La pestaña actual no es un perfil de Instagram.");

    const merged = new Map();
    const originalY = window.scrollY;

    function absorb() {
      for (const item of collectProfileItems(username)) {
        let key;
        try {
          const path = new URL(item.url).pathname.replace(/\\/+$/, "");
          key = item.kind + ":" + path;
        } catch {
          key = item.kind + ":" + item.url;
        }
        const old = merged.get(key);
        if (!old || (!old.thumbnail && item.thumbnail)) merged.set(key, item);
      }
    }

    absorb();

    let stable = 0;
    let previousHeight = 0;
    let previousCount = merged.size;

    try {
      for (let step = 0; step < 70; step += 1) {
        const height = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        window.scrollTo(0, height);
        await sleep(step < 4 ? 420 : 300);
        absorb();

        const nextHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        if (nextHeight <= previousHeight + 10 && merged.size === previousCount) stable += 1;
        else stable = 0;

        previousHeight = nextHeight;
        previousCount = merged.size;
        if (stable >= 4) break;
      }
    } finally {
      window.scrollTo(0, originalY);
    }

    const items = [...merged.values()].map((item, index) => ({ index: index + 1, ...item }));

    return {
      profile_url: "https://www.instagram.com/" + username + "/",
      username,
      items,
      counts: countsFor(items)
    };
  }

  function visibleStoryMedia() {
    const items = [];

    for (const img of document.querySelectorAll("img")) {
      const rect = img.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area < 90000) continue;
      const url = bestSrcset(img.getAttribute("srcset")) || absoluteUrl(img.currentSrc) || absoluteUrl(img.src);
      if (!url) continue;
      items.push({
        type: "image",
        url,
        width: img.naturalWidth || Math.round(rect.width),
        height: img.naturalHeight || Math.round(rect.height)
      });
    }

    for (const video of document.querySelectorAll("video")) {
      const rect = video.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area < 90000) continue;

      const direct = absoluteUrl(video.currentSrc || video.src);
      if (direct) {
        items.push({
          type: "video",
          url: direct,
          width: video.videoWidth || Math.round(rect.width),
          height: video.videoHeight || Math.round(rect.height)
        });
      }

      const poster = absoluteUrl(video.poster);
      if (poster) {
        items.push({
          type: "image",
          url: poster,
          width: video.videoWidth || Math.round(rect.width),
          height: video.videoHeight || Math.round(rect.height)
        });
      }
    }

    for (const entry of performance.getEntriesByType("resource")) {
      const url = absoluteUrl(entry.name);
      if (!url) continue;
      if (/(?:\.mp4|\.m3u8|\.mpd)(?:[?#]|$)/i.test(url)) {
        items.push({ type: "video", url, width: 0, height: 0 });
      }
    }

    const seen = new Set();
    return items.filter((item) => {
      const key = item.type + "|" + item.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function findStoryNext() {
    const terms = ["next", "siguiente", "próximo", "proximo", "weiter", "suivant", "avanti"];
    const candidates = [...document.querySelectorAll("button,[role='button'],[aria-label]")];

    for (const node of candidates) {
      const label = [
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.textContent
      ].filter(Boolean).join(" ").toLowerCase();

      if (terms.some((term) => label.includes(term))) {
        const button = node.matches?.("button,[role='button']") ? node : node.closest?.("button,[role='button']");
        if (button && !button.disabled) return button;
      }
    }
    return null;
  }

  async function scanStoryMedia() {
    if (!/^\\/stories\\//i.test(location.pathname)) {
      throw new Error("La pestaña actual no es una Story de Instagram.");
    }

    const merged = new Map();
    let stagnant = 0;
    let previousSignature = "";

    function absorb() {
      for (const item of visibleStoryMedia()) {
        merged.set(item.type + "|" + item.url, item);
      }
    }

    for (let step = 0; step < 80; step += 1) {
      absorb();
      const signature = [...merged.keys()].join("|");
      const next = findStoryNext();
      if (!next) break;

      next.click();
      await sleep(320);

      const currentOwner = location.pathname.split("/").filter(Boolean)[1] || "";
      if (initialOwner && currentOwner && currentOwner !== initialOwner) break;

      absorb();

      const after = [...merged.keys()].join("|");
      if (after === signature || after === previousSignature) stagnant += 1;
      else stagnant = 0;

      previousSignature = after;
      if (stagnant >= 3) break;
    }

    return [...merged.values()].map((item, index) => ({ index: index + 1, ...item }));
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "scanInstagramProfile") {
      return scanProfile()
        .then((scan) => ({ ok: true, ...scan }))
        .catch((error) => ({ ok: false, error: error?.message || String(error) }));
    }

    if (message?.type === "scanInstagramStoryMedia") {
      return scanStoryMedia()
        .then((items) => ({ ok: true, items }))
        .catch((error) => ({ ok: false, error: error?.message || String(error) }));
    }

    return undefined;
  });
})();
