"""HTTP-level auth regression tests using only synthetic configuration/data."""
import asyncio
import concurrent.futures
import hashlib
import importlib
import os
import threading
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
CONFIG_KEYS = (
    "KITCHEN_USER", "KITCHEN_PASSWORD_HASH", "KITCHEN_ORIGIN",
    "KITCHEN_CREDENTIAL_STORE",
)
ENV_KEYS = CONFIG_KEYS + ("KITCHEN_PASS",)


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.previous_env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key, value in zip(CONFIG_KEYS, (TEST_USER, TEST_HASH, ORIGIN)):
            os.environ[key] = value
        os.environ.pop("KITCHEN_CREDENTIAL_STORE", None)
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

    def enable_mock_store(self, writer=None):
        """Mock verifier I/O while exercising the real API/session logic."""
        store_path = Path(self.sandbox.name) / "synthetic-verifier"
        os.environ["KITCHEN_CREDENTIAL_STORE"] = str(store_path)
        box = {"verifier": TEST_HASH}

        def read(_path, _checkout):
            return box["verifier"]

        def replace(_path, _checkout, verifier):
            if self.store_writer_state["call"] is not None:
                return self.store_writer_state["call"](_path, _checkout, verifier)
            box["verifier"] = verifier

        self.store_writer_state = {"call": writer}
        self.read_store_patch = patch.object(
            self.backend.credential_store, "read_verifier", side_effect=read,
        )
        self.read_store_patch.start()
        self.addCleanup(self.read_store_patch.stop)
        self.write_store_patch = patch.object(
            self.backend.credential_store, "replace_verifier", side_effect=replace,
        )
        self.write_store_mock = self.write_store_patch.start()
        self.addCleanup(self.write_store_patch.stop)
        self.synthetic_verifier = box
        return box

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

    def test_password_change_unavailable_during_environment_hash_bootstrap(self):
        self.assertEqual(self.login().status_code, 200)
        old_hash = os.environ["KITCHEN_PASSWORD_HASH"]
        response = self.client.post(
            "/api/change-password", headers={"Origin": ORIGIN},
            json={
                "current_password": TEST_PASSWORD,
                "new_password": "a different long passphrase",
                "confirm_password": "a different long passphrase",
            },
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(os.environ["KITCHEN_PASSWORD_HASH"], old_hash)
        self.assertEqual(self.client.get("/api/session").status_code, 200)

    def test_change_password_route_origin_auth_content_type_and_stream_limits(self):
        self.enable_mock_store()
        self.assertEqual(self.login().status_code, 200)
        json_body = {
            "current_password": TEST_PASSWORD,
            "new_password": "A valid synthetic phrase 2041",
            "confirm_password": "A valid synthetic phrase 2041",
        }
        self.assertEqual(self.client.post(
            "/api/change-password", headers={"Origin": "https://attacker.test"}, json=json_body,
        ).status_code, 403)
        self.assertEqual(self.client.post(
            "/api/change-password", headers={"Origin": ORIGIN, "Content-Type": "text/plain"}, content="{}",
        ).status_code, 415)
        unsigned = TestClient(self.backend.app, base_url=ORIGIN)
        try:
            self.assertEqual(unsigned.post(
                "/api/change-password", headers={"Origin": ORIGIN}, json=json_body,
            ).status_code, 401)
        finally:
            unsigned.close()
        self.assertEqual(self.client.post(
            "/api/change-password",
            headers={"Origin": ORIGIN, "Content-Type": "application/json"},
            content=b" " * (self.backend.MAX_BODY + 1),
        ).status_code, 413)

        async def chunked_status():
            import httpx

            limit = self.backend.MAX_BODY

            class ChunkedOversize(httpx.AsyncByteStream):
                async def __aiter__(self):
                    yield b" " * limit
                    yield b"x"

            transport = httpx.ASGITransport(app=self.backend.app)
            async with httpx.AsyncClient(transport=transport, base_url=ORIGIN) as client:
                request = client.build_request(
                    "POST", "/api/change-password",
                    headers={
                        "Origin": ORIGIN,
                        "Content-Type": "application/json",
                        "Cookie": f"{self.backend.SESSION_COOKIE}={self.client.cookies.get(self.backend.SESSION_COOKIE)}",
                    },
                    content=ChunkedOversize(),
                )
                self.assertNotIn("content-length", request.headers)
                response = await client.send(request)
                return response.status_code

        self.assertEqual(asyncio.run(chunked_status()), 413)
        self.assertEqual(self.write_store_mock.call_count, 0)

    def test_configured_missing_or_corrupt_store_never_falls_back_to_env_hash(self):
        path = Path(self.sandbox.name) / "verifier"
        os.environ["KITCHEN_CREDENTIAL_STORE"] = str(path)
        for expected_missing in (True, False):
            if not expected_missing:
                path.write_text("corrupt synthetic verifier\n", encoding="ascii")
                try:
                    path.chmod(0o600)
                except OSError:
                    pass
            with self.subTest(missing=expected_missing):
                self.assertEqual(self.client.get("/api/status").status_code, 503)
                self.assertEqual(self.login().status_code, 503)
            if expected_missing:
                self.assertFalse(path.exists())
        self.assertEqual(path.read_text(encoding="ascii"), "corrupt synthetic verifier\n")

    def test_login_does_not_issue_session_if_credential_snapshot_rotates_mid_verification(self):
        rotated_salt = b"rotated synthetic salt"
        rotated_hash = "pbkdf2_sha256$600000$" + rotated_salt.hex() + "$" + hashlib.pbkdf2_hmac(
            "sha256", b"rotated fixture password", rotated_salt, 600000,
        ).hex()

        def rotate_during_verify(_password, _stored_hash):
            os.environ["KITCHEN_PASSWORD_HASH"] = rotated_hash
            return True

        with patch.object(self.backend, "verify_password", side_effect=rotate_during_verify):
            response = self.login()

        self.assertEqual(response.status_code, 503)
        self.assertNotIn(self.backend.SESSION_COOKIE, response.cookies)
        self.assertEqual(self.backend._sessions, {})

    def test_password_change_rejects_bad_current_and_password_fields_without_writing(self):
        self.enable_mock_store()
        self.assertEqual(self.login().status_code, 200)
        cases = (
            {"current_password": "wrong", "new_password": "a good long passphrase 🥐", "confirm_password": "a good long passphrase 🥐"},
            {"current_password": TEST_PASSWORD, "new_password": "short", "confirm_password": "short"},
            {"current_password": TEST_PASSWORD, "new_password": "a good long passphrase 🥐", "confirm_password": "another good long passphrase 🥐"},
            {"current_password": TEST_PASSWORD, "new_password": TEST_PASSWORD, "confirm_password": TEST_PASSWORD},
            {"current_password": "x" * 257, "new_password": "a good long passphrase 🥐", "confirm_password": "a good long passphrase 🥐"},
            {"current_password": TEST_PASSWORD, "new_password": "a" * 257, "confirm_password": "a" * 257},
            {"current_password": TEST_PASSWORD, "new_password": "a good long passphrase 🥐", "confirm_password": "y" * 257},
            {"current_password": TEST_PASSWORD, "new_password": "passwordpassword", "confirm_password": "passwordpassword"},
            {"current_password": TEST_PASSWORD, "new_password": "password123456789", "confirm_password": "password123456789"},
            {"current_password": TEST_PASSWORD, "new_password": "123456789012345", "confirm_password": "123456789012345"},
            {"current_password": TEST_PASSWORD, "new_password": "x" * 20, "confirm_password": "x" * 20},
        )
        for body in cases:
            with self.subTest(current=body["current_password"][:8], new=body["new_password"][:10]):
                response = self.client.post("/api/change-password", headers={"Origin": ORIGIN}, json=body)
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.write_store_mock.call_count, 0)
        self.assertEqual(self.synthetic_verifier["verifier"], TEST_HASH)
        self.assertEqual(self.client.get("/api/session").status_code, 200)

    def test_password_change_rejects_lone_surrogate_current_and_confirmation(self):
        self.enable_mock_store()
        self.assertEqual(self.login().status_code, 200)
        new_password = b"A well-formed new passphrase 2026"
        base = (
            b'{"current_password":"synthetic test password","new_password":"'
            + new_password + b'","confirm_password":"' + new_password + b'"}'
        )
        payloads = (
            base.replace(b'"current_password":"synthetic test password"', b'"current_password":"\\ud800"'),
            base.replace(b'"confirm_password":"' + new_password + b'"', b'"confirm_password":"\\ud800"'),
        )
        for payload in payloads:
            response = self.client.post(
                "/api/change-password",
                headers={"Origin": ORIGIN, "Content-Type": "application/json"},
                content=payload,
            )
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.write_store_mock.call_count, 0)

    def test_password_rate_limit_is_account_wide_and_valid_unicode_passphrase_is_accepted(self):
        self.enable_mock_store()
        self.assertEqual(self.login().status_code, 200)
        second_client = TestClient(self.backend.app, base_url=ORIGIN)
        try:
            cookie = self.client.cookies.get(self.backend.SESSION_COOKIE)
            for _ in range(self.backend.LOGIN_ATTEMPTS):
                response = second_client.post(
                    "/api/change-password",
                    headers={"Origin": ORIGIN, "Cookie": f"{self.backend.SESSION_COOKIE}={cookie}"},
                    json={
                        "current_password": "wrong synthetic password",
                        "new_password": "another good long phrase",
                        "confirm_password": "another good long phrase",
                    },
                )
                self.assertEqual(response.status_code, 400)
            throttled = self.client.post(
                "/api/change-password", headers={"Origin": ORIGIN},
                json={
                    "current_password": TEST_PASSWORD,
                    "new_password": "A long enough Unicode phrase 🥐 2026",
                    "confirm_password": "A long enough Unicode phrase 🥐 2026",
                },
            )
            self.assertEqual(throttled.status_code, 429)

            expired_at = self.backend.time.monotonic() - self.backend.LOGIN_WINDOW - 1
            self.backend._password_attempts[:] = [expired_at] * self.backend.LOGIN_ATTEMPTS
            success = self.client.post(
                "/api/change-password", headers={"Origin": ORIGIN},
                json={
                    "current_password": TEST_PASSWORD,
                    "new_password": "A long enough Unicode phrase 🥐 2026",
                    "confirm_password": "A long enough Unicode phrase 🥐 2026",
                },
            )
            self.assertEqual(success.status_code, 200)
            stored = self.synthetic_verifier["verifier"]
            self.assertNotIn("A long enough Unicode phrase", stored)
            self.assertTrue(self.backend.verify_password("A long enough Unicode phrase 🥐 2026", stored))
        finally:
            second_client.close()

    def test_password_change_reauthenticates_and_revokes_all_sessions(self):
        self.enable_mock_store()
        self.assertEqual(self.login().status_code, 200)
        second_client = TestClient(self.backend.app, base_url=ORIGIN)
        try:
            second_login = second_client.post(
                "/api/login", headers={"Origin": ORIGIN},
                json={"user": TEST_USER, "pass": TEST_PASSWORD},
            )
            self.assertEqual(second_login.status_code, 200)
            old_token = self.client.cookies.get(self.backend.SESSION_COOKIE)
            response = self.client.post(
                "/api/change-password", headers={"Origin": ORIGIN},
                json={
                    "current_password": TEST_PASSWORD,
                    "new_password": "A new safe phrase 🥐 for bakery",
                    "confirm_password": "A new safe phrase 🥐 for bakery",
                },
            )
            self.assertEqual(response.status_code, 200)
            self.assertIn(self.backend.SESSION_COOKIE, response.headers.get("set-cookie", ""))
            self.assertEqual(self.client.get("/api/session").status_code, 401)
            self.assertEqual(second_client.get("/api/session").status_code, 401)
            self.assertNotIn(old_token, self.backend._sessions)
            self.assertTrue(self.backend.verify_password("A new safe phrase 🥐 for bakery", self.synthetic_verifier["verifier"]))
            self.assertFalse(self.backend.verify_password(TEST_PASSWORD, self.synthetic_verifier["verifier"]))

            self.client.close()
            backend = importlib.reload(self.backend)
            self._isolate_backend(backend)
            reloaded_client = TestClient(backend.app, base_url=ORIGIN)
            try:
                old_login = reloaded_client.post(
                    "/api/login", headers={"Origin": ORIGIN},
                    json={"user": TEST_USER, "pass": TEST_PASSWORD},
                )
                self.assertEqual(old_login.status_code, 401)
                new_login = reloaded_client.post(
                    "/api/login", headers={"Origin": ORIGIN},
                    json={"user": TEST_USER, "pass": "A new safe phrase 🥐 for bakery"},
                )
                self.assertEqual(new_login.status_code, 200)
            finally:
                reloaded_client.close()
        finally:
            second_client.close()

    def test_password_store_write_failures_have_distinct_recovery_semantics(self):
        from credential_store import StoreError, StoreWriteUncertain

        def fail_before_write(*_args):
            raise StoreError("synthetic pre-replace failure")

        self.enable_mock_store(writer=fail_before_write)
        self.assertEqual(self.login().status_code, 200)
        body = {
            "current_password": TEST_PASSWORD,
            "new_password": "Synthetic new phrase 2042 🥐",
            "confirm_password": "Synthetic new phrase 2042 🥐",
        }
        before = self.client.post("/api/change-password", headers={"Origin": ORIGIN}, json=body)
        self.assertEqual(before.status_code, 503)
        self.assertEqual(self.client.get("/api/session").status_code, 200)
        self.assertEqual(self.synthetic_verifier["verifier"], TEST_HASH)

        def fail_after_replace(_path, _checkout, verifier):
            self.synthetic_verifier["verifier"] = verifier
            raise StoreWriteUncertain("synthetic post-replace fsync failure")

        self.store_writer_state["call"] = fail_after_replace
        second_client = TestClient(self.backend.app, base_url=ORIGIN)
        try:
            second = second_client.post("/api/login", headers={"Origin": ORIGIN}, json={"user": TEST_USER, "pass": TEST_PASSWORD})
            self.assertEqual(second.status_code, 200)
            new_session = self.client.post("/api/login", headers={"Origin": ORIGIN}, json={"user": TEST_USER, "pass": TEST_PASSWORD})
            self.assertEqual(new_session.status_code, 200)
            uncertain = self.client.post("/api/change-password", headers={"Origin": ORIGIN}, json=body)
            self.assertEqual(uncertain.status_code, 503)
            self.assertIn("Max-Age=0", uncertain.headers.get("set-cookie", ""))
            self.assertEqual(self.client.get("/api/session").status_code, 401)
        finally:
            second_client.close()

    def test_concurrent_password_changes_cannot_both_replace_verifier(self):
        self.enable_mock_store()
        self.assertEqual(self.login().status_code, 200)
        cookie = self.client.cookies.get(self.backend.SESSION_COOKIE)
        barrier = threading.Barrier(3)
        clients = [TestClient(self.backend.app, base_url=ORIGIN) for _ in range(2)]
        bodies = (
            {
                "current_password": TEST_PASSWORD,
                "new_password": "First competing phrase 2026 🥐",
                "confirm_password": "First competing phrase 2026 🥐",
            },
            {
                "current_password": TEST_PASSWORD,
                "new_password": "Second competing phrase 2026 🥐",
                "confirm_password": "Second competing phrase 2026 🥐",
            },
        )

        def submit(client, body):
            barrier.wait()
            return client.post(
                "/api/change-password",
                headers={"Origin": ORIGIN, "Cookie": f"{self.backend.SESSION_COOKIE}={cookie}"},
                json=body,
            ).status_code

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(submit, client, body) for client, body in zip(clients, bodies)]
                barrier.wait()
                statuses = sorted(future.result(timeout=15) for future in futures)
            self.assertEqual(statuses, [200, 401])
            self.assertEqual(self.write_store_mock.call_count, 1)
            self.assertEqual(self.backend._sessions, {})
        finally:
            for client in clients:
                client.close()

    def test_login_racing_password_change_cannot_use_old_verifier(self):
        entered_write = threading.Event()
        release_write = threading.Event()

        def paused_replace(_path, _checkout, verifier):
            self.synthetic_verifier["verifier"] = verifier
            entered_write.set()
            if not release_write.wait(timeout=10):
                raise TimeoutError("synthetic store write release timed out")

        self.enable_mock_store(writer=paused_replace)
        self.assertEqual(self.login().status_code, 200)
        cookie = self.client.cookies.get(self.backend.SESSION_COOKIE)
        login_client = TestClient(self.backend.app, base_url=ORIGIN)
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                change_future = pool.submit(
                    self.client.post,
                    "/api/change-password",
                    headers={"Origin": ORIGIN},
                    json={
                        "current_password": TEST_PASSWORD,
                        "new_password": "A safe rotated phrase 2046 🥐",
                        "confirm_password": "A safe rotated phrase 2046 🥐",
                    },
                )
                self.assertTrue(entered_write.wait(timeout=10))
                login_future = pool.submit(
                    login_client.post,
                    "/api/login",
                    headers={"Origin": ORIGIN, "Cookie": f"{self.backend.SESSION_COOKIE}={cookie}"},
                    json={"user": TEST_USER, "pass": TEST_PASSWORD},
                )
                release_write.set()
                self.assertEqual(change_future.result(timeout=15).status_code, 200)
                self.assertEqual(login_future.result(timeout=15).status_code, 401)
        finally:
            release_write.set()
            login_client.close()

    def test_change_password_rechecks_authentication_after_current_password_verification(self):
        self.enable_mock_store()
        self.assertEqual(self.login().status_code, 200)
        token = self.client.cookies.get(self.backend.SESSION_COOKIE)

        def expire_after_verification(_password, _stored_hash):
            self.backend._sessions.pop(token, None)
            return True

        with patch.object(self.backend, "verify_password", side_effect=expire_after_verification):
            response = self.client.post(
                "/api/change-password", headers={"Origin": ORIGIN},
                json={
                    "current_password": TEST_PASSWORD,
                    "new_password": "A safe new phrase 2046 🥐",
                    "confirm_password": "A safe new phrase 2046 🥐",
                },
            )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.write_store_mock.call_count, 0)
        self.assertEqual(self.synthetic_verifier["verifier"], TEST_HASH)

    @unittest.skipUnless(os.name == "posix", "real verifier permission and atomic-replace checks require POSIX")
    def test_real_posix_verifier_store_enforces_owner_mode_and_replacement(self):
        import stat

        from credential_store import StoreError, read_verifier, replace_verifier

        protected_dir = Path(self.sandbox.name) / "protected"
        protected_dir.mkdir(mode=0o700)
        protected_dir.chmod(0o700)
        verifier_file = protected_dir / "verifier"
        verifier_file.write_text(TEST_HASH + "\n", encoding="ascii")
        verifier_file.chmod(0o600)
        self.assertEqual(read_verifier(verifier_file, self.backend.BASE), TEST_HASH)

        replacement_salt = b"replace test salt"
        replacement = "pbkdf2_sha256$600000$" + replacement_salt.hex() + "$" + hashlib.pbkdf2_hmac(
            "sha256", b"synthetic replacement phrase", replacement_salt, 600000,
        ).hex()
        replace_verifier(verifier_file, self.backend.BASE, replacement)
        self.assertEqual(read_verifier(verifier_file, self.backend.BASE), replacement)
        self.assertEqual(stat.S_IMODE(verifier_file.stat().st_mode), 0o600)
        self.assertEqual(verifier_file.stat().st_uid, os.getuid())
        self.assertFalse(any(protected_dir.glob(".credential-*")))

        verifier_file.chmod(0o644)
        with self.assertRaises(StoreError):
            read_verifier(verifier_file, self.backend.BASE)

    @unittest.skipUnless(os.name == "posix", "symlink/hardlink protection requires POSIX")
    def test_real_posix_store_rejects_links_and_unsafe_parent_modes(self):
        from credential_store import StoreError, read_verifier

        protected = Path(self.sandbox.name) / "protected-links"
        protected.mkdir(mode=0o700)
        protected.chmod(0o700)
        target = protected / "target"
        target.write_text(TEST_HASH + "\n", encoding="ascii")
        target.chmod(0o600)

        symlinked_file = protected / "verifier-symlink"
        symlinked_file.symlink_to(target.name)
        with self.assertRaises(StoreError):
            read_verifier(symlinked_file, self.backend.BASE)

        hardlink = protected / "verifier-hardlink"
        os.link(target, hardlink)
        with self.assertRaises(StoreError):
            read_verifier(hardlink, self.backend.BASE)

        unsafe_parent = Path(self.sandbox.name) / "unsafe-parent"
        unsafe_parent.mkdir(mode=0o755)
        unsafe_parent.chmod(0o755)
        unsafe_file = unsafe_parent / "verifier"
        unsafe_file.write_text(TEST_HASH + "\n", encoding="ascii")
        unsafe_file.chmod(0o600)
        with self.assertRaises(StoreError):
            read_verifier(unsafe_file, self.backend.BASE)

        ancestor_link = Path(self.sandbox.name) / "ancestor-link"
        ancestor_link.symlink_to(protected, target_is_directory=True)
        with self.assertRaises(StoreError):
            read_verifier(ancestor_link / "target", self.backend.BASE)

    @unittest.skipUnless(os.name == "posix", "atomic replacement and directory fsync require POSIX")
    def test_real_posix_replace_failures_preserve_old_or_report_uncertain_new_verifier(self):
        import credential_store
        from credential_store import StoreError, StoreWriteUncertain, read_verifier, replace_verifier

        protected = Path(self.sandbox.name) / "protected-failures"
        protected.mkdir(mode=0o700)
        protected.chmod(0o700)
        verifier_file = protected / "verifier"
        verifier_file.write_text(TEST_HASH + "\n", encoding="ascii")
        verifier_file.chmod(0o600)
        replacement_salt = b"atomic fixture salt"
        replacement = "pbkdf2_sha256$600000$" + replacement_salt.hex() + "$" + hashlib.pbkdf2_hmac(
            "sha256", b"synthetic atomic replacement phrase", replacement_salt, 600000,
        ).hex()

        with patch.object(credential_store.os, "replace", side_effect=OSError("before replace")):
            with self.assertRaises(StoreError):
                replace_verifier(verifier_file, self.backend.BASE, replacement)
        self.assertEqual(read_verifier(verifier_file, self.backend.BASE), TEST_HASH)
        self.assertFalse(any(protected.glob(".credential-*")))

        real_fsync = credential_store.os.fsync
        calls = 0

        def fail_directory_fsync(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("after replace, directory fsync failed")
            return real_fsync(fd)

        with patch.object(credential_store.os, "fsync", side_effect=fail_directory_fsync):
            with self.assertRaises(StoreWriteUncertain):
                replace_verifier(verifier_file, self.backend.BASE, replacement)
        self.assertEqual(read_verifier(verifier_file, self.backend.BASE), replacement)
        self.assertFalse(any(protected.glob(".credential-*")))

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
