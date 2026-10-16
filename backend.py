#!/usr/bin/env python3
"""
The Kitchen — chat backend.

Serves the login-gated chat window, enforces the $5/month usage cap,
and calls the kitchen-manager Hermes profile on-demand for each message.

Run:  python3 backend.py   (binds 0.0.0.0:8787)
"""
import json
import os
import subprocess
import time
import threading
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
STATE = BASE / "state.json"

# --- config (overridable via env) ---
PORT = int(os.environ.get("KITCHEN_PORT", "8787"))
MONTHLY_BUDGET = float(os.environ.get("KITCHEN_BUDGET", "5.0"))  # USD/month
OWNER_USER = os.environ.get("KITCHEN_USER", "mom")
OWNER_PASS = os.environ.get("KITCHEN_PASS", "change-me-now")

app = FastAPI()
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

_lock = threading.Lock()


def load_state():
    if STATE.exists():
        try:
            return json.loads(STATE.read_text())
        except Exception:
            pass
    return {"spent": 0.0, "month": None, "messages": 0}


def save_state(s):
    STATE.write_text(json.dumps(s, indent=2))


def current_month():
    return time.strftime("%Y-%m")


def check_budget():
    """Return (ok, spent_this_month, remaining). Resets on month change."""
    with _lock:
        s = load_state()
        month = current_month()
        if s.get("month") != month:
            s = {"spent": 0.0, "month": month, "messages": 0}
            save_state(s)
        spent = s.get("spent", 0.0)
        remaining = MONTHLY_BUDGET - spent
        return remaining > 0, spent, max(remaining, 0.0)


def record_spend(est_usd):
    with _lock:
        s = load_state()
        s["spent"] = s.get("spent", 0.0) + est_usd
        s["messages"] = s.get("messages", 0) + 1
        save_state(s)


def estimate_cost(tokens_in, tokens_out):
    """Rough DeepSeek flash pricing: ~$0.07/M in, ~$0.27/M out (USD)."""
    return (tokens_in / 1e6) * 0.07 + (tokens_out / 1e6) * 0.27


def extract_reply(raw):
    """Pull the agent's reply out of Hermes terminal output.

    The reply lives inside the box drawn with '╭─ ☤ Hermes ─...╮' and
    '╰─...╯'. We take the text between those markers and strip the box
    borders. Falls back to the raw text if the markers aren't found.
    """
    if "╭─" in raw and "╰─" in raw:
        start = raw.find("╭─")
        end = raw.find("╰─")
        if start != -1 and end != -1 and end > start:
            body = raw[start:end]
            lines = []
            for ln in body.splitlines():
                s = ln.strip()
                if not s:
                    continue
                # Drop box-drawing top/bottom edge lines entirely.
                if s.startswith("╭") or s.startswith("╰"):
                    continue
                # Strip the left border char from content lines.
                if s.startswith("│"):
                    s = s.lstrip("│ ").strip()
                if s and not s.startswith("☤ Hermes"):
                    lines.append(s)
            return "\n".join(lines).strip()
    return raw


def call_manager(message, history):
    """Run the kitchen-manager profile one-shot. Returns (reply, est_cost)."""
    ctx = ""
    if history:
        lines = []
        for turn in history[-6:]:
            role = "Owner" if turn.get("role") == "user" else "Manager"
            lines.append(f"{role}: {turn.get('content','')}")
        ctx = "Recent conversation:\n" + "\n".join(lines) + "\n\n"
    prompt = ctx + "Owner says: " + message

    cmd = [
        "kitchen-manager", "chat", "-q", prompt,
        "--oneshot", "--format", "text",
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=240,
            cwd=str(BASE),
        )
        out = (proc.stdout or "").strip()
        clean = extract_reply(out)
        est = estimate_cost(len(prompt) / 4, len(clean) / 4)
        return clean, est
    except subprocess.TimeoutExpired:
        return "Sorry — that took too long. Could you try again?", 0.0
    except Exception as e:
        return f"Something went wrong on my end. Please try again. ({e})", 0.0


@app.get("/", response_class=FileResponse)
async def index():
    return FileResponse(STATIC / "index.html")


@app.post("/api/login")
async def login(req: Request):
    body = await req.json()
    if body.get("user") == OWNER_USER and body.get("pass") == OWNER_PASS:
        return JSONResponse({"ok": True})
    return JSONResponse({"ok": False, "error": "Wrong username or password."}, status_code=401)


@app.post("/api/chat")
async def chat(req: Request):
    body = await req.json()
    message = (body.get("message") or "").strip()
    history = body.get("history") or []
    if not message:
        return JSONResponse({"ok": False, "error": "Empty message."})

    ok, spent, remaining = check_budget()
    if not ok:
        return JSONResponse({
            "ok": False,
            "capped": True,
            "reply": "I've hit my usage cap for this month, so I'm resting for now. "
                     "Talk to Michael if you'd like more — I'll be back next month!",
        })

    reply, est = call_manager(message, history)
    record_spend(est)
    return JSONResponse({
        "ok": True,
        "reply": reply,
        "spent": round(spent + est, 4),
        "remaining": round(max(remaining - est, 0.0), 4),
        "budget": MONTHLY_BUDGET,
    })


@app.get("/api/status")
async def status():
    ok, spent, remaining = check_budget()
    return JSONResponse({
        "ok": ok, "spent": round(spent, 4),
        "remaining": round(remaining, 4), "budget": MONTHLY_BUDGET,
    })


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
