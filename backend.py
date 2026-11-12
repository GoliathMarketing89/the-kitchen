#!/usr/bin/env python3
"""
The Kitchen — chat backend.

Serves the login-gated chat window, enforces the $5/month usage cap,
and calls the kitchen-manager Hermes profile on-demand for each message.

Run:  python3 backend.py   (binds 0.0.0.0:8787)
"""
import json
import hashlib
import hmac
import secrets
from urllib.parse import urlsplit
import os
import subprocess
import time
import threading
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

import planning
import credential_store

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
STATE = BASE / "state.json"

# --- config (overridable via env) ---
PORT = int(os.environ.get("KITCHEN_PORT", "8787"))
MONTHLY_BUDGET = float(os.environ.get("KITCHEN_BUDGET", "5.0"))  # USD/month
SESSION_COOKIE = "__Host-kitchen_session"
SESSION_TTL = 28800
MAX_SESSIONS = 256
MAX_BODY = 32768
MAX_LOGIN_BODY = 4096
MAX_MESSAGE = 4000
MAX_HISTORY_TURNS = 6
MAX_HISTORY_CONTENT = 4000
LOGIN_ATTEMPTS = 5
LOGIN_WINDOW = 300
MAX_LOGIN_CLIENTS = 1024
COMMON_PASSWORDS = frozenset({
    "passwordpassword", "password123456789", "123456789012345",
    "12345678901234567890", "qwertyuiopasdfgh",
})
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_sessions = {}
_login_attempts = {}
_auth_lock = threading.RLock()
_password_attempts = []


def auth_config():
    user = os.environ.get("KITCHEN_USER", "")
    try:
        password_hash = (credential_store.read_verifier(os.environ["KITCHEN_CREDENTIAL_STORE"], BASE)
                         if "KITCHEN_CREDENTIAL_STORE" in os.environ
                         else os.environ.get("KITCHEN_PASSWORD_HASH", ""))
    except credential_store.StoreError:
        return None
    origin = os.environ.get("KITCHEN_ORIGIN", "")
    try:
        url = urlsplit(origin)
        user.encode("utf-8")
        hostname, port = url.hostname, url.port
        parts = password_hash.split("$")
        iterations = int(parts[1])
        salt, digest = bytes.fromhex(parts[2]), bytes.fromhex(parts[3])
        valid = (len(parts) == 4 and parts[0] == "pbkdf2_sha256" and
                 600000 <= iterations <= 2000000 and len(salt) >= 16 and len(digest) == 32 and
                 url.scheme == "https" and bool(hostname) and not url.path and not url.query and
                 not url.fragment and "@" not in url.netloc and origin == f"https://{url.netloc}" and
                 not any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in origin) and
                 bool(user) and len(user) <= 256)
    except (ValueError, IndexError, UnicodeError):
        valid = False
    return (user, password_hash, origin) if valid else None


def verify_password(password, password_hash):
    _, iterations, salt, expected = password_hash.split("$")
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iterations))
    return hmac.compare_digest(actual, bytes.fromhex(expected))


def authenticated(token):
    now = time.monotonic()
    with _auth_lock:
        entry = _sessions.get(token)
        if entry is None:
            return False
        expiry, config = entry
        if expiry <= now or config != auth_config():
            _sessions.pop(token, None)
            return False
        return True


def new_session(expected_config):
    now = time.monotonic()
    with _auth_lock:
        if auth_config() != expected_config:
            return None
        for token, (expiry, config) in list(_sessions.items()):
            if expiry <= now or config != expected_config:
                del _sessions[token]
        if len(_sessions) >= MAX_SESSIONS:
            return None
        token = secrets.token_urlsafe(32)
        _sessions[token] = (now + SESSION_TTL, expected_config)
        return token


def allow_login(client):
    now = time.monotonic()
    with _auth_lock:
        for key, attempts in list(_login_attempts.items()):
            recent = [t for t in attempts if now - t < LOGIN_WINDOW]
            if recent:
                _login_attempts[key] = recent
            else:
                del _login_attempts[key]
        if client not in _login_attempts and len(_login_attempts) >= MAX_LOGIN_CLIENTS:
            return False
        attempts = _login_attempts.setdefault(client, [])
        if len(attempts) >= LOGIN_ATTEMPTS:
            return False
        attempts.append(now)
        return True


@app.middleware("http")
async def secure_api(request, call_next):
    if not (request.url.path == "/api" or request.url.path.startswith("/api/")):
        return await call_next(request)
    config = auth_config()
    if not config:
        return JSONResponse({"ok": False, "error": "Authentication is not configured."}, status_code=503)
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("origin") != config[2]:
            return JSONResponse({"ok": False, "error": "Request origin rejected."}, status_code=403)
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            return JSONResponse({"ok": False, "error": "JSON required."}, status_code=415)
        limit = MAX_LOGIN_BODY if request.url.path == "/api/login" else MAX_BODY
        chunks = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > limit:
                return JSONResponse({"ok": False, "error": "Request too large."}, status_code=413)
            chunks.append(chunk)
        body = b"".join(chunks)
        request._body = body
    if request.url.path != "/api/login" and not authenticated(request.cookies.get(SESSION_COOKIE)):
        return JSONResponse({"ok": False, "error": "Please sign in."}, status_code=401)
    return await call_next(request)
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
        # Take the LAST reply box — the agent's final answer, not interim thoughts.
        start = raw.rfind("╭─")
        end = raw.rfind("╰─")
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
            "/home/michael/.local/bin/kitchen-manager", "chat", "-q", prompt,
            "--oneshot", "--format", "text",
        ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=240,
            cwd=str(BASE),
        )
        if proc.returncode != 0:
            return "Sorry, the assistant could not complete that request. Please try again.", 0.0
        out = (proc.stdout or "").strip()
        clean = extract_reply(out)
        est = estimate_cost(len(prompt) / 4, len(clean) / 4)
        return clean, est
    except subprocess.TimeoutExpired:
        return "Sorry — that took too long. Could you try again?", 0.0
    except Exception:
        return "Something went wrong on my end. Please try again.", 0.0


@app.get("/", response_class=FileResponse)
async def index():
    return FileResponse(STATIC / "index.html")


@app.middleware("http")
async def no_store_api(request, call_next):
    response = await call_next(request)
    if request.url.path == "/api" or request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/login")
async def login(req: Request):
    client = req.client.host if req.client else "unknown"
    if not allow_login(client):
        return JSONResponse({"ok": False, "error": "Too many attempts. Please try later."}, status_code=429)
    try:
        body = await req.json()
        user, password = body.get("user"), body.get("pass")
        if not isinstance(user, str) or not isinstance(password, str) or len(user) > 256 or len(password) > 256:
            raise ValueError()
        user.encode("utf-8")
        password.encode("utf-8")
    except (ValueError, AttributeError, TypeError, UnicodeError, RecursionError):
        return JSONResponse({"ok": False, "error": "Invalid login."}, status_code=400)
    # Serialize verification and session issuance with credential changes.
    with _auth_lock:
        config = auth_config()
        if not config:
            return JSONResponse({"ok": False, "error": "Authentication is not configured."}, status_code=503)
        configured_user, password_hash, _ = config
        valid_password = verify_password(password, password_hash)
        if not hmac.compare_digest(user.encode("utf-8"), configured_user.encode("utf-8")) or not valid_password:
            return JSONResponse({"ok": False, "error": "Wrong username or password."}, status_code=401)
        _sessions.pop(req.cookies.get(SESSION_COOKIE), None)
        token = new_session(config)
        if token is None:
            return JSONResponse({"ok": False, "error": "Please try again later."}, status_code=503)
    response = JSONResponse({"ok": True})
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_TTL, secure=True, httponly=True, samesite="strict", path="/")
    return response


@app.get("/api/session")
async def session():
    return JSONResponse({"ok": True})


@app.post("/api/logout")
async def logout(req: Request):
    with _auth_lock:
        _sessions.pop(req.cookies.get(SESSION_COOKIE), None)
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
    return response


@app.post("/api/change-password")
async def change_password(req: Request):
    if "KITCHEN_CREDENTIAL_STORE" not in os.environ:
        return JSONResponse({"ok": False, "error": "Password change is not configured."}, status_code=503)
    try:
        body = await req.json()
        current, new, confirm = (body.get("current_password"), body.get("new_password"), body.get("confirm_password"))
        if any(not isinstance(v, str) or len(v) > 256 for v in (current, new, confirm)):
            raise ValueError()
        for value in (current, new, confirm):
            value.encode("utf-8")
        if len(new) < 15 or new != confirm:
            return JSONResponse({"ok": False, "error": "Use at least 15 characters and make sure both new passwords match."}, status_code=400)
        if new == current:
            return JSONResponse({"ok": False, "error": "Choose a different new password."}, status_code=400)
        if new.casefold() in COMMON_PASSWORDS or len(set(new)) == 1:
            return JSONResponse({"ok": False, "error": "Choose a less predictable password or a longer phrase."}, status_code=400)
    except (ValueError, AttributeError, TypeError, UnicodeError, RecursionError):
        return JSONResponse({"ok": False, "error": "Invalid password fields."}, status_code=400)
    token = req.cookies.get(SESSION_COOKIE)
    with _auth_lock:
        config = auth_config()
        if not config:
            return JSONResponse({"ok": False, "error": "Authentication is not configured."}, status_code=503)
        if not authenticated(token):
            return JSONResponse({"ok": False, "error": "Please sign in."}, status_code=401)
        now = time.monotonic()
        _password_attempts[:] = [t for t in _password_attempts if now - t < LOGIN_WINDOW]
        if len(_password_attempts) >= LOGIN_ATTEMPTS:
            return JSONResponse({"ok": False, "error": "Too many attempts. Please try later."}, status_code=429)
        if not verify_password(current, config[1]):
            _password_attempts.append(now)
            return JSONResponse({"ok": False, "error": "Current password is incorrect."}, status_code=400)
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac("sha256", new.encode("utf-8"), salt, 600000)
        verifier = f"pbkdf2_sha256$600000${salt.hex()}${digest.hex()}"
        if auth_config() != config or not authenticated(token):
            return JSONResponse({"ok": False, "error": "Please sign in."}, status_code=401)
        try:
            credential_store.replace_verifier(os.environ["KITCHEN_CREDENTIAL_STORE"], BASE, verifier)
        except credential_store.StoreWriteUncertain:
            _sessions.clear()
            response = JSONResponse({"ok": False, "error": "Password update could not be confirmed. Please sign in again."}, status_code=503)
            response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
            return response
        except credential_store.StoreError:
            return JSONResponse({"ok": False, "error": "Password change is unavailable."}, status_code=503)
        _sessions.clear()
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
    return response


@app.post("/api/chat")
async def chat(req: Request):
    try:
        body = await req.json()
        message, history = body.get("message"), body.get("history", [])
        if (not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE or
            not isinstance(history, list) or len(history) > MAX_HISTORY_TURNS or
            any(not isinstance(t, dict) or t.get("role") not in ("user", "assistant") or
                not isinstance(t.get("content"), str) or len(t["content"]) > MAX_HISTORY_CONTENT for t in history)):
            raise ValueError()
        message = message.strip()
        message.encode("utf-8")
        for turn in history:
            turn["content"].encode("utf-8")
    except (ValueError, AttributeError, TypeError, UnicodeError, RecursionError):
        return JSONResponse({"ok": False, "error": "Invalid message."}, status_code=400)

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


@app.get("/api/recipes")
async def api_recipes():
    return JSONResponse({"ok": True, "recipes": planning.recipe_costs()})


@app.get("/api/shopping-list")
async def api_shopping_list():
    return JSONResponse({"ok": True, **planning.shopping_list()})


@app.get("/api/profit")
async def api_profit():
    return JSONResponse({"ok": True, **planning.weekly_profit()})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT, proxy_headers=False)
