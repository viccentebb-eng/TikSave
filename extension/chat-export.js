(() => {
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

  function escapeCell(value) {
    return String(value || "").replace(/\|/g, "\\|");
  }

  function tableToMarkdown(table) {
    const rows = [...table.querySelectorAll("tr")]
      .map((row) =>
        [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) =>
          escapeCell(normalizeMarkdown(cell.innerText || cell.textContent || "")),
        ),
      )
      .filter((row) => row.length);

    if (!rows.length) return "";

    const width = Math.max(...rows.map((row) => row.length));
    const padded = rows.map((row) =>
      row.concat(Array(Math.max(0, width - row.length)).fill("")),
    );
    const header = padded[0];
    const divider = Array(width).fill("---");

    return [
      "| " + header.join(" | ") + " |",
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
      if (context.pre) return node.nodeValue || "";
      return String(node.nodeValue || "").replace(/\s+/g, " ");
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
      return raw.includes(tick) ? tick + tick + raw + tick + tick : tick + raw + tick;
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return "\n\n" + "#".repeat(level) + " " + normalizeMarkdown(childrenToMarkdown(element, context)) + "\n\n";
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
    if (["p", "div", "section", "article", "main"].includes(tag)) {
      return text.trim() ? "\n" + text + "\n" : "";
    }
    return text;
  }

  function contentToMarkdown(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);

    clone
      .querySelectorAll(
        "button,svg,form,textarea,input,select,[role='button'],[aria-hidden='true'],[data-testid*='copy'],[data-testid*='feedback']",
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

  function chatGptMessages() {
    const roleNodes = uniqueElements([
      ...document.querySelectorAll(
        '[data-message-author-role="user"], [data-message-author-role="assistant"]',
      ),
    ]);

    if (roleNodes.length) {
      return roleNodes.map((node) => {
        const role = node.getAttribute("data-message-author-role") || "assistant";
        const turn =
          node.closest("article") ||
          node.closest('[data-testid^="conversation-turn-"]') ||
          node;
        const content =
          turn.querySelector(".markdown") ||
          turn.querySelector('[class*="markdown"]') ||
          (role === "user" ? turn.querySelector('[class*="whitespace-pre-wrap"]') : null) ||
          node;
        return { role, content };
      });
    }

    const turns = uniqueElements([
      ...document.querySelectorAll(
        'article[data-testid^="conversation-turn-"], [data-testid^="conversation-turn-"]',
      ),
    ]);

    return turns
      .map((turn) => {
        const roleNode = turn.querySelector("[data-message-author-role]");
        const role = roleNode && roleNode.getAttribute("data-message-author-role");
        if (!role) return null;
        const content =
          turn.querySelector(".markdown") ||
          turn.querySelector('[class*="markdown"]') ||
          turn.querySelector('[class*="whitespace-pre-wrap"]') ||
          roleNode;
        return { role, content };
      })
      .filter(Boolean);
  }

  function geminiMessages() {
    const explicit = uniqueElements([
      ...document.querySelectorAll("user-query, model-response"),
    ]);

    if (explicit.length) {
      return explicit.map((node) => {
        const tag = node.tagName.toLowerCase();
        const role = tag === "user-query" ? "user" : "assistant";
        const content =
          node.querySelector("message-content") ||
          node.querySelector(".query-text") ||
          node.querySelector(".response-content") ||
          node.querySelector('[class*="query-text"]') ||
          node.querySelector('[class*="response"]') ||
          node;
        return { role, content };
      });
    }

    const candidates = uniqueElements([
      ...document.querySelectorAll(
        '[class*="user-query"], [class*="query-content"], [class*="model-response"], [class*="response-content"]',
      ),
    ]);

    return candidates
      .map((node) => {
        const marker = (String(node.tagName || "") + " " + String(node.className || "")).toLowerCase();
        const role = /user|query/.test(marker)
          ? "user"
          : /model|response/.test(marker)
            ? "assistant"
            : null;
        return role ? { role, content: node } : null;
      })
      .filter(Boolean);
  }

  function extractConversation() {
    const platform = platformFromHost();
    if (!platform) {
      throw new Error("Esta pestaña no es un chat compatible de ChatGPT o Gemini.");
    }

    const rawMessages = platform === "chatgpt" ? chatGptMessages() : geminiMessages();
    const messages = [];

    for (const item of rawMessages) {
      const markdown = contentToMarkdown(item.content);
      if (!markdown) continue;

      const previous = messages[messages.length - 1];
      if (previous && previous.role === item.role && previous.markdown === markdown) {
        continue;
      }

      messages.push({
        role: item.role === "user" ? "user" : "assistant",
        markdown,
      });
    }

    if (!messages.length) {
      throw new Error(
        "No pude encontrar mensajes en esta conversación de " +
          platformLabel(platform) +
          ". Recarga la pestaña y vuelve a intentarlo.",
      );
    }

    const title = cleanTitle(document.title, platform);
    const sections = messages.map((message) => {
      const heading = message.role === "user" ? "Tú" : platformLabel(platform);
      return "## " + heading + "\n\n" + message.markdown;
    });

    const markdown = [
      "# " + title,
      "",
      sections.join("\n\n---\n\n"),
    ].join("\n").trim();

    return {
      platform,
      platform_label: platformLabel(platform),
      title,
      source_url: location.href,
      message_count: messages.length,
      markdown,
    };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "inspectAiChat") {
      try {
        const result = extractConversation();
        return {
          ok: true,
          platform: result.platform,
          platform_label: result.platform_label,
          title: result.title,
          source_url: result.source_url,
          message_count: result.message_count,
        };
      } catch (error) {
        return {
          ok: false,
          error: (error && error.message) || String(error),
        };
      }
    }

    if (message && message.type === "exportAiChatMarkdown") {
      try {
        return {
          ok: true,
          ...extractConversation(),
        };
      } catch (error) {
        return {
          ok: false,
          error: (error && error.message) || String(error),
        };
      }
    }

    return undefined;
  });
})();
