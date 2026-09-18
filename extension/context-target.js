(() => {
  let lastSent = "";

  function cssUrl(value) {
    if (!value || value === "none") return null;
    const match = String(value).match(/url\((?:"|')?(.*?)(?:"|')?\)/i);
    const url = match?.[1] || "";
    return /^https?:\/\//i.test(url) ? url : null;
  }

  function targetMedia(target) {
    let node = target instanceof Element ? target : null;

    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      if (node instanceof HTMLImageElement) {
        const url = node.currentSrc || node.src;
        if (/^https?:\/\//i.test(url)) {
          return {
            kind: "image",
            url,
            alt: node.alt || "",
          };
        }
      }

      if (node instanceof HTMLVideoElement) {
        const poster = node.poster;
        if (/^https?:\/\//i.test(poster || "")) {
          return {
            kind: "image",
            url: poster,
            alt: "",
          };
        }
      }

      try {
        const bg = cssUrl(getComputedStyle(node).backgroundImage);
        if (bg) {
          return {
            kind: "background",
            url: bg,
            alt: "",
          };
        }
      } catch {}
    }

    const images = [...document.images]
      .map((img) => {
        const rect = img.getBoundingClientRect();
        const visible =
          rect.width > 120 &&
          rect.height > 120 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < innerHeight &&
          rect.left < innerWidth;

        return {
          url: img.currentSrc || img.src || "",
          alt: img.alt || "",
          area: visible ? rect.width * rect.height : 0,
        };
      })
      .filter((item) => /^https?:\/\//i.test(item.url) && item.area > 0)
      .sort((a, b) => b.area - a.area);

    return images[0]
      ? { kind: "image", url: images[0].url, alt: images[0].alt }
      : null;
  }

  document.addEventListener(
    "contextmenu",
    (event) => {
      const media = targetMedia(event.target);
      const signature = JSON.stringify([location.href, media?.url || ""]);

      if (signature === lastSent) return;
      lastSent = signature;

      browser.runtime.sendMessage({
        type: "rememberContextTarget",
        target: {
          pageUrl: location.href,
          title: document.title || "",
          ...media,
        },
      }).catch(() => {});
    },
    true,
  );
})();
