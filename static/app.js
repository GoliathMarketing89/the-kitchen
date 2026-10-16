// The Kitchen Manager — chat window logic.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const loginScreen = $("login-screen");
  const chatScreen = $("chat-screen");
  const messagesEl = $("messages");
  const shortcutsEl = $("shortcuts");
  const input = $("input");
  const sendBtn = $("send-btn");
  const loginForm = $("login-form");
  const loginError = $("login-error");

  // Session flag (in-memory; a refresh re-prompts login — that's fine and safe).
  let authed = false;
  let history = [];

  // Default shortcuts. The owner can change these by asking the manager.
  let shortcuts = [
    "Add a new dish",
    "Change a price",
    "What's on the menu?",
    "Add a photo",
    "Christmas pre-orders",
    "Update my WhatsApp number",
  ];

  // ---------- Login ----------
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("login-btn");
    btn.disabled = true;
    btn.textContent = "Opening…";
    loginError.hidden = true;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: $("user").value, pass: $("pass").value }),
      });
      const raw = await res.text();
      console.log("login raw response:", res.status, raw);
      let data;
      try { data = JSON.parse(raw); } catch (e) { data = { ok: false }; }
      if (data.ok) {
        authed = true;
        loginScreen.hidden = true;
        chatScreen.hidden = false;
        renderShortcuts();
        greet();
      } else {
        loginError.textContent = "Login failed. Server said: " + raw.slice(0, 120);
        loginError.hidden = false;
      }
    } catch (err) {
      loginError.textContent = "Couldn't reach the kitchen: " + (err && err.message ? err.message : err);
      loginError.hidden = false;
      console.error("login fetch error:", err);
    } finally {
      btn.disabled = false;
      btn.textContent = "Open my kitchen";
    }
  });

  $("logout-btn").addEventListener("click", () => {
    authed = false;
    history = [];
    messagesEl.innerHTML = "";
    chatScreen.hidden = true;
    loginScreen.hidden = false;
    $("pass").value = "";
  });

  // ---------- Shortcuts ----------
  function renderShortcuts() {
    shortcutsEl.innerHTML = "";
    shortcuts.forEach((label) => {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = label;
      chip.addEventListener("click", () => {
        input.value = label;
        input.focus();
      });
      shortcutsEl.appendChild(chip);
    });
  }

  // ---------- Messages ----------
  function addMsg(text, who) {
    const el = document.createElement("div");
    el.className = "msg " + who;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function addTyping() {
    const el = document.createElement("div");
    el.className = "msg bot typing";
    el.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function greet() {
    addMsg(
      "Welcome back! I'm your Kitchen Manager. Tell me what you'd like to do — " +
      "add a dish, change a price, update your page, or tap a shortcut below. " +
      "If you're setting up for the first time, let's start with your WhatsApp number.",
      "bot"
    );
  }

  // ---------- Send ----------
  async function send() {
    const text = input.value.trim();
    if (!text || !authed) return;
    input.value = "";
    autoGrow();
    addMsg(text, "user");
    history.push({ role: "user", content: text });

    const typing = addTyping();
    sendBtn.disabled = true;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      });
      const data = await res.json();
      typing.remove();
      if (data.ok) {
        addMsg(data.reply, "bot");
        history.push({ role: "assistant", content: data.reply });
      } else if (data.capped) {
        addMsg(data.reply, "bot");
      } else {
        addMsg(data.error || "Something went wrong. Try again.", "bot");
      }
    } catch (err) {
      typing.remove();
      addMsg("Couldn't reach the kitchen. Check your connection and try again.", "bot");
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }
  input.addEventListener("input", autoGrow);
})();
