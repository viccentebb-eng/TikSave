// node --test tests/extension
const test = require("node:test");
const assert = require("node:assert/strict");

const noop = () => {};
const listeners = () => ({ addListener: noop });
globalThis.browser = {
  runtime: { id: "x", onInstalled: listeners(), onStartup: listeners(), onMessage: listeners() },
  webRequest: { onHeadersReceived: listeners() },
  tabs: { onUpdated: listeners(), onRemoved: listeners(), sendMessage: noop },
  permissions: { onAdded: listeners(), contains: async () => true },
  scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {} },
  storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async (d) => ({ ...d, ...(globalThis.__store || {}) }) }, onChanged: listeners() },
  cookies: { getAll: async ({ url }) => (globalThis.__cookies || []).filter((c) => url.includes(c.domain.replace(/^\./, ''))) },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
  if (url.endsWith("/api/health")) return { ok: true, json: async () => ({ sites: { TikTok: ["tiktok.com"], YouTube: ["youtube.com"] }, allow_other_sites: true }) };
  if (url.endsWith("/api/download")) return { ok: true, json: async () => ({ id: "job1" }) };
  return { ok: true, json: async () => ({ status: "done", progress: 100 }) };
};
const bg = require("../../extension/background.js");

const hdrs = (o) => ({ responseHeaders: Object.entries(o).map(([name, value]) => ({ name, value })) });

test("classify detecta manifests y archivos grandes, ignora segmentos", () => {
  assert.equal(bg.classify({ url: "https://cdn.x/v/master.m3u8?t=1", ...hdrs({}) }).kind, "manifest");
  assert.equal(bg.classify({ url: "https://cdn.x/video", ...hdrs({ "content-type": "application/dash+xml" }) }).kind, "manifest");
  assert.equal(bg.classify({ url: "https://cdn.x/a.mp4", ...hdrs({ "content-type": "video/mp4", "content-length": "5000000" }) }).kind, "file");
  assert.equal(bg.classify({ url: "https://cdn.x/a.mp4", ...hdrs({ "content-type": "video/mp4", "content-range": "bytes 0-1/9000000" }) }).size, 9000000);
  assert.equal(bg.classify({ url: "https://cdn.x/a.mp4", ...hdrs({ "content-type": "video/mp4", "content-length": "1000" }) }), null); // muy pequeno
  assert.equal(bg.classify({ url: "https://cdn.x/seg1.ts", ...hdrs({ "content-type": "video/mp2t", "content-length": "9000000" }) }), null);
  assert.equal(bg.classify({ url: "https://cdn.x/seg1.m4s", ...hdrs({ "content-type": "video/mp4", "content-length": "9000000" }) }), null);
  assert.equal(bg.classify({ url: "https://cdn.x/page.html", ...hdrs({ "content-type": "text/html" }) }), null);
});

test("bestMedia prefiere el manifest mas reciente y si no, el archivo mas grande", () => {
  const list = [{ url: "a", kind: "file", size: 5 }, { url: "b", kind: "file", size: 50 }];
  assert.equal(bg.bestMedia(list).url, "b");
  assert.equal(bg.bestMedia([...list, { url: "m", kind: "manifest", size: 0 }]).url, "m");
  assert.equal(bg.bestMedia([]), null);
});

test("resolveTarget: sitio conocido usa la pagina o el enlace del video; desconocido usa el stream con referer", async () => {
  let t = await bg.resolveTarget({ pageUrl: "https://www.tiktok.com/foryou", candidate: "https://www.tiktok.com/@a/video/1", directSrc: "blob:x", tabId: 1 });
  assert.equal(t.url, "https://www.tiktok.com/@a/video/1");
  t = await bg.resolveTarget({ pageUrl: "https://www.youtube.com/watch?v=abc", candidate: null, directSrc: "blob:x", tabId: 1 });
  assert.equal(t.url, "https://www.youtube.com/watch?v=abc");
  // sitio desconocido sin streams detectados: src directo con referer
  t = await bg.resolveTarget({ pageUrl: "https://otro.com/p", candidate: null, directSrc: "https://cdn.otro.com/v.mp4", tabId: 99 });
  assert.deepEqual(t, { url: "https://cdn.otro.com/v.mp4", referer: "https://otro.com/p" });
  // blob: sin nada mas -> la pagina (extractor generico)
  t = await bg.resolveTarget({ pageUrl: "https://otro.com/p", candidate: null, directSrc: "blob:abc", tabId: 99 });
  assert.equal(t.url, "https://otro.com/p");
});

test("save envia titulo, modo, inicio y referer al servidor", async () => {
  calls.length = 0;
  const res = await bg.handle({ type: "save", mode: "video", start: 42, directSrc: "https://cdn.otro.com/v.mp4", pageUrl: "https://otro.com/p", title: "Mi video" },
    { id: "x", tab: { id: 7, url: "https://otro.com/p", title: "Mi video" } });
  assert.equal(res.ok, true);
  const body = calls.find((c) => c.url.endsWith("/api/download")).body;
  assert.deepEqual(body, { url: "https://cdn.otro.com/v.mp4", mode: "video", title: "Mi video", referer: "https://otro.com/p", start: 42 });
});

test("save adjunta las cookies del sitio (sin duplicados) y respeta el interruptor", async () => {
  globalThis.__cookies = [
    { name: "sid", value: "abc", domain: ".otro.com", path: "/", secure: true, httpOnly: true, expirationDate: 1900000000 },
    { name: "x", value: "1", domain: "cdn.otro.com", path: "/", secure: false, httpOnly: false },
    { name: "ajena", value: "no", domain: "bank.com", path: "/" },
  ];
  calls.length = 0;
  await bg.handle({ type: "save", mode: "video", directSrc: "https://cdn.otro.com/v.mp4", pageUrl: "https://otro.com/p", title: "T" },
    { id: "x", tab: { id: 7, url: "https://otro.com/p", title: "T" } });
  let body = calls.find((c) => c.url.endsWith("/api/download")).body;
  assert.deepEqual(body.cookies.map((c) => c.name).sort(), ["sid", "x"]);   // solo cookies de los sitios involucrados
  assert.equal(body.cookies.find((c) => c.name === "sid").httpOnly, true);
  globalThis.__store = { useCookies: false };
  calls.length = 0;
  await bg.handle({ type: "save", mode: "video", directSrc: "https://cdn.otro.com/v.mp4", pageUrl: "https://otro.com/p" },
    { id: "x", tab: { id: 7, url: "https://otro.com/p" } });
  body = calls.find((c) => c.url.endsWith("/api/download")).body;
  assert.equal(body.cookies, undefined);
  globalThis.__store = {}; globalThis.__cookies = [];
});

test("desde el popup (sin sender.tab) usa la URL explicita", async () => {
  calls.length = 0;
  const res = await bg.handle({ type: "save", explicitUrl: "https://www.tiktok.com/@a/video/1", mode: "mp3", pageUrl: "https://www.tiktok.com/@a/video/1", tabId: 3 }, { id: "x" });
  assert.equal(res.ok, true);
  assert.equal(calls.find((c) => c.url.endsWith("/api/download")).body.mode, "mp3");
});

test("mensajes del grabador llegan a la API", async () => {
  calls.length = 0;
  await bg.handle({ type: "rec-start", title: "T", pageUrl: "https://a.com" }, { id: "x" });
  await bg.handle({ type: "rec-chunk", id: "r1", seq: 0, data: "AAAA" }, { id: "x" });
  await bg.handle({ type: "rec-finish", id: "r1" }, { id: "x" });
  assert.deepEqual(calls.map((c) => c.url.replace("http://127.0.0.1:8173", "")), ["/api/recordings", "/api/recordings/r1/chunk", "/api/recordings/r1/finish"]);
  assert.deepEqual(calls[1].body, { seq: 0, data: "AAAA" });
});

test("rechaza mensajes de otros remitentes", async () => {
  await assert.rejects(bg.handle({ type: "save" }, { id: "otra-extension" }), /Remitente/);
});
