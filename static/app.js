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

  // Session flag (in-memory; a refresh re-prompts login — that's fine and safe).
  let authed = false;
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
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (e) => {
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
      recogActive = false;
      setMicState(false);
      addMsg("Sorry, I couldn't catch that — please try again or type it.", "bot");
    };
    recognition.onend = () => {
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
        setTimeout(() => {
          try { recognition.start(); recogActive = true; setMicState(true); } catch (e2) {}
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
        if (!micSupported && !ttsSupported) {
          addMsg("Tip: use Chrome or Safari for voice input and voice replies.", "bot");
        }
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
    if (recogActive) { recognition && recognition.stop(); setMicState(false); recogActive = false; }
    if (voiceOn) { speechSynthesis.cancel(); }
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
      const greeting =
        "Hi! I'm your Kitchen Manager — the little helper that runs your shop's menu page for you. " +
        "You talk to me, and I keep your page up to date. No tech needed.\n\n" +
        "Here's what I can do:\n" +
        "• Add a dish to your menu (name, price, a photo)\n" +
        "• Change a price or take a dish down when it sells out\n" +
        "• Update your shop name, tagline, or WhatsApp number\n" +
        "• Set up Christmas pre-orders and cake orders\n" +
        "• Change how your page looks\n\n" +
        "To get you set up, let's start with the most important thing: " +
        "what's the WhatsApp number customers should message to order? " +
        "Include the country code, like +66.";
      addMsg(greeting, "bot");
      speak(greeting);
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
      typing.remove();
      const msg = "Couldn't reach the kitchen. Check your connection and try again.";
      addMsg(msg, "bot");
      speak(msg);
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

  // Pre-warm voices list for TTS (async population on some browsers).
  if (ttsSupported) {
    speechSynthesis.onvoiceschanged = () => {};
    speechSynthesis.getVoices();
  }
})();
