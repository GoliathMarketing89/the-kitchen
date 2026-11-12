const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");

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
  focus() {}
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
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

function createHarness({ initialSession = 401, chatReplies = [] } = {}) {
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
  const requests = [];
  const sessionStorage = new Map();
  const fetch = (url, options = {}) => {
    requests.push({ url, options });
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
  const context = {
    document,
    window: {},
    fetch,
    sessionStorage: {
      getItem: key => sessionStorage.get(key) ?? null,
      setItem: (key, value) => sessionStorage.set(key, String(value)),
      removeItem: key => sessionStorage.delete(key),
    },
    TextEncoder,
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
  return { elements, getElement, requests, flush, login, send };
}

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
