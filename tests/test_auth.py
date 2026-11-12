"""HTTP-level auth regression tests using only synthetic configuration/data."""
import asyncio
import hashlib
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


ORIGIN = "https://kitchen.test"
TEST_USER = "fixture-owner"
TEST_PASSWORD = "synthetic test password"
TEST_SALT = b"synthetic-salt!!"
TEST_HASH = "pbkdf2_sha256$600000${}${}".format(
    TEST_SALT.hex(),
    hashlib.pbkdf2_hmac("sha256", TEST_PASSWORD.encode(), TEST_SALT, 600000).hex(),
)
CONFIG_KEYS = ("KITCHEN_USER", "KITCHEN_PASSWORD_HASH", "KITCHEN_ORIGIN")


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.previous_env = {key: os.environ.get(key) for key in CONFIG_KEYS}
        for key, value in zip(CONFIG_KEYS, (TEST_USER, TEST_HASH, ORIGIN)):
            os.environ[key] = value
        import backend
        self.backend = importlib.reload(backend)
        self.sandbox = tempfile.TemporaryDirectory()
        self.addCleanup(self.sandbox.cleanup)
        self._isolate_backend(self.backend)
        self.client = TestClient(self.backend.app, base_url=ORIGIN)
        self.addCleanup(self.client.close)
        self.addCleanup(self._restore_env)

    def _isolate_backend(self, backend):
        self.backend_patches = [
            patch.object(backend, "STATE", Path(self.sandbox.name) / "state.json"),
            patch.object(backend, "check_budget", return_value=(True, 0.0, backend.MONTHLY_BUDGET)),
            patch.object(backend, "record_spend"),
            patch.object(backend, "call_manager", return_value=("synthetic reply", 0.0)),
            patch.object(backend.planning, "recipe_costs", return_value=[]),
            patch.object(backend.planning, "shopping_list", return_value={"items": [], "total_cost": 0, "dishes_scanned": 0}),
            patch.object(backend.planning, "weekly_profit", return_value={"revenue": 0, "ingredient_cost": 0, "profit": 0, "units_sold": 0, "sales": []}),
        ]
        for active_patch in self.backend_patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)
        self.manager = backend.call_manager

    def _restore_env(self):
        for key, value in self.previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def login(self):
        return self.client.post(
            "/api/login",
            headers={"Origin": ORIGIN},
            json={"user": TEST_USER, "pass": TEST_PASSWORD},
        )

    def test_unconfigured_api_fails_closed_and_docs_are_disabled(self):
        for key in CONFIG_KEYS:
            os.environ.pop(key, None)
        os.environ["KITCHEN_PASS"] = "synthetic legacy password must not enable auth"
        backend = importlib.reload(self.backend)
        self._isolate_backend(backend)
        client = TestClient(backend.app, base_url=ORIGIN)

        try:
            self.assertEqual(client.get("/api/status").status_code, 503)
            self.assertEqual(client.get("/docs").status_code, 404)
            self.assertEqual(client.get("/openapi.json").status_code, 404)
            self.assertIn("no-store", client.get("/api/status").headers.get("cache-control", ""))
        finally:
            client.close()

    def test_private_api_routes_require_session_before_work(self):
        get_paths = (
            "/api/session", "/api/status", "/api/recipes",
            "/api/shopping-list", "/api/profit",
        )
        for path in get_paths:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 401)

        headers = {"Origin": ORIGIN, "Content-Type": "application/json"}
        self.assertEqual(self.client.post("/api/chat", headers=headers, json={}).status_code, 401)
        self.assertEqual(self.client.post("/api/logout", headers=headers, json={}).status_code, 401)

    def test_bad_and_good_login_and_secure_cookie(self):
        bad = self.client.post(
            "/api/login", headers={"Origin": ORIGIN},
            json={"user": TEST_USER, "pass": "wrong synthetic password"},
        )
        self.assertEqual(bad.status_code, 401)
        self.assertNotIn(self.backend.SESSION_COOKIE, bad.cookies)

        good = self.login()
        self.assertEqual(good.status_code, 200)
        self.assertEqual(good.json(), {"ok": True})
        cookie_header = good.headers["set-cookie"].lower()
        self.assertIn(f"{self.backend.SESSION_COOKIE.lower()}=", cookie_header)
        self.assertIn("secure", cookie_header)
        self.assertIn("httponly", cookie_header)
        self.assertIn("samesite=strict", cookie_header)
        self.assertEqual(self.client.get("/api/session").status_code, 200)

    def test_logout_revokes_cookie_and_forged_or_replayed_tokens_fail(self):
        self.assertEqual(self.login().status_code, 200)
        token = self.client.cookies.get(self.backend.SESSION_COOKIE)
        self.assertTrue(token)

        wrong_origin = self.client.post(
            "/api/logout",
            headers={"Origin": "https://attacker.test"},
            json={},
        )
        self.assertEqual(wrong_origin.status_code, 403)
        self.assertEqual(self.client.get("/api/session").status_code, 200)

        logout = self.client.post(
            "/api/logout", headers={"Origin": ORIGIN}, json={},
        )
        self.assertEqual(logout.status_code, 200)
        self.assertIn(f"{self.backend.SESSION_COOKIE}=", logout.headers["set-cookie"])
        self.assertEqual(self.client.get("/api/session").status_code, 401)

        replay = self.client.get(
            "/api/session", headers={"Cookie": f"{self.backend.SESSION_COOKIE}={token}"},
        )
        self.assertEqual(replay.status_code, 401)
        forged = self.client.get(
            "/api/session", headers={"Cookie": f"{self.backend.SESSION_COOKIE}=forged-token"},
        )
        self.assertEqual(forged.status_code, 401)

    def test_expired_session_is_rejected(self):
        self.assertEqual(self.login().status_code, 200)
        now = self.backend.time.monotonic()
        with patch.object(self.backend.time, "monotonic", return_value=now + self.backend.SESSION_TTL + 1):
            response = self.client.get("/api/session")
        self.assertEqual(response.status_code, 401)

    def test_post_requires_exact_origin_and_json(self):
        no_origin = self.client.post(
            "/api/login", json={"user": TEST_USER, "pass": TEST_PASSWORD},
        )
        self.assertEqual(no_origin.status_code, 403)
        wrong_origin = self.client.post(
            "/api/login", headers={"Origin": "https://kitchen.test.attacker.test"},
            json={"user": TEST_USER, "pass": TEST_PASSWORD},
        )
        self.assertEqual(wrong_origin.status_code, 403)

        self.assertEqual(self.login().status_code, 200)
        text_body = self.client.post(
            "/api/chat", headers={"Origin": ORIGIN, "Content-Type": "text/plain"},
            content="{}",
        )
        self.assertEqual(text_body.status_code, 415)

        malformed = self.client.post(
            "/api/chat", headers={"Origin": ORIGIN, "Content-Type": "application/json"},
            content="{broken",
        )
        self.assertGreaterEqual(malformed.status_code, 400)
        self.assertLess(malformed.status_code, 500)

    def test_malformed_login_and_chat_shapes_are_client_errors(self):
        bad_login = self.client.post(
            "/api/login", headers={"Origin": ORIGIN}, json={"user": 7, "pass": []},
        )
        self.assertEqual(bad_login.status_code, 400)
        self.assertEqual(self.login().status_code, 200)

        invalid_payloads = (
            [],
            {"message": 7},
            {"message": "hello", "history": "not a list"},
            {"message": "hello", "history": [{"role": "system", "content": "no"}]},
            {"message": "hello", "history": [{"role": "user", "content": "x"}] * 7},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=type(payload).__name__):
                response = self.client.post(
                    "/api/chat", headers={"Origin": ORIGIN}, json=payload,
                )
                self.assertEqual(response.status_code, 400)
        self.manager.assert_not_called()

    def test_authenticated_read_and_chat_routes_use_synthetic_stubs(self):
        self.assertEqual(self.login().status_code, 200)
        for path in ("/api/session", "/api/status", "/api/recipes", "/api/shopping-list", "/api/profit"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

        chat = self.client.post(
            "/api/chat", headers={"Origin": ORIGIN},
            json={"message": "synthetic test prompt", "history": []},
        )
        self.assertEqual(chat.status_code, 200)
        self.assertEqual(chat.json()["reply"], "synthetic reply")
        self.manager.assert_called_once_with("synthetic test prompt", [])

    def test_invalid_auth_configuration_fails_closed(self):
        for invalid_hash, origin in (
            ("not-a-supported-hash", ORIGIN),
            (TEST_HASH, "http://kitchen.test"),
        ):
            with self.subTest(hash=invalid_hash[:8], origin=origin):
                os.environ["KITCHEN_PASSWORD_HASH"] = invalid_hash
                os.environ["KITCHEN_ORIGIN"] = origin
                response = self.client.get("/api/status")
                self.assertEqual(response.status_code, 503)
                os.environ["KITCHEN_PASSWORD_HASH"] = TEST_HASH
                os.environ["KITCHEN_ORIGIN"] = ORIGIN

    def test_config_rotation_invalidates_existing_session(self):
        self.assertEqual(self.login().status_code, 200)
        os.environ["KITCHEN_PASSWORD_HASH"] = "pbkdf2_sha256$600000$" + (b"another synthetic salt".hex()) + "$" + hashlib.pbkdf2_hmac(
            "sha256", b"rotated synthetic password", b"another synthetic salt", 600000,
        ).hex()
        self.assertEqual(self.client.get("/api/session").status_code, 401)

    def test_session_capacity_and_expired_entry_cleanup(self):
        with patch.object(self.backend, "MAX_SESSIONS", 1):
            self.assertEqual(self.login().status_code, 200)
            second_client = TestClient(self.backend.app, base_url=ORIGIN)
            try:
                second = second_client.post(
                    "/api/login", headers={"Origin": ORIGIN},
                    json={"user": TEST_USER, "pass": TEST_PASSWORD},
                )
                self.assertEqual(second.status_code, 503)
                token = self.client.cookies.get(self.backend.SESSION_COOKIE)
                self.backend._sessions[token] = (
                    self.backend.time.monotonic() - 1,
                    self.backend.auth_config(),
                )
                self.assertEqual(second_client.post(
                    "/api/login", headers={"Origin": ORIGIN},
                    json={"user": TEST_USER, "pass": TEST_PASSWORD},
                ).status_code, 200)
            finally:
                second_client.close()

    def test_login_rate_limit_window_expires(self):
        self.backend._login_attempts["testclient"] = [
            self.backend.time.monotonic() - self.backend.LOGIN_WINDOW - 1
        ] * self.backend.LOGIN_ATTEMPTS
        response = self.login()
        self.assertEqual(response.status_code, 200)

    def test_chat_origin_is_checked_before_manager_execution(self):
        self.assertEqual(self.login().status_code, 200)
        response = self.client.post(
            "/api/chat", headers={"Origin": "https://attacker.test"},
            json={"message": "synthetic request"},
        )
        self.assertEqual(response.status_code, 403)
        self.manager.assert_not_called()

    def test_oversized_declared_and_chunked_login_bodies_are_rejected(self):
        declared = self.client.post(
            "/api/login",
            headers={"Origin": ORIGIN, "Content-Type": "application/json"},
            content=b" " * (self.backend.MAX_LOGIN_BODY + 1),
        )
        self.assertEqual(declared.status_code, 413)

        async def send_chunked():
            import httpx

            limit = self.backend.MAX_LOGIN_BODY

            class OversizedStream(httpx.AsyncByteStream):
                async def __aiter__(self):
                    yield b" " * (limit - 100)
                    yield b" " * 101

            transport = httpx.ASGITransport(app=self.backend.app)
            async with httpx.AsyncClient(transport=transport, base_url=ORIGIN) as client:
                request = client.build_request(
                    "POST", "/api/login",
                    headers={"Origin": ORIGIN, "Content-Type": "application/json"},
                    content=OversizedStream(),
                )
                self.assertNotIn("content-length", request.headers)
                response = await client.send(request)
                return response.status_code
        self.assertEqual(asyncio.run(send_chunked()), 413)

    def test_unknown_api_route_is_private(self):
        self.assertEqual(self.client.get("/api/not-a-route").status_code, 401)

    def test_auth_early_responses_are_not_cacheable(self):
        cases = (
            self.client.get("/api/session"),
            self.client.post("/api/login", json={"user": TEST_USER, "pass": TEST_PASSWORD}),
            self.client.post(
                "/api/login", headers={"Origin": ORIGIN, "Content-Type": "application/json"},
                content=b" " * (self.backend.MAX_LOGIN_BODY + 1),
            ),
        )
        for response in cases:
            with self.subTest(status=response.status_code):
                self.assertIn("no-store", response.headers.get("cache-control", ""))

    def test_relogin_invalidates_previous_session_token(self):
        self.assertEqual(self.login().status_code, 200)
        old_token = self.client.cookies.get(self.backend.SESSION_COOKIE)
        self.assertEqual(self.login().status_code, 200)

        old_session = self.client.get(
            "/api/session", headers={"Cookie": f"{self.backend.SESSION_COOKIE}={old_token}"},
        )
        self.assertEqual(old_session.status_code, 401)

    def test_login_rejects_lone_surrogate_without_server_error(self):
        response = self.client.post(
            "/api/login",
            headers={"Origin": ORIGIN, "Content-Type": "application/json"},
            content=b'{"user":"\\ud800","pass":"synthetic"}',
        )
        self.assertGreaterEqual(response.status_code, 400)
        self.assertLess(response.status_code, 500)

    def test_deeply_nested_json_is_a_client_error(self):
        response = self.client.post(
            "/api/login",
            headers={"Origin": ORIGIN, "Content-Type": "application/json"},
            content=b"[" * 1500 + b"]" * 1500,
        )
        self.assertEqual(response.status_code, 400)

    def test_maximum_length_unicode_credentials_fit_login_body_limit(self):
        user = "u" * 256
        password = "🍰" * 256
        salt = b"long unicode salt"
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 600000)
        os.environ["KITCHEN_USER"] = user
        os.environ["KITCHEN_PASSWORD_HASH"] = f"pbkdf2_sha256$600000${salt.hex()}${digest.hex()}"
        accepted = self.client.post(
            "/api/login", headers={"Origin": ORIGIN},
            json={"user": user, "pass": password},
        )
        self.assertEqual(accepted.status_code, 200)

        overlong = self.client.post(
            "/api/login", headers={"Origin": ORIGIN},
            json={"user": user + "u", "pass": password},
        )
        self.assertEqual(overlong.status_code, 400)

    def test_chat_rejects_lone_surrogate_without_server_error_or_manager_call(self):
        self.assertEqual(self.login().status_code, 200)
        response = self.client.post(
            "/api/chat",
            headers={"Origin": ORIGIN, "Content-Type": "application/json"},
            content=b'{"message":"\\ud800"}',
        )
        self.assertGreaterEqual(response.status_code, 400)
        self.assertLess(response.status_code, 500)
        self.manager.assert_not_called()

    def test_valid_non_bmp_unicode_history_reaches_manager_intact(self):
        self.assertEqual(self.login().status_code, 200)
        content = "🍰" * 1000
        response = self.client.post(
            "/api/chat", headers={"Origin": ORIGIN},
            json={"message": "hello 🍰", "history": [{"role": "assistant", "content": content}]},
        )
        self.assertEqual(response.status_code, 200)
        self.manager.assert_called_once_with("hello 🍰", [{"role": "assistant", "content": content}])

    def test_login_rate_limit_ignores_forwarded_for_spoofing(self):
        for attempt in range(self.backend.LOGIN_ATTEMPTS):
            response = self.client.post(
                "/api/login",
                headers={
                    "Origin": ORIGIN,
                    "X-Forwarded-For": f"198.51.100.{attempt + 1}",
                },
                json={"user": TEST_USER, "pass": "wrong synthetic password"},
            )
            self.assertEqual(response.status_code, 401)

        limited = self.client.post(
            "/api/login",
            headers={"Origin": ORIGIN, "X-Forwarded-For": "203.0.113.77"},
            json={"user": TEST_USER, "pass": TEST_PASSWORD},
        )
        self.assertEqual(limited.status_code, 429)


if __name__ == "__main__":
    unittest.main()
