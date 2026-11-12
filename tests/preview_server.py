"""Local-only UI preview with allowlisted static files and synthetic API data.

Run with the bundled Python: ``python tests/preview_server.py``.
This deliberately does not import the application backend or serve directories.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


HOST = "127.0.0.1"
PORT = 8790
STATIC = Path(__file__).resolve().parents[1] / "static"
MAX_BODY = 32768
FONT_FILES = frozenset({
    "poppins-latin-400-normal.woff2",
    "poppins-latin-600-normal.woff2",
    "poppins-latin-700-normal.woff2",
})

RECIPES = {
    "ok": True,
    "recipes": [
        {
            "name": "Celebration cake with a deliberately very long display name for narrow screens",
            "price": 0,
            "ingredient_cost": 0,
            "cost_per_serving": 0,
            "margin_pct": 0,
            "suggested_price": 0,
            "underpriced": False,
        },
        {
            "name": "Sample loaf — missing price",
            "price": None,
            "ingredient_cost": 12.5,
            "cost_per_serving": 2.5,
            "margin_pct": None,
            "suggested_price": 31,
            "underpriced": False,
        },
        {
            "name": "Short sample tart",
            "price": 30,
            "ingredient_cost": 10,
            "cost_per_serving": 2,
            "margin_pct": 66.7,
            "suggested_price": 25,
            "underpriced": False,
        },
    ],
}

SHOPPING = {
    "ok": True,
    "total_cost": 88,
    "dishes_scanned": 3,
    "items": [
        {"item": "Flour — a deliberately long label to test wrapping at phone width", "unit": "kg", "qty": 2.5, "est_cost": 60},
        {"item": "Milk", "unit": "g", "qty": 750, "est_cost": 28},
        {"item": "Milk", "unit": "ml", "qty": 120, "est_cost": 0},
        {"item": "Sugar", "unit": "kg", "qty": 1, "est_cost": 28},
    ],
}

PROFIT = {
    "ok": True,
    "period": "Sample period",
    "revenue": 800,
    "ingredient_cost": 255,
    "profit": 545,
    "units_sold": 5,
    "sales": [
        {"dish": "Long-name sample cake for checking layout at 200% text size", "qty": 2, "price": 0},
        {"dish": "Sample tart", "qty": 3, "price": 400},
    ],
}


class PreviewHandler(BaseHTTPRequestHandler):
    authenticated = True

    def log_message(self, *_args):
        # Avoid logging request bodies, cookies, or other headers.
        return

    def _send(self, status, body=b"", content_type="application/json; charset=utf-8", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status, payload, headers=None):
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length < 0 or length > MAX_BODY:
            return None
        raw = self.rfile.read(length)
        if len(raw) != length:
            return None
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/":
            body = (STATIC / "index.html").read_text(encoding="utf-8")
            body = body.replace("<title>The Kitchen Manager</title>", "<title>LOCAL PREVIEW — SYNTHETIC DATA</title>")
            options = parse_qs(parsed.query)
            if options.get("large-text") == ["1"]:
                body = body.replace("</head>", "<style>:root{font-size:225% !important}</style></head>")
            if options.get("login") == ["1"]:
                type(self).authenticated = False
            return self._send(200, body.encode("utf-8"), "text/html; charset=utf-8")
        if path == "/static/app.css":
            return self._send(200, (STATIC / "app.css").read_bytes(), "text/css; charset=utf-8")
        if path == "/static/app.js":
            return self._send(200, (STATIC / "app.js").read_bytes(), "text/javascript; charset=utf-8")
        if path.startswith("/static/fonts/"):
            filename = path.removeprefix("/static/fonts/")
            if filename in FONT_FILES:
                return self._send(200, (STATIC / "fonts" / filename).read_bytes(), "font/woff2")
            return self._json(404, {"ok": False, "error": "Not found"})
        if path == "/api/session":
            status = 200 if type(self).authenticated else 401
            return self._json(status, {"ok": status == 200})
        if path == "/api/recipes":
            if not type(self).authenticated:
                return self._json(401, {"ok": False})
            return self._json(200, RECIPES)
        if path == "/api/shopping-list":
            if not type(self).authenticated:
                return self._json(401, {"ok": False})
            return self._json(200, SHOPPING)
        if path == "/api/profit":
            if not type(self).authenticated:
                return self._json(401, {"ok": False})
            return self._json(200, PROFIT)
        if path == "/api/status":
            if not type(self).authenticated:
                return self._json(401, {"ok": False})
            return self._json(200, {"ok": True, "spent": 0, "remaining": 5, "budget": 5})
        return self._json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        path = urlsplit(self.path).path
        body = self._body()
        if body is None:
            return self._json(400, {"ok": False, "error": "Invalid preview request"})
        if path == "/api/login":
            if isinstance(body, dict) and isinstance(body.get("user"), str) and isinstance(body.get("pass"), str):
                type(self).authenticated = True
                return self._json(200, {"ok": True}, {"Set-Cookie": "__Host-kitchen_session=preview; Secure; HttpOnly; SameSite=Strict; Path=/"})
            return self._json(400, {"ok": False, "error": "Invalid preview login"})
        if path == "/api/change-password":
            if not type(self).authenticated:
                return self._json(401, {"ok": False})
            if not isinstance(body, dict) or any(not isinstance(body.get(key), str) for key in (
                "current_password", "new_password", "confirm_password",
            )):
                return self._json(400, {"ok": False, "error": "Invalid preview password form"})
            type(self).authenticated = False
            return self._json(200, {"ok": True}, {"Set-Cookie": "__Host-kitchen_session=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/"})
        if path == "/api/logout":
            type(self).authenticated = False
            return self._json(200, {"ok": True}, {"Set-Cookie": "__Host-kitchen_session=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/"})
        if path == "/api/chat":
            if not type(self).authenticated:
                return self._json(401, {"ok": False})
            prompt = body.get("message", "") if isinstance(body, dict) else ""
            return self._json(200, {"ok": True, "reply": f"Local preview only. No changes were saved. You asked: {prompt}"})
        return self._json(404, {"ok": False, "error": "Not found"})

    do_PUT = do_DELETE = do_PATCH = do_POST


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), PreviewHandler)
    print(f"Serving local synthetic UI preview at http://{HOST}:{PORT}/ (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
