(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function platformFromHost() {
    const host = location.hostname.toLowerCase();
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
      return "chatgpt";
    }
    if (host === "gemini.google.com") return "gemini";
    return null;
  }

  function platformLabel(platform) {
    if (platform === "chatgpt") return "ChatGPT";
    if (platform === "gemini") return "Gemini";
    return "Chat";
  }

  function cleanTitle(value, platform) {
    let title = String(value || "").trim();
    title = title
      .replace(/\s*[-–—]\s*ChatGPT\s*$/i, "")
      .replace(/\s*[-–—]\s*Gemini\s*$/i, "")
      .replace(/^Gemini\s*[-–—]\s*/i, "")
      .trim();

    if (!title || /^(chatgpt|gemini)$/i.test(title)) {
      return platformLabel(platform) + " chat";
    }
    return title.slice(0, 240);
  }

  function absoluteUrl(value) {
    if (!value) return "";
    try {
      return new URL(value, location.href).toString();
    } catch {
      return String(value);
    }
  }

  function normalizeMarkdown(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  function tableToMarkdown(table) {
    const rows = [...table.querySelectorAll("tr")]
      .map((row) =>
        [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) =>
          normalizeMarkdown(cell.innerText || cell.textContent || "").replace(/\|/g, "\\|"),
        ),
      )
      .filter((row) => row.length);

    if (!rows.length) return "";

    const width = Math.max(...rows.map((row) => row.length));
    const padded = rows.map((row) =>
      row.concat(Array(Math.max(0, width - row.length)).fill("")),
    );
    const divider = Array(width).fill("---");

    return [
      "| " + padded[0].join(" | ") + " |",
      "| " + divider.join(" | ") + " |",
      ...padded.slice(1).map((row) => "| " + row.join(" | ") + " |"),
    ].join("\n");
  }

  function childrenToMarkdown(element, context) {
    return [...element.childNodes]
      .map((child) => nodeToMarkdown(child, context || {}))
      .join("");
  }

  function nodeToMarkdown(node, context) {
    context = context || {};
    if (!node) return "";

    if (node.nodeType === Node.TEXT_NODE) {
      return context.pre
        ? node.nodeValue || ""
        : String(node.nodeValue || "").replace(/\s+/g, " ");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const element = node;
    const tag = element.tagName.toLowerCase();

    if (["script", "style", "noscript", "button", "textarea", "input", "select", "option"].includes(tag)) {
      return "";
    }

    if (element.getAttribute("aria-hidden") === "true") return "";
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";

    if (tag === "img") {
      const src = absoluteUrl(element.currentSrc || element.getAttribute("src") || "");
      if (!src) return "";
      const alt = String(element.getAttribute("alt") || "imagen").replace(/[\[\]]/g, "");
      return "![" + alt + "](" + src + ")";
    }

    if (tag === "a") {
      const href = absoluteUrl(element.getAttribute("href") || "");
      const text = normalizeMarkdown(childrenToMarkdown(element, context)) || href;
      return href ? "[" + text + "](" + href + ")" : text;
    }

    if (tag === "pre") {
      const code = element.querySelector("code") || element;
      const raw = String(code.textContent || "").replace(/\n+$/, "");
      const language =
        code.getAttribute("data-language") ||
        [...code.classList]
          .map((name) => {
            const match = name.match(/language-([\w+-]+)/);
            return match ? match[1] : "";
          })
          .find(Boolean) ||
        "";
      const fence = String.fromCharCode(96).repeat(3);
      return "\n\n" + fence + language + "\n" + raw + "\n" + fence + "\n\n";
    }

    if (tag === "code") {
      const raw = String(element.textContent || "").trim();
      if (!raw) return "";
      const tick = String.fromCharCode(96);
      return raw.includes(tick)
        ? tick + tick + raw + tick + tick
        : tick + raw + tick;
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return "\n\n" + "#".repeat(level) + " " +
        normalizeMarkdown(childrenToMarkdown(element, context)) + "\n\n";
    }

    if (tag === "strong" || tag === "b") {
      const text = normalizeMarkdown(childrenToMarkdown(element, context));
      return text ? "**" + text + "**" : "";
    }

    if (tag === "em" || tag === "i") {
      const text = normalizeMarkdown(childrenToMarkdown(element, context));
      return text ? "*" + text + "*" : "";
    }

    if (tag === "blockquote") {
      const text = normalizeMarkdown(childrenToMarkdown(element, context));
      if (!text) return "";
      return "\n\n" + text.split("\n").map((line) => "> " + line).join("\n") + "\n\n";
    }

    if (tag === "table") {
      const md = tableToMarkdown(element);
      return md ? "\n\n" + md + "\n\n" : "";
    }

    if (tag === "ul" || tag === "ol") {
      const ordered = tag === "ol";
      const items = [...element.children].filter(
        (child) => child.tagName && child.tagName.toLowerCase() === "li",
      );
      const lines = items.map((item, index) => {
        const text = normalizeMarkdown(childrenToMarkdown(item, { listItem: true }));
        return (ordered ? String(index + 1) + "." : "-") + " " + text;
      });
      return lines.length ? "\n" + lines.join("\n") + "\n" : "";
    }

    if (tag === "li") return childrenToMarkdown(element, context);

    const text = childrenToMarkdown(element, context);
    if (["p", "div", "section", "article", "main", "message-content"].includes(tag)) {
      return text.trim() ? "\n" + text + "\n" : "";
    }
    return text;
  }

  function contentToMarkdown(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);

    clone
      .querySelectorAll(
        [
          "button",
          "svg",
          "form",
          "textarea",
          "input",
          "select",
          "[role='button']",
          "[aria-hidden='true']",
          "[data-testid*='copy']",
          "[data-testid*='feedback']",
          "prompt-copy-button",
          "prompt-edit-button",
          "regenerate-button",
          "copy-button",
          "copy-table-button",
          "message-actions",
        ].join(","),
      )
      .forEach((node) => node.remove());

    return normalizeMarkdown(childrenToMarkdown(clone, {}));
  }

  function uniqueElements(elements) {
    const seen = new Set();
    return elements.filter((element) => {
      if (!element || seen.has(element)) return false;
      seen.add(element);
      return true;
    });
  }

  function roleAndContentFromChatGptNode(node) {
    const explicit = node.matches("[data-message-author-role]")
      ? node
      : node.querySelector("[data-message-author-role]");

    if (explicit) {
      const role = explicit.getAttribute("data-message-author-role");
      const turn =
        explicit.closest("article") ||
        explicit.closest("[data-turn]") ||
        explicit.closest('[data-testid^="conversation-turn-"]') ||
        node;

      const content =
        turn.querySelector(".markdown") ||
        turn.querySelector('[class*="markdown"]') ||
        (role === "user"
          ? turn.querySelector(".user-message-bubble-color") ||
            turn.querySelector('[class*="whitespace-pre-wrap"]')
          : null) ||
        explicit;

      return role ? { role, content, root: turn } : null;
    }

    const turn =
      node.closest("article") ||
      node.closest("[data-turn]") ||
      node.closest('[data-testid^="conversation-turn-"]') ||
      node;

    const userBubble =
      turn.querySelector(".user-message-bubble-color") ||
      turn.matches(".user-message-bubble-color");

    const content =
      turn.querySelector(".markdown") ||
      turn.querySelector('[class*="markdown"]') ||
      turn.querySelector(".user-message-bubble-color") ||
      turn.querySelector('[class*="whitespace-pre-wrap"]') ||
      turn.querySelector('[class*="group/turn-messages"]') ||
      turn;

    const text = normalizeMarkdown(content.innerText || content.textContent || "");
    if (!text) return null;

    return {
      role: userBubble ? "user" : "assistant",
      content,
      root: turn,
    };
  }

  function chatGptMessages() {
    const candidates = uniqueElements([
      ...document.querySelectorAll("[data-message-author-role]"),
      ...document.querySelectorAll('article[data-testid^="conversation-turn-"]'),
      ...document.querySelectorAll("[data-turn]"),
      ...document.querySelectorAll('article [class*="group/turn-messages"]'),
    ]);

    const mapped = candidates
      .map(roleAndContentFromChatGptNode)
      .filter(Boolean);

    const roots = new Set();
    return mapped.filter((item) => {
      const key = item.root || item.content;
      if (roots.has(key)) return false;
      roots.add(key);
      return true;
    });
  }

  function geminiMessages() {
    const direct = [];

    for (const node of document.querySelectorAll("user-query, user-query-content")) {
      const root = node.closest("user-query") || node;
      const content =
        root.querySelector("user-query-content .query-text") ||
        root.querySelector(".query-text") ||
        root.querySelector('[class*="query-text"]') ||
        root.querySelector("user-query-content") ||
        root;
      direct.push({ role: "user", content, root });
    }

    for (const node of document.querySelectorAll("model-response, message-content")) {
      const root = node.closest("model-response") || node;
      const content =
        root.querySelector("message-content .markdown-main-panel") ||
        root.querySelector(".markdown-main-panel") ||
        root.querySelector("message-content") ||
        root.querySelector('[class*="response-content"]') ||
        root;
      direct.push({ role: "assistant", content, root });
    }

    if (direct.length) {
      const roots = new Set();
      return direct
        .filter((item) => {
          const key = item.root || item.content;
          if (roots.has(key)) return false;
          roots.add(key);
          return true;
        })
        .sort((a, b) => {
          if (a.root === b.root) return 0;
          const pos = a.root.compareDocumentPosition(b.root);
          return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
    }

    const container =
      document.querySelector("#chat-history") ||
      document.querySelector('[data-test-id="chat-history-container"]') ||
      document.querySelector(".conversation-container") ||
      document.querySelector("main");

    if (!container) return [];

    const candidates = uniqueElements([
      ...container.querySelectorAll(
        '[class*="user-query"], [class*="query-content"], [class*="model-response"], [class*="response-content"], [class*="markdown-main-panel"]',
      ),
    ]);

    return candidates
      .map((node) => {
        const marker =
          (String(node.tagName || "") + " " + String(node.className || "")).toLowerCase();
        const role = /user|query/.test(marker)
          ? "user"
          : /model|response|markdown-main-panel/.test(marker)
            ? "assistant"
            : null;
        return role ? { role, content: node, root: node } : null;
      })
      .filter(Boolean);
  }

  function currentMessageNodes(platform) {
    return platform === "chatgpt" ? chatGptMessages() : geminiMessages();
  }

  function addVisibleMessages(platform, store) {
    for (const item of currentMessageNodes(platform)) {
      const markdown = contentToMarkdown(item.content);
      if (!markdown) continue;

      const id =
        item.root?.getAttribute?.("data-message-id") ||
        item.root?.getAttribute?.("data-testid") ||
        item.root?.getAttribute?.("data-turn") ||
        "";

      const key = id
        ? item.role + "|id|" + id
        : item.role + "|text|" + markdown.slice(0, 500);

      if (!store.has(key)) {
        store.set(key, {
          role: item.role === "user" ? "user" : "assistant",
          markdown,
        });
      }
    }
  }

  function findScrollContainer(platform) {
    if (platform === "gemini") {
      const explicit =
        document.querySelector("#chat-history") ||
        document.querySelector('[data-test-id="chat-history-container"]') ||
        document.querySelector(".conversation-container");
      if (explicit && explicit.scrollHeight > explicit.clientHeight + 50) return explicit;
    }

    const candidates = [...document.querySelectorAll("main *")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const overflow = style.overflowY;
        return (
          (overflow === "auto" || overflow === "scroll") &&
          element.scrollHeight > element.clientHeight + 200 &&
          element.clientHeight > 250
        );
      })
      .sort((a, b) => b.clientHeight - a.clientHeight);

    return candidates[0] || document.scrollingElement || document.documentElement;
  }

  async function harvestConversation(platform) {
    const store = new Map();
    addVisibleMessages(platform, store);

    const scroller = findScrollContainer(platform);
    if (!scroller) return [...store.values()];

    const isWindowScroller =
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body;

    const original = isWindowScroller ? window.scrollY : scroller.scrollTop;

    function getTop() {
      return isWindowScroller ? window.scrollY : scroller.scrollTop;
    }

    function setTop(value) {
      if (isWindowScroller) window.scrollTo(0, value);
      else scroller.scrollTop = value;
    }

    function maxTop() {
      if (isWindowScroller) {
        return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      }
      return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }

    try {
      setTop(0);
      await wait(250);
      addVisibleMessages(platform, store);

      let lastTop = -1;
      let stable = 0;

      for (let step = 0; step < 120; step += 1) {
        const maximum = maxTop();
        const viewport = isWindowScroller ? window.innerHeight : scroller.clientHeight;
        const next = Math.min(maximum, getTop() + Math.max(320, viewport * 0.72));

        setTop(next);
        await wait(110);
        addVisibleMessages(platform, store);

        const now = getTop();
        if (Math.abs(now - lastTop) < 2 || now >= maximum - 2) stable += 1;
        else stable = 0;

        lastTop = now;

        if (stable >= 3) {
          const refreshedMax = maxTop();
          if (now >= refreshedMax - 2) break;
          stable = 0;
        }
      }
    } finally {
      setTop(original);
    }

    return [...store.values()];
  }

  function diagnostics(platform) {
    return {
      platform,
      url: location.href,
      title: document.title,
      counts: {
        author_roles: document.querySelectorAll("[data-message-author-role]").length,
        conversation_turns: document.querySelectorAll('[data-testid^="conversation-turn-"]').length,
        data_turns: document.querySelectorAll("[data-turn]").length,
        chatgpt_groups: document.querySelectorAll('article [class*="group/turn-messages"]').length,
        chatgpt_user_bubbles: document.querySelectorAll(".user-message-bubble-color").length,
        gemini_user_query: document.querySelectorAll("user-query").length,
        gemini_user_query_content: document.querySelectorAll("user-query-content").length,
        gemini_model_response: document.querySelectorAll("model-response").length,
        gemini_message_content: document.querySelectorAll("message-content").length,
        gemini_markdown_panels: document.querySelectorAll(".markdown-main-panel").length,
      },
    };
  }

  function buildResult(platform, messages) {
    if (!messages.length) {
      const diag = diagnostics(platform);
      throw new Error(
        "No pude identificar los turnos del chat. Selectores detectados: " +
        JSON.stringify(diag.counts),
      );
    }

    const title = cleanTitle(document.title, platform);
    const sections = messages.map((message) => {
      const heading = message.role === "user" ? "Tú" : platformLabel(platform);
      return "## " + heading + "\n\n" + message.markdown;
    });

    return {
      platform,
      platform_label: platformLabel(platform),
      title,
      source_url: location.href,
      message_count: messages.length,
      markdown: ["# " + title, "", sections.join("\n\n---\n\n")].join("\n").trim(),
      diagnostics: diagnostics(platform),
    };
  }

  async function extractConversation(deep) {
    const platform = platformFromHost();
    if (!platform) {
      throw new Error("Esta pestaña no es un chat compatible de ChatGPT o Gemini.");
    }

    const store = new Map();
    addVisibleMessages(platform, store);

    if (store.size) {
      return buildResult(platform, [...store.values()]);
    }

    if (!deep) {
      const diag = diagnostics(platform);
      return {
        platform,
        platform_label: platformLabel(platform),
        title: cleanTitle(document.title, platform),
        source_url: location.href,
        message_count: 0,
        markdown: "",
        diagnostics: diag,
      };
    }

    const harvested = await harvestConversation(platform);
    return buildResult(platform, harvested);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "inspectAiChat") {
      return extractConversation(false)
        .then((result) => ({
          ok: true,
          platform: result.platform,
          platform_label: result.platform_label,
          title: result.title,
          source_url: result.source_url,
          message_count: result.message_count,
          diagnostics: result.diagnostics,
        }))
        .catch((error) => ({
          ok: false,
          error: (error && error.message) || String(error),
        }));
    }

    if (message && message.type === "exportAiChatMarkdown") {
      return extractConversation(true)
        .then((result) => ({ ok: true, ...result }))
        .catch((error) => ({
          ok: false,
          error: (error && error.message) || String(error),
        }));
    }

    return undefined;
  });
})();
