const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const cssSource = fs.readFileSync(path.join(__dirname, "..", "static", "app.css"), "utf8");

class ClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    enabled ? this.values.add(value) : this.values.delete(value);
    return enabled;
  }
}

class Element {
  constructor(id = "") {
    this.id = id;
    this.listeners = {};
    this.children = [];
    this.classList = new ClassList();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.attributes = {};
    this._innerHTML = "";
  }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  focus() { this.focused = true; }
  click() { return this.listeners.click && this.listeners.click(); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function response(status, data) {
  return { status, ok: status >= 200 && status < 300, json: async () => data };
}

function isWellFormedUnicode(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function createHarness({ initialSession = 401, chatReplies = [], dataReplies = {}, speechSupport = false } = {}) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const tabs = ["chat", "recipes", "shopping", "profit"].map(name => {
    const tab = getElement(`tab-button-${name}`);
    tab.dataset.tab = name;
    return tab;
  });
  getElement("screen-help").hidden = true;
  getElement("chat-screen").hidden = true;
  const requests = [];
  const sessionStorage = new Map();
  const recognitionInstances = [];
  const speechOutput = [];
  const windowListeners = {};
  const speechSynthesis = {
    cancel() {},
    getVoices() { return []; },
    speak(value) { speechOutput.push(value); },
  };
  class FakeRecognition {
    constructor() { this.started = 0; this.aborted = 0; recognitionInstances.push(this); }
    start() { this.started++; }
    stop() {}
    abort() { this.aborted++; }
  }
  const fetch = (url, options = {}) => {
    requests.push({ url, options });
    const queued = dataReplies[url] && dataReplies[url].shift();
    if (queued) return queued.promise || queued;
    if (url === "/api/session") {
      return initialSession.promise || Promise.resolve(response(initialSession, { ok: initialSession === 200 }));
    }
    if (url === "/api/login") return Promise.resolve(response(200, { ok: true }));
    if (url === "/api/logout") return Promise.resolve(response(200, { ok: true }));
    if (url === "/api/chat") {
      const next = chatReplies.shift();
      if (next) return next.promise || next;
      return Promise.resolve(response(200, { ok: true, reply: "synthetic reply" }));
    }
    if (url === "/api/recipes") return Promise.resolve(response(200, { ok: true, recipes: [] }));
    if (url === "/api/shopping-list") return Promise.resolve(response(200, { ok: true, items: [] }));
    if (url === "/api/profit") return Promise.resolve(response(200, { ok: true, sales: [] }));
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const document = {
    getElementById: getElement,
    querySelectorAll: selector => selector === ".tab" ? tabs : [],
    createElement: tag => new Element(tag),
  };
  const window = {
    addEventListener(name, listener) { windowListeners[name] = listener; },
    ...(speechSupport ? { SpeechRecognition: FakeRecognition, speechSynthesis } : {}),
  };
  const context = {
    document,
    window,
    navigator: { onLine: true },
    fetch,
    sessionStorage: {
      getItem: key => sessionStorage.get(key) ?? null,
      setItem: (key, value) => sessionStorage.set(key, String(value)),
      removeItem: key => sessionStorage.delete(key),
    },
    TextEncoder,
    ...(speechSupport ? {
      speechSynthesis,
      SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    } : {}),
    setTimeout,
    console: { log() {}, error() {} },
  };
  vm.runInNewContext(appSource, context, { filename: "static/app.js" });

  const flush = async () => {
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve();
  };
  const login = async () => {
    getElement("user").value = "synthetic owner";
    getElement("pass").value = "synthetic password";
    await getElement("login-form").listeners.submit({ preventDefault() {} });
    await flush();
  };
  const send = value => {
    getElement("input").value = value;
    return getElement("send-btn").listeners.click();
  };
  return { elements, getElement, tabs, requests, recognitionInstances, speechOutput, windowListeners, flush, login, send, context };
}

test("HTML exposes four labelled tabs, linked panels, and a labelled composer", () => {
  assert.match(htmlSource, /<nav[^>]*role="tablist"[^>]*aria-label="Kitchen sections"/);
  const tabs = [...htmlSource.matchAll(/<button[^>]*role="tab"[^>]*aria-controls="tab-[^"]+"/g)];
  assert.equal(tabs.length, 4);
  assert.equal((htmlSource.match(/role="tabpanel"/g) || []).length, 4);
  assert.match(htmlSource, /<label[^>]*for="input"[^>]*>Message<\/label>/);
  assert.match(htmlSource, /<textarea[^>]*id="input"[^>]*aria-label="Message"[^>]*placeholder="Type…"/);
  assert.match(htmlSource, /<button[^>]*id="send-btn"[^>]*aria-label="Send">Send<\/button>/);
  assert.match(htmlSource, /id="messages"[^>]*role="log"[^>]*aria-label="Conversation"[^>]*aria-live="polite"/);
});

test("phone layout reserves screen height, safe areas, and reachable touch controls", () => {
  assert.match(cssSource, /height:\s*100dvh/);
  assert.match(cssSource, /env\(safe-area-inset-top\)/);
  assert.match(cssSource, /env\(safe-area-inset-bottom\)/);
  assert.match(cssSource, /\.tab, \.voice-toggle, summary \{ min-height: 48px/);
  assert.match(cssSource, /\.composer textarea \{ min-width: 0; min-height: 48px/);
  assert.match(cssSource, /@media \(max-height: 550px\)/);
  assert.match(cssSource, /min-height: 0/);
});

test("restores a valid server session into the chat screen", async () => {
  const h = createHarness({ initialSession: 200 });
  await h.flush();
  assert.equal(h.getElement("login-screen").hidden, true);
  assert.equal(h.getElement("chat-screen").hidden, false);
});

test("a delayed startup session check cannot override a new login", async () => {
  const startup = deferred();
  const h = createHarness({ initialSession: startup });
  await h.login();
  const messagesAfterLogin = h.getElement("messages").children.length;
  startup.resolve(response(200, { ok: true }));
  await h.flush();

  assert.equal(h.getElement("chat-screen").hidden, false);
  assert.equal(h.getElement("login-screen").hidden, true);
  assert.equal(h.getElement("messages").children.length, messagesAfterLogin);
});

test("logout clears private state and contacts the server", async () => {
  const h = createHarness();
  await h.login();
  h.getElement("input").value = "unsent private draft";
  h.getElement("recipes-list").innerHTML = "private data";
  h.getElement("logout-btn").listeners.click();
  await h.flush();

  assert.equal(h.getElement("chat-screen").hidden, true);
  assert.equal(h.getElement("login-screen").hidden, false);
  assert.equal(h.getElement("input").value, "");
  assert.equal(h.getElement("recipes-list").innerHTML, "");
  assert.ok(h.requests.some(request => request.url === "/api/logout"));
});

test("a delayed response from an ended session cannot appear after re-login", async () => {
  const oldReply = deferred();
  const h = createHarness({ chatReplies: [oldReply] });
  await h.login();
  const oldSend = h.send("old session question");
  await h.flush();
  h.getElement("logout-btn").listeners.click();
  await h.flush();
  await h.login();
  oldReply.resolve(response(200, { ok: true, reply: "stale private reply" }));
  await oldSend;

  assert.equal(h.getElement("chat-screen").hidden, false);
  assert.equal(h.getElement("messages").children.some(child => child.textContent === "stale private reply"), false);
});

test("an old 401 cannot clear a newer session", async () => {
  const oldUnauthorized = deferred();
  const h = createHarness({ chatReplies: [oldUnauthorized] });
  await h.login();
  const oldSend = h.send("old session question");
  await h.flush();
  h.getElement("logout-btn").listeners.click();
  await h.flush();
  await h.login();
  oldUnauthorized.resolve(response(401, { ok: false }));
  await oldSend;

  assert.equal(h.getElement("chat-screen").hidden, false);
  assert.equal(h.getElement("login-screen").hidden, true);
});

test("duplicate send clicks produce one chat request", async () => {
  const pending = deferred();
  const h = createHarness({ chatReplies: [pending] });
  await h.login();
  const first = h.send("one request");
  const second = h.send("duplicate request");
  assert.equal(h.requests.filter(request => request.url === "/api/chat").length, 1);
  pending.resolve(response(200, { ok: true, reply: "synthetic reply" }));
  await Promise.all([first, second]);
});

test("outgoing emoji history remains valid JSON and below the UTF-8 body limit", async () => {
  const largeReply = response(200, { ok: true, reply: "x" + "🍰".repeat(4000) });
  const h = createHarness({ chatReplies: Array(4).fill(largeReply) });
  await h.login();
  for (let i = 0; i < 3; i++) await h.send(`question ${i}`);
  await h.send("next question 🍰");

  const request = h.requests.filter(item => item.url === "/api/chat").at(-1);
  const body = JSON.parse(request.options.body);
  assert.ok(new TextEncoder().encode(request.options.body).length <= 32768);
  assert.ok(body.history.length <= 6);
  assert.ok(body.history.some(turn => turn.content.includes("🍰")));
  for (const turn of body.history) {
    assert.ok(Array.from(turn.content).length <= 4000);
    assert.equal(isWellFormedUnicode(turn.content), true);
  }
});

test("keyboard arrows, Home and End move the selected tab and focus", async () => {
  const h = createHarness();
  await h.login();
  const move = (tab, key) => tab.listeners.keydown({ key, preventDefault() {} });

  move(h.tabs[0], "ArrowRight");
  assert.equal(h.tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(h.tabs[1].tabIndex, 0);
  assert.equal(h.tabs[1].focused, true);
  assert.equal(h.getElement("tab-recipes").classList.contains("active"), true);

  move(h.tabs[1], "End");
  assert.equal(h.tabs[3].getAttribute("aria-selected"), "true");
  move(h.tabs[3], "Home");
  assert.equal(h.tabs[0].getAttribute("aria-selected"), "true");
});

test("one navigation row keeps the four tabs and never sends chat commands", async () => {
  assert.equal((htmlSource.match(/role="tablist"/g) || []).length, 1);
  assert.doesNotMatch(htmlSource, /id="shortcuts"/);
  const h = createHarness();
  await h.login();
  assert.equal(h.tabs.length, 4);
  h.tabs[2].click();
  await h.flush();
  assert.equal(h.getElement("tab-shopping").classList.contains("active"), true);
  assert.equal(h.requests.some(request => request.url === "/api/chat"), false);
});

test("composer draft survives tab changes", async () => {
  const h = createHarness();
  await h.login();
  h.getElement("input").value = "my unsent draft";
  h.tabs[1].click();
  await h.flush();
  h.tabs[0].click();
  assert.equal(h.getElement("input").value, "my unsent draft");
});

test("dictation remains a draft when reply speech is enabled", async () => {
  const h = createHarness({ speechSupport: true });
  await h.login();
  assert.equal(h.speechOutput.length, 0);
  h.getElement("voice-btn").click();
  assert.equal(h.getElement("voice-btn").getAttribute("aria-pressed"), "true");
  h.getElement("mic-btn").click();
  const recognition = h.recognitionInstances[0];
  recognition.onresult({ results: [[{ transcript: "add two cakes" }]] });

  assert.equal(h.getElement("input").value, "add two cakes");
  assert.equal(h.requests.some(request => request.url === "/api/chat"), false);
  assert.equal(h.speechOutput.length, 0);

  await h.send("add two cakes");
  assert.equal(h.requests.some(request => request.url === "/api/chat"), true);
  assert.equal(h.speechOutput.length, 1);
});

test("offline send keeps the draft and never queues or sends it", async () => {
  const h = createHarness();
  await h.login();
  h.context.navigator.onLine = false;
  h.windowListeners.offline();
  h.getElement("input").value = "sale to enter later";
  const historyBefore = h.getElement("messages").children.length;

  await h.getElement("send-btn").click();

  assert.equal(h.getElement("input").value, "sale to enter later");
  assert.equal(h.getElement("connection-status").textContent, "Offline");
  assert.match(h.getElement("help-connection-status").textContent, /reconnect before sending/i);
  assert.equal(h.getElement("messages").children.length, historyBefore + 1);
  assert.equal(h.requests.some(request => request.url === "/api/chat"), false);
});

test("stale microphone recognition cannot type into a later session", async () => {
  const h = createHarness({ speechSupport: true });
  await h.login();
  h.getElement("mic-btn").click();
  const oldRecognition = h.recognitionInstances[0];
  h.getElement("logout-btn").click();
  await h.flush();
  await h.login();
  oldRecognition.onresult({ results: [[{ transcript: "old session words" }]] });

  assert.equal(h.getElement("input").value, "");
  assert.equal(oldRecognition.aborted, 1);
});

test("uncertain chat failure restores the draft and warns before retry", async () => {
  const failedRequest = deferred();
  const h = createHarness({ chatReplies: [failedRequest.promise] });
  await h.login();
  const send = h.send("record a sale");
  failedRequest.reject(new Error("connection dropped"));
  await send;

  assert.equal(h.getElement("input").value, "record a sale");
  assert.ok(h.getElement("messages").children.some(node =>
    node.textContent.includes("may still have been processed") && node.textContent.includes("Check your records")));
  assert.equal(h.requests.filter(request => request.url === "/api/chat").length, 1);
});

test("chat failure does not overwrite a newer draft typed while waiting", async () => {
  const pending = deferred();
  const h = createHarness({ chatReplies: [pending] });
  await h.login();
  const send = h.send("first request");
  await h.flush();
  h.getElement("input").value = "newer draft";
  pending.resolve(response(200, { ok: false, error: "uncertain" }));
  await send;

  assert.equal(h.getElement("input").value, "newer draft");
  assert.ok(h.getElement("messages").children.some(node => node.textContent.includes("Check your records")));
});

test("successful HTTP responses with agent timeout/error text are still unconfirmed", async () => {
  for (const agentReply of [
    "Sorry — that took too long. Could you try again?",
    "Sorry, the assistant could not complete that request. Please try again.",
    "Something went wrong on my end. Please try again.",
    "",
  ]) {
    const h = createHarness({ chatReplies: [response(200, { ok: true, reply: agentReply })] });
    await h.login();
    await h.send("change an item");
    assert.equal(h.getElement("input").value, "change an item");
    assert.ok(h.getElement("messages").children.some(node =>
      node.textContent.includes("could not be confirmed") && node.textContent.includes("Check your records")));
  }
});

test("only the newest refresh response replaces a data panel", async () => {
  const older = deferred();
  const newer = deferred();
  const h = createHarness({ dataReplies: { "/api/recipes": [older, newer] } });
  await h.login();
  h.tabs[1].click();
  h.getElement("recipes-refresh").click();
  newer.resolve(response(200, { ok: true, recipes: [{ name: "new", price: 44, ingredient_cost: 10 }] }));
  await h.flush();
  older.resolve(response(200, { ok: true, recipes: [{ name: "old", price: 11, ingredient_cost: 5 }] }));
  await h.flush();

  const rows = h.getElement("recipes-list").children.map(row => row.innerHTML).join(" ");
  assert.match(rows, /44/);
  assert.doesNotMatch(rows, /11/);
});

test("missing recipe price and cost render as incomplete", async () => {
  const h = createHarness({ dataReplies: {
    "/api/recipes": [response(200, { ok: true, recipes: [
      { name: "unpriced", price: 0, ingredient_cost: 0 },
      { name: "unknown cost", price: null, ingredient_cost: null },
      { name: "undefined price", ingredient_cost: 10 },
    ] })],
  } });
  await h.login();
  h.tabs[1].click();
  await h.flush();
  const rows = h.getElement("recipes-list").children.map(row => row.innerHTML).join(" ");
  assert.match(rows, /Price not set/);
  assert.match(rows, /Cost needs checking/);
});

test("screen help follows the selected tab and updates its expanded state", async () => {
  const h = createHarness();
  await h.login();
  const help = h.getElement("screen-help");
  const button = h.getElement("help-btn");

  h.tabs[2].click();
  assert.match(h.getElement("help-content").textContent, /starting list.*quantities and units/i);
  button.click();
  assert.equal(help.hidden, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  button.click();
  assert.equal(help.hidden, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");
});

test("unsupported speech voice and denied/no-speech microphone paths stay understandable", async () => {
  const unsupported = createHarness();
  await unsupported.login();
  unsupported.getElement("mic-btn").click();
  assert.ok(unsupported.getElement("messages").children.some(node => node.textContent.includes("doesn't support voice input")));

  const h = createHarness({ speechSupport: true });
  await h.login();
  const recognitionMessageCount = h.getElement("messages").children.length;
  h.getElement("mic-btn").click();
  h.recognitionInstances[0].onerror({ error: "not-allowed" });
  assert.ok(h.getElement("messages").children.some(node => node.textContent.includes("Microphone access was denied")));
  assert.notEqual(h.getElement("messages").children.length, recognitionMessageCount);

  h.getElement("mic-btn").click();
  const beforeAbort = h.getElement("messages").children.length;
  h.recognitionInstances[0].onerror({ error: "aborted" });
  assert.equal(h.getElement("messages").children.length, beforeAbort);
});
