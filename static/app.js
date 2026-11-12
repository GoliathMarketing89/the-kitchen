// The Kitchen Manager — chat window logic.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const loginScreen = $("login-screen");
  const chatScreen = $("chat-screen");
  const messagesEl = $("messages");
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

  const requestSequence = { recipes: 0, shopping: 0, profit: 0 };

  function updateConnection() {
    const offline = navigator.onLine === false;
    $("connection-status").textContent = offline ? "Offline" : "Network available";
    $("help-connection-status").textContent = offline
      ? "Your browser reports that you are offline. Reconnect before sending."
      : "Your browser reports a network connection. The kitchen may still be unavailable.";
  }
  window.addEventListener("online", updateConnection);
  window.addEventListener("offline", updateConnection);
  updateConnection();

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
        // Dictation remains a draft until the owner chooses to send it.
      }
    };
    recognition.onerror = (e) => {
      if (!authed || recordingGeneration !== generation) return;
      recogActive = false;
      setMicState(false);
      if (e.error === "aborted") return;
      const message = e.error === "not-allowed" || e.error === "service-not-allowed"
        ? "Microphone access was denied. Allow it in your browser settings, or type your message."
        : e.error === "no-speech"
          ? "I didn't hear anything. Tap the microphone to try again, or type your message."
          : "The microphone couldn't finish. Try again or type your message.";
      addMsg(message, "bot");
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
    voiceLabel.textContent = voiceOn ? "Read replies aloud: on" : "Read replies aloud: off";
    voiceBtn.setAttribute("aria-pressed", String(voiceOn));
    if (!voiceOn) speechSynthesis.cancel();
    else {
      addMsg("I'll read replies aloud. Dictated messages stay in the box until you send them.", "bot");
    }
  }

  voiceBtn.addEventListener("click", toggleVoice);

  // ---------- Login ----------
  const passwordForm = $("password-form");
  const passwordScreen = $("password-screen");
  const passwordOpen = $("change-password-open");
  let passwordPending = false;

  function closePasswordForm() {
    $("current-password").value = "";
    $("new-password").value = "";
    $("confirm-password").value = "";
    $("password-error").textContent = "";
    $("password-error").hidden = true;
    passwordForm.hidden = true;
    passwordScreen.hidden = true;
    if (authed) chatScreen.hidden = false;
    passwordOpen.setAttribute("aria-expanded", "false");
  }

  passwordOpen.addEventListener("click", () => {
    if (passwordPending) return;
    if (!passwordForm.hidden) { closePasswordForm(); return; }
    chatScreen.hidden = true;
    passwordScreen.hidden = false;
    passwordForm.hidden = false;
    passwordOpen.setAttribute("aria-expanded", "true");
    $("current-password").focus();
  });
  $("password-cancel").addEventListener("click", () => {
    closePasswordForm();
    passwordOpen.focus();
  });
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!authed || passwordPending) return;
    const current = $("current-password").value;
    const next = $("new-password").value;
    const confirm = $("confirm-password").value;
    const error = $("password-error");
    error.hidden = true;
    if (Array.from(next).length < 15 || next !== confirm || next === current) {
      error.textContent = "Use at least 15 characters, choose a different password, and make sure both new passwords match.";
      error.hidden = false;
      return;
    }
    const started = generation;
    passwordPending = true;
    $("password-save").disabled = true;
    $("password-cancel").disabled = true;
    passwordOpen.disabled = true;
    try {
      const response = await apiFetch("/api/change-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next, confirm_password: confirm }),
      });
      const data = await response.json();
      if (started !== generation || !authed) return;
      if (response.ok && data.ok) {
        clearSession();
        loginError.textContent = "Password changed. Sign in with your new password.";
        loginError.hidden = false;
      } else if (response.status >= 500 && data.error !== "Password change is not configured.") {
        logoutMarker.set();
        clearSession();
        loginError.textContent = "The password change could not be confirmed. Try signing in with your new password, or your previous password if it did not change.";
        loginError.hidden = false;
      } else {
        error.textContent = data.error || "Password could not be changed. Please try again.";
        error.hidden = false;
      }
    } catch (_) {
      if (started === generation && authed) {
        logoutMarker.set();
        clearSession();
        loginError.textContent = "The password change could not be confirmed. Try signing in with your new password, or your previous password if it did not change.";
        loginError.hidden = false;
      }
    } finally {
      passwordPending = false;
      $("password-save").disabled = false;
      $("password-cancel").disabled = false;
      passwordOpen.disabled = false;
      $("login-btn").disabled = authPending;
    }
  });

  function openSession() {
    generation++;
    logoutMarker.clear();
    authed = true;
    loginScreen.hidden = true;
    chatScreen.hidden = false;
    $("pass").value = "";
    loginError.hidden = true;
    showTab("chat");
    greet();
  }

  function clearSession() {
    closePasswordForm();
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
    voiceLabel.textContent = "Read replies aloud: off";
    voiceBtn.setAttribute("aria-pressed", "false");
    history = [];
    input.value = "";
    autoGrow();
    messagesEl.innerHTML = "";
    $("recipes-list").innerHTML = "";
    $("shopping-list").innerHTML = "";
    $("profit-summary").innerHTML = "";
    $("sales-log").innerHTML = "";
    showTab("chat");
    help.hidden = true;
    helpButton.setAttribute("aria-expanded", "false");
    chatScreen.hidden = true;
    loginScreen.hidden = false;
    $("login-btn").disabled = passwordPending || authPending;
    $("pass").value = "";
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (authPending || passwordPending) return;
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
      btn.disabled = passwordPending;
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
      btn.disabled = passwordPending;
    }
  }

  $("logout-btn").addEventListener("click", () => {
    logoutMarker.set();
    clearSession();
    endServerSession();
  });

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
    addMsg("Welcome back. Choose a tab above, or type a message below.", "bot");
  }

  // ---------- Send ----------
  async function send() {
    const text = input.value.trim();
    if (!text || !authed || sending) return;
    if (navigator.onLine === false) {
      addMsg("You're offline. Reconnect before sending; your draft is still in the box.", "bot");
      return;
    }
    sending = true;
    const started = generation;
    input.value = "";
    autoGrow();
    addMsg(text, "user");
    history.push({ role: "user", content: text });

    const typing = addTyping();
    const restoreDraft = () => {
      if (!input.value) { input.value = text; autoGrow(); }
    };
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
        const uncertainReplies = [
          "Sorry — that took too long. Could you try again?",
          "Sorry, the assistant could not complete that request. Please try again.",
          "Something went wrong on my end. Please try again.",
        ];
        if (!data.reply || uncertainReplies.includes(data.reply)) {
          restoreDraft();
          reply = "The request could not be confirmed. Check your records before sending it again.";
          addMsg(reply, "bot");
        } else {
          reply = data.reply;
          addMsg(reply, "bot");
          history.push({ role: "assistant", content: reply });
        }
      } else if (data.capped) {
        restoreDraft();
        reply = data.reply;
        addMsg(reply, "bot");
      } else {
        restoreDraft();
        reply = "The request could not be confirmed. Check your records before sending it again.";
        addMsg(reply, "bot");
      }
      speak(reply);
    } catch (err) {
      if (started !== generation || !authed) return;
      typing.remove();
      restoreDraft();
      const msg = "The reply didn't arrive. Your request may still have been processed. Check your records before sending it again.";
      addMsg(msg, "bot");
      speak(msg);
    } finally {
      if (started === generation && authed) {
        sending = false;
        sendBtn.disabled = false;

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

  const helpText = {
    chat: "Type a message or tap the microphone to dictate, then review it before sending. If a reply does not arrive, check your records before sending again.",
    recipes: "Review recipe prices and ingredient estimates here. Check your recipe records if a figure looks wrong.",
    shopping: "This is a starting list for matched recipes. Check quantities and units against your menu and stock before shopping.",
    profit: "These figures are estimates for all recorded sales. Check the records and ingredient costs if something looks wrong.",
  };
  const help = $("screen-help");
  const helpButton = $("help-btn");
  helpButton.addEventListener("click", () => {
    help.hidden = !help.hidden;
    if (help.hidden) closePasswordForm();
    helpButton.setAttribute("aria-expanded", String(!help.hidden));
  });

  function showTab(name) {
    $("help-content").textContent = helpText[name];
    tabBtns.forEach((b) => {
      const selected = b.dataset.tab === name;
      b.classList.toggle("active", selected);
      b.setAttribute("aria-selected", String(selected));
      b.tabIndex = selected ? 0 : -1;
    });
    Object.entries(tabPanels).forEach(([k, el]) => el.classList.toggle("active", k === name));
    if (name === "recipes") loadRecipes();
    else if (name === "shopping") loadShopping();
    else if (name === "profit") loadProfit();
  }
  tabBtns.forEach((b, index) => {
    b.addEventListener("click", () => showTab(b.dataset.tab));
    b.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabBtns.length;
      else if (event.key === "ArrowLeft") next = (index + tabBtns.length - 1) % tabBtns.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabBtns.length - 1;
      else return;
      event.preventDefault();
      showTab(tabBtns[next].dataset.tab);
      tabBtns[next].focus();
    });
  });
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
    const sequence = ++requestSequence.recipes;
    const el = $("recipes-list");
    el.innerHTML = '<div class="empty-note">Loading…</div>';
    const started = generation;
    try {
      const r = await apiFetch("/api/recipes");
      const d = await r.json();
      if (started !== generation || !authed || sequence !== requestSequence.recipes) return;
      if (!d.ok) throw new Error("bad response");
      const recs = d.recipes || [];
      if (!recs.length) {
        el.innerHTML = '<div class="empty-note">No recipes returned. If you expected recipes, check the records.</div>';
        return;
      }
      el.innerHTML = "";
      recs.forEach((rc) => {
        const row = document.createElement("div");
        row.className = "data-row";
        row.innerHTML =
          '<div class="d-main">' + esc(rc.name) + '</div>' +
          '<div class="d-right"><div class="val">' + price(rc.price) + '</div>' +
          '<div class="d-sub">Estimated ingredients: ' + ingredientCost(rc.ingredient_cost) + '</div></div>';
        el.appendChild(row);
      });
    } catch (e) {
      if (started !== generation || !authed || sequence !== requestSequence.recipes) return;
      el.innerHTML = '<div class="empty-note">' + (navigator.onLine === false ? 'You are offline. Reconnect, then tap Refresh.' : 'Couldn\u2019t load recipes. Tap Refresh to try again.') + '</div>';
    }
  }

  async function loadShopping() {
    const sequence = ++requestSequence.shopping;
    const el = $("shopping-list");
    el.innerHTML = '<div class="empty-note">Loading…</div>';
    const started = generation;
    try {
      const r = await apiFetch("/api/shopping-list");
      const d = await r.json();
      if (started !== generation || !authed || sequence !== requestSequence.shopping) return;
      if (!d.ok) throw new Error("bad");
      const items = d.items || [];
      if (!items.length) {
        el.innerHTML = '<div class="empty-note">No matching recipe ingredients returned. If you expected a list, check the menu and recipe records.</div>';
        return;
      }
      el.innerHTML = "";
      items.forEach((it) => {
        const row = document.createElement("div");
        row.className = "data-row";
        row.innerHTML =
          '<div class="d-main">' + esc(it.item) + ' <span class="d-sub">' + number(it.qty) + ' ' + esc(it.unit) + '</span></div>' +
          '<div class="d-right"><div class="val">' + money(it.est_cost) + '</div></div>';
        el.appendChild(row);
      });
      const total = document.createElement("div");
      total.className = "data-row";
      total.innerHTML = '<div class="d-main">Estimated ingredient cost</div><div class="d-right"><div class="val">' + money(d.total_cost) + '</div></div>';
      el.appendChild(total);
    } catch (e) {
      if (started !== generation || !authed || sequence !== requestSequence.shopping) return;
      el.innerHTML = '<div class="empty-note">' + (navigator.onLine === false ? 'You are offline. Reconnect, then tap Refresh.' : 'Couldn\u2019t load the list. Tap Refresh to try again.') + '</div>';
    }
  }

  async function loadProfit() {
    const sequence = ++requestSequence.profit;
    const sg = $("profit-summary");
    const sl = $("sales-log");
    sg.innerHTML = '<div class="empty-note">Loading…</div>';
    sl.innerHTML = "";
    const started = generation;
    try {
      const r = await apiFetch("/api/profit");
      const d = await r.json();
      if (started !== generation || !authed || sequence !== requestSequence.profit) return;
      if (!d.ok) throw new Error("bad");
      sg.innerHTML =
        '<h2>All recorded sales</h2>' +
        '<div class="profit-grid">' +
        '<div class="profit-cell"><div class="plabel">Estimated sales</div><div class="pvalue">' + money(d.revenue) + '</div></div>' +
        '<div class="profit-cell"><div class="plabel">Recorded ingredient estimate</div><div class="pvalue">' + money(d.ingredient_cost) + '</div></div>' +
        '<div class="profit-cell"><div class="plabel">Sales less estimated ingredients</div><div class="pvalue">' + money(d.profit) + '</div></div>' +
        '</div>';
      const sales = d.sales || [];
      if (!sales.length) {
        sl.innerHTML = '<div class="empty-note">No sales returned. If you expected sales, check the records.</div>';
      } else {
        sl.innerHTML = "";
        sales.forEach((s) => {
          const row = document.createElement("div");
          row.className = "data-row";
          row.innerHTML =
            '<div class="d-main">' + esc(s.dish) + ' <span class="d-sub">x' + number(s.qty == null ? 1 : s.qty) + '</span></div>' +
            '<div class="d-right"><div class="d-sub">Recorded price</div><div class="val">' + price(s.price) + '</div></div>';
          sl.appendChild(row);
        });
      }
    } catch (e) {
      if (started !== generation || !authed || sequence !== requestSequence.profit) return;
      sg.innerHTML = '<div class="empty-note">' + (navigator.onLine === false ? 'You are offline. Reconnect, then tap Refresh.' : 'Couldn\u2019t load your numbers. Tap Refresh to try again.') + '</div>';
      sl.innerHTML = "";
    }
  }

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "Incomplete";
  }

  function money(value) {
    return typeof value === "number" && Number.isFinite(value) ? "฿" + value : "Incomplete";
  }

  function ingredientCost(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? money(value) : "Cost needs checking";
  }

  function price(value) {
    if (value == null || value === 0) return "Price not set";
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? money(value) : "Incomplete";
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
