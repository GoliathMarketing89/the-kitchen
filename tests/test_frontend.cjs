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

function createHarness({ initialSession = 401, chatReplies = [], dataReplies = {}, passwordReplies = [], speechSupport = false } = {}) {
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
  getElement("password-screen").hidden = true;
  getElement("password-form").hidden = true;
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
    if (url === "/api/change-password") {
      const next = passwordReplies.shift();
      if (next) return next.promise || next;
      return Promise.resolve(response(200, { ok: true }));
    }
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
  const openPasswordForm = () => {
    if (getElement("screen-help").hidden) getElement("help-btn").click();
    getElement("change-password-open").click();
  };
  const submitPasswordForm = () => getElement("password-form").listeners.submit({ preventDefault() {} });
  return { elements, getElement, tabs, requests, recognitionInstances, speechOutput, windowListeners, storage: sessionStorage, flush, login, send, openPasswordForm, submitPasswordForm, context };
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
  assert.match(htmlSource, /<form id="password-form"[^>]*method="post"[^>]*action="\/api\/change-password"/);
  assert.match(htmlSource, /id="current-password"[^>]*autocomplete="current-password"/);
  assert.match(htmlSource, /id="new-password"[^>]*autocomplete="new-password"/);
  assert.match(htmlSource, /id="confirm-password"[^>]*autocomplete="new-password"/);
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

test("password settings open as a separate screen and Cancel clears every secret", async () => {
  const h = createHarness();
  await h.login();
  h.openPasswordForm();
  assert.equal(h.getElement("chat-screen").hidden, true);
  assert.equal(h.getElement("password-screen").hidden, false);
  h.getElement("current-password").value = "synthetic current secret";
  h.getElement("new-password").value = "synthetic new secret phrase";
  h.getElement("confirm-password").value = "synthetic new secret phrase";
  h.getElement("password-cancel").click();

  assert.equal(h.getElement("password-screen").hidden, true);
  assert.equal(h.getElement("chat-screen").hidden, false);
  for (const id of ["current-password", "new-password", "confirm-password"]) {
    assert.equal(h.getElement(id).value, "");
  }
});

test("password form validates shape, surfaces server weak-password feedback, and accepts a Unicode phrase", async () => {
  const h = createHarness({
    passwordReplies: [
      response(400, { ok: false, error: "Choose a less predictable password or a longer phrase." }),
      response(200, { ok: true }),
    ],
  });
  await h.login();
  h.openPasswordForm();
  const currentPassword = h.getElement("current-password");
  const newPassword = h.getElement("new-password");
  const confirmPassword = h.getElement("confirm-password");
  currentPassword.value = "old synthetic password";
  newPassword.value = "short";
  confirmPassword.value = "short";
  await h.submitPasswordForm();
  assert.equal(h.requests.some(request => request.url === "/api/change-password"), false);

  newPassword.value = "passwordpassword";
  confirmPassword.value = "passwordpassword";
  await h.submitPasswordForm();
  assert.equal(h.requests.filter(request => request.url === "/api/change-password").length, 1);
  assert.match(h.getElement("password-error").textContent, /less predictable/i);
  assert.equal(h.getElement("password-screen").hidden, false);

  const phrase = "🥐".repeat(15);
  currentPassword.value = "old synthetic password";
  newPassword.value = phrase;
  confirmPassword.value = phrase;
  await h.submitPasswordForm();
  assert.equal(h.requests.filter(request => request.url === "/api/change-password").length, 2);
  assert.equal(h.getElement("login-screen").hidden, false);
  assert.match(h.getElement("login-error").textContent, /sign in with your new password/i);
});

test("password cancel, success, expiry and logout clear secret fields", async () => {
  const cancelled = createHarness();
  await cancelled.login();
  cancelled.openPasswordForm();
  for (const id of ["current-password", "new-password", "confirm-password"]) cancelled.getElement(id).value = "cancelled synthetic secret";
  cancelled.getElement("password-cancel").click();
  cancelled.getElement("logout-btn").click();
  await cancelled.flush();
  for (const id of ["current-password", "new-password", "confirm-password"]) assert.equal(cancelled.getElement(id).value, "");

  const successful = createHarness();
  await successful.login();
  successful.openPasswordForm();
  successful.getElement("current-password").value = "old synthetic secret";
  successful.getElement("new-password").value = "A long synthetic new phrase";
  successful.getElement("confirm-password").value = "A long synthetic new phrase";
  await successful.submitPasswordForm();
  assert.equal(successful.getElement("password-screen").hidden, true);
  assert.equal(successful.getElement("chat-screen").hidden, true);
  assert.match(successful.getElement("login-error").textContent, /Password changed\. Sign in with your new password\./);
  for (const id of ["current-password", "new-password", "confirm-password"]) assert.equal(successful.getElement(id).value, "");

  const expired = createHarness({ chatReplies: [response(401, { ok: false })] });
  await expired.login();
  expired.openPasswordForm();
  for (const id of ["current-password", "new-password", "confirm-password"]) expired.getElement(id).value = "expired synthetic secret";
  await expired.send("check session");
  assert.equal(expired.getElement("login-screen").hidden, false);
  for (const id of ["current-password", "new-password", "confirm-password"]) assert.equal(expired.getElement(id).value, "");
});

test("unknown password-change result signs out without repopulating secrets or replaying", async () => {
  const h = createHarness({ passwordReplies: [response(503, { ok: false, error: "Password update could not be confirmed." })] });
  await h.login();
  h.openPasswordForm();
  h.getElement("current-password").value = "old synthetic secret";
  h.getElement("new-password").value = "A long synthetic new phrase";
  h.getElement("confirm-password").value = "A long synthetic new phrase";
  await h.submitPasswordForm();

  assert.equal(h.requests.filter(request => request.url === "/api/change-password").length, 1);
  assert.match(h.getElement("login-error").textContent, /could not be confirmed.*signing in/i);
  assert.equal(h.getElement("login-screen").hidden, false);
  for (const id of ["current-password", "new-password", "confirm-password"]) assert.equal(h.getElement(id).value, "");
});

test("duplicate password submits send once, pending changes block re-login, and stale success is ignored", async () => {
  const recipesUnauthorized = deferred();
  const changeReply = deferred();
  const h = createHarness({
    dataReplies: { "/api/recipes": [recipesUnauthorized] },
    passwordReplies: [changeReply],
  });
  await h.login();
  h.tabs[1].click();
  await h.flush();
  h.openPasswordForm();
  h.getElement("current-password").value = "old synthetic secret";
  h.getElement("new-password").value = "Old request phrase 2032 🥐";
  h.getElement("confirm-password").value = "Old request phrase 2032 🥐";
  const first = h.submitPasswordForm();
  const duplicate = h.submitPasswordForm();
  assert.equal(h.requests.filter(request => request.url === "/api/change-password").length, 1);

  recipesUnauthorized.resolve(response(401, { ok: false }));
  await h.flush();
  assert.equal(h.getElement("login-screen").hidden, false);
  assert.equal(h.getElement("login-btn").disabled, true);
  const loginRequests = h.requests.filter(request => request.url === "/api/login").length;
  await h.login();
  assert.equal(h.requests.filter(request => request.url === "/api/login").length, loginRequests);

  changeReply.resolve(response(200, { ok: true }));
  await Promise.all([first, duplicate]);
  assert.equal(h.getElement("login-screen").hidden, false);
  assert.doesNotMatch(h.getElement("login-error").textContent, /Password changed/);

  await h.login();
  assert.equal(h.getElement("chat-screen").hidden, false);
});

test("password values never enter chat history or browser storage", async () => {
  const h = createHarness();
  await h.login();
  h.openPasswordForm();
  h.getElement("current-password").value = "synthetic old-secret-keep-out";
  h.getElement("new-password").value = "synthetic new-secret-keep-out";
  h.getElement("confirm-password").value = "synthetic new-secret-keep-out";

  await h.send("ordinary message");
  const chatRequest = h.requests.find(request => request.url === "/api/chat");
  assert.ok(chatRequest);
  assert.doesNotMatch(chatRequest.options.body, /old-secret|new-secret-keep-out/);
  for (const storedValue of h.storage.values()) {
    assert.doesNotMatch(storedValue, /old-secret|new-secret-keep-out/);
  }
});
