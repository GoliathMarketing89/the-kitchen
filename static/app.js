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
  const micBtn = $("mic-btn");
  const voiceBtn = $("voice-btn");
  const voiceDot = $("voice-dot");
  const voiceLabel = $("voice-label");

  let authed = false;
  let generation = 0;
  let sending = false;
  let authPending = false;
  // Storage may be unavailable in private or restricted browser contexts.
  const logoutMarker = {
    get() { try { return sessionStorage.getItem("kitchenLogoutPending"); } catch (_) { return null; } },
    set() { try { sessionStorage.setItem("kitchenLogoutPending", "1"); } catch (_) {} },
    clear() { try { sessionStorage.removeItem("kitchenLogoutPending"); } catch (_) {} },
  };

  async function apiFetch(url, options) {
    const started = generation;
    const response = await fetch(url, options);
    if (response.status === 401 && started === generation && authed) {
      clearSession();
      loginError.textContent = "Your session expired. Please sign in again.";
      loginError.hidden = false;
    }
    return response;
  }
  let history = [];

  // Speech support flags
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micSupported = !!SpeechRec;
  const ttsSupported = "speechSynthesis" in window;

  // Voice chat state
  let voiceOn = false;
  let recognition = null;
  let recogActive = false;

  // Default shortcuts. The owner can change these by asking the manager.
  let shortcuts = [
    "Add a new dish",
    "Change a price",
    "What's on the menu?",
    "Add a photo",
    "Christmas pre-orders",
    "Update my WhatsApp number",
  ];

  // ---------- Text-to-speech (voice chat replies) ----------
  function speak(text) {
    if (!voiceOn || !ttsSupported) return;
    // Stop anything currently talking so replies don't pile up.
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(cleanForSpeech(text));
    u.lang = "en-US";
    u.rate = 1;
    u.pitch = 1;
    // Pick a slightly warmer female voice if available.
    const voices = speechSynthesis.getVoices();
    const pick = voices.find(v => /female|Samantha|Google US English|Zira/i.test(v.name)) || voices[0];
    if (pick) u.voice = pick;
    speechSynthesis.speak(u);
  }

  // Strip emoji / markdown-ish symbols so TTS doesn't stumble.
  function cleanForSpeech(text) {
    return text
      .replace(/[•▪]/g, " ")
      .replace(/[*_`>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---------- Speech recognition (mic -> text) ----------
  function initRecognition() {
    if (!micSupported || recognition) return;
    recognition = new SpeechRec();
    const recordingGeneration = generation;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (e) => {
      if (!authed || recordingGeneration !== generation) return;
      recogActive = false;
      setMicState(false);
      const transcript = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join(" ")
        .trim();
      if (transcript) {
        input.value = transcript;
        autoGrow();
        input.focus();
        // If voice chat is on, sending is a nice hands-free touch.
        if (voiceOn) send();
      }
    };
    recognition.onerror = (e) => {
      if (!authed || recordingGeneration !== generation) return;
      recogActive = false;
      setMicState(false);
      if (authed && recordingGeneration === generation) addMsg("Sorry, I couldn't catch that — please try again or type it.", "bot");
    };
    recognition.onend = () => {
      if (!authed || recordingGeneration !== generation) return;
      recogActive = false;
      setMicState(false);
    };
  }

  function toggleMic() {
    if (!micSupported) {
      addMsg("This browser doesn't support voice input. Try Chrome or Safari on a phone.", "bot");
      return;
    }
    initRecognition();
    if (recogActive) {
      recognition.stop();
      setMicState(false);
      recogActive = false;
    } else {
      try {
        recognition.start();
        recogActive = true;
        setMicState(true);
      } catch (err) {
        // .start() throws if already started; reset and try once.
        recognition.abort();
        const retryGeneration = generation;
        setTimeout(() => {
          if (authed && retryGeneration === generation && recognition) { try { recognition.start(); recogActive = true; setMicState(true); } catch (e2) {} }
        }, 100);
      }
    }
  }

  function setMicState(recording) {
    micBtn.classList.toggle("recording", recording);
    micBtn.title = recording ? "Listening… tap to stop" : "Tap to speak — I'll type it for you";
    micBtn.setAttribute("aria-label", recording ? "Stop listening" : "Speak");
  }

  micBtn.addEventListener("click", toggleMic);

  // ---------- Voice chat toggle ----------
  function toggleVoice() {
    if (!ttsSupported) {
      addMsg("This browser doesn't support voice replies.", "bot");
      return;
    }
    voiceOn = !voiceOn;
    voiceBtn.classList.toggle("on", voiceOn);
    voiceLabel.textContent = voiceOn ? "Voice chat is on" : "Turn on voice chat";
    if (!voiceOn) speechSynthesis.cancel();
    else {
      addMsg("Voice chat is on. I'll read my replies aloud — just tap the mic and talk.", "bot");
      speak("Voice chat is on. I'll read my replies aloud — just tap the microphone and talk.");
    }
  }

  voiceBtn.addEventListener("click", toggleVoice);

  // ---------- Login ----------
  function openSession() {
    generation++;
    logoutMarker.clear();
    authed = true;
    loginScreen.hidden = true;
    chatScreen.hidden = false;
    $("pass").value = "";
    loginError.hidden = true;
    showTab("chat");
    renderShortcuts();
    greet();
  }

  function clearSession() {
    generation++;
    authed = false;
    sending = false;
    sendBtn.disabled = false;
    if (recognition && recogActive) recognition.abort();
    recognition = null;
    recogActive = false;
    setMicState(false);
    if (ttsSupported) speechSynthesis.cancel();
    voiceOn = false;
    voiceBtn.classList.remove("on");
    voiceLabel.textContent = "Turn on voice chat";
    history = [];
    input.value = "";
    autoGrow();
    messagesEl.innerHTML = "";
    $("recipes-list").innerHTML = "";
    $("shopping-list").innerHTML = "";
    $("profit-summary").innerHTML = "";
    $("sales-log").innerHTML = "";
    showTab("chat");
    chatScreen.hidden = true;
    loginScreen.hidden = false;
    $("pass").value = "";
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (authPending) return;
    authPending = true;
    const started = ++generation;
    const btn = $("login-btn");
    btn.disabled = true;
    btn.textContent = "Opening…";
    loginError.hidden = true;
    try {
      const res = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: $("user").value, pass: $("pass").value }),
      });
      const data = await res.json();
      if (started !== generation) return;
      if (res.ok && data.ok) openSession();
      else {
        loginError.textContent = data.error || "Couldn't sign in. Please try again.";
        loginError.hidden = false;
      }
    } catch (err) {
      if (started === generation) {
        loginError.textContent = "Couldn't reach the kitchen. Please try again.";
        loginError.hidden = false;
      }
    } finally {
      authPending = false;
      btn.disabled = false;
      btn.textContent = "Open my kitchen";
    }
  });

  async function endServerSession() {
    if (authPending) return;
    authPending = true;
    const ended = generation;
    const btn = $("login-btn");
    btn.disabled = true;
    loginError.hidden = true;
    try {
      const res = await fetch("/api/logout", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!res.ok && res.status !== 401) throw new Error("logout failed");
      logoutMarker.clear();
    } catch (err) {
      if (generation === ended) {
        loginError.textContent = "Could not confirm sign-out on the server. ";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Retry sign-out";
        retry.addEventListener("click", endServerSession);
        loginError.appendChild(retry);
        loginError.hidden = false;
      }
    } finally {
      authPending = false;
      btn.disabled = false;
    }
  }

  $("logout-btn").addEventListener("click", () => {
    logoutMarker.set();
    clearSession();
    endServerSession();
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
          const greeting =
            "Welcome back! I've got some new things for you. 🎤\n\n" +
            "You'll see four tabs at the top:\n" +
            "• Chat — talk to me here, like always.\n" +
            "• Recipes — what each dish costs to make, and whether the price is fair.\n" +
            "• Shopping list — everything you need for the week's menu, all added up.\n" +
            "• Money — what you've sold, what it cost, and what you kept.\n\n" +
            "You can also tap the mic 🎤 and just talk — I'll type it for you.\n\n" +
            "And here's the best part: if you ever want something new — a different tab, a new way to plan, anything — just ask. I can add it for you.\n\n" +
            "Want to start by adding a recipe, or shall I walk you through it?";
          addMsg(greeting, "bot");
          speak(greeting);
        }

  // ---------- Send ----------
  async function send() {
    const text = input.value.trim();
    if (!text || !authed || sending) return;
    sending = true;
    const started = generation;
    input.value = "";
    autoGrow();
    addMsg(text, "user");
    history.push({ role: "user", content: text });

    const typing = addTyping();
    sendBtn.disabled = true;
    try {
      const context = history.slice(0, -1).slice(-6).map(turn => ({
        role: turn.role,
        content: Array.from(turn.content).slice(0, 4000).join(""),
      }));
      let body = JSON.stringify({ message: text, history: context });
      while (context.length && new TextEncoder().encode(body).length > 32768) {
        context.shift();
        body = JSON.stringify({ message: text, history: context });
      }
      const res = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const data = await res.json();
      if (started !== generation || !authed) return;
      typing.remove();
      let reply;
      if (data.ok) {
        reply = data.reply;
        addMsg(reply, "bot");
        history.push({ role: "assistant", content: reply });
      } else if (data.capped) {
        reply = data.reply;
        addMsg(reply, "bot");
      } else {
        reply = data.error || "Something went wrong. Try again.";
        addMsg(reply, "bot");
      }
      speak(reply);
    } catch (err) {
      if (started !== generation || !authed) return;
      typing.remove();
      const msg = "Couldn't reach the kitchen. Check your connection and try again.";
      addMsg(msg, "bot");
      speak(msg);
    } finally {
      if (started === generation && authed) {
        sending = false;
        sendBtn.disabled = false;
        if ($("tab-chat").classList.contains("active")) input.focus();
      }
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

  // Pre-warm voices list for TTS (async population on some browsers).
  if (ttsSupported) {
    speechSynthesis.onvoiceschanged = () => {};
    speechSynthesis.getVoices();
  }

  // ---------- Tabs ----------
  const tabBtns = document.querySelectorAll(".tab");
  const tabPanels = {
    chat: $("tab-chat"),
    recipes: $("tab-recipes"),
    shopping: $("tab-shopping"),
    profit: $("tab-profit"),
  };

  function showTab(name) {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    Object.entries(tabPanels).forEach(([k, el]) => el.classList.toggle("active", k === name));
    if (name === "recipes") loadRecipes();
    else if (name === "shopping") loadShopping();
    else if (name === "profit") loadProfit();
  }
  tabBtns.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  ["recipes-refresh", "shopping-refresh", "profit-refresh"].forEach((id) => {
    $(id).addEventListener("click", () => {
      const map = { "recipes-refresh": "recipes", "shopping-refresh": "shopping", "profit-refresh": "profit" };
      const t = map[id];
      if (t === "recipes") loadRecipes();
      else if (t === "shopping") loadShopping();
      else loadProfit();
    });
  });

  async function loadRecipes() {
    const el = $("recipes-list");
    el.innerHTML = '<div class="empty-note">Loading…</div>';
    const started = generation;
    try {
      const r = await apiFetch("/api/recipes");
      const d = await r.json();
      if (started !== generation || !authed) return;
      if (!d.ok) throw new Error("bad response");
      const recs = d.recipes || [];
      if (!recs.length) {
        el.innerHTML = '<div class="empty-note">No recipes saved yet. Tell me a dish and its ingredients and I\'ll track the cost for you.</div>';
        return;
      }
      el.innerHTML = "";
      recs.forEach((rc) => {
        const row = document.createElement("div");
        row.className = "data-row";
        const margin = rc.margin_pct >= 30 ? "d-good" : "d-warn";
        row.innerHTML =
          '<div class="d-main">' + esc(rc.name) + '</div>' +
          '<div class="d-right"><div class="val">฿' + rc.price + '</div>' +
          '<div class="' + margin + '">' + rc.margin_pct + '% margin</div></div>';
        el.appendChild(row);
      });
    } catch (e) {
      if (started !== generation || !authed) return;
      el.innerHTML = '<div class="empty-note">Couldn\u2019t load recipes. Try the Refresh button.</div>';
    }
  }

  async function loadShopping() {
    const el = $("shopping-list");
    el.innerHTML = '<div class="empty-note">Loading…</div>';
    const started = generation;
    try {
      const r = await apiFetch("/api/shopping-list");
      const d = await r.json();
      if (started !== generation || !authed) return;
      if (!d.ok) throw new Error("bad");
      const items = d.items || [];
      if (!items.length) {
        el.innerHTML = '<div class="empty-note">No shopping list yet. Once dishes have recipes, your list builds itself here.</div>';
        return;
      }
      el.innerHTML = "";
      items.forEach((it) => {
        const row = document.createElement("div");
        row.className = "data-row";
        row.innerHTML =
          '<div class="d-main">' + esc(it.item) + ' <span class="d-sub">' + esc(it.qty) + ' ' + esc(it.unit) + '</span></div>' +
          '<div class="d-right"><div class="val">฿' + it.est_cost + '</div></div>';
        el.appendChild(row);
      });
      const total = document.createElement("div");
      total.className = "data-row";
      total.innerHTML = '<div class="d-main">Total cost</div><div class="d-right"><div class="val">฿' + d.total_cost + '</div></div>';
      el.appendChild(total);
    } catch (e) {
      if (started !== generation || !authed) return;
      el.innerHTML = '<div class="empty-note">Couldn\u2019t load the list. Try Refresh.</div>';
    }
  }

  async function loadProfit() {
    const sg = $("profit-summary");
    const sl = $("sales-log");
    const started = generation;
    try {
      const r = await apiFetch("/api/profit");
      const d = await r.json();
      if (started !== generation || !authed) return;
      if (!d.ok) throw new Error("bad");
      const profitCls = d.profit >= 0 ? "pgreen" : "pred";
      sg.innerHTML =
        '<h2>This week</h2>' +
        '<div class="profit-grid">' +
        '<div class="profit-cell"><div class="plabel">Sold</div><div class="pvalue">฿' + d.revenue + '</div></div>' +
        '<div class="profit-cell"><div class="plabel">Cost</div><div class="pvalue">฿' + d.ingredient_cost + '</div></div>' +
        '<div class="profit-cell ' + profitCls + '"><div class="plabel">Kept</div><div class="pvalue">฿' + d.profit + '</div></div>' +
        '</div>';
      const sales = d.sales || [];
      if (!sales.length) {
        sl.innerHTML = '<div class="empty-note">No sales logged yet. Tell me \u201CI sold 3 lasagnas\u201D and I\u2019ll add them up here.</div>';
      } else {
        sl.innerHTML = "";
        sales.forEach((s) => {
          const row = document.createElement("div");
          row.className = "data-row";
          row.innerHTML =
            '<div class="d-main">' + esc(s.dish) + ' <span class="d-sub">x' + (s.qty || 1) + '</span></div>' +
            '<div class="d-right"><div class="val">฿' + (s.price || 0) + '</div></div>';
          sl.appendChild(row);
        });
      }
    } catch (e) {
      if (started !== generation || !authed) return;
      sg.innerHTML = '<div class="empty-note">Couldn\u2019t load your numbers. Try Refresh.</div>';
      sl.innerHTML = "";
    }
  }

  function esc(t) {
    const d = document.createElement("div");
    d.textContent = t == null ? "" : String(t);
    return d.innerHTML;
  }

  // Open the chat tab by default after login.
  showTab("chat");
  const initialGeneration = generation;
  if (logoutMarker.get()) {
    endServerSession();
  } else fetch("/api/session").then((response) => {
    if (response.ok && initialGeneration === generation) openSession();
  }).catch(() => {
    if (initialGeneration === generation) {
      loginError.textContent = "Couldn't check your session. Please sign in.";
      loginError.hidden = false;
    }
  });
})();
