# Password-change security review

Scope: local changes after `154d980`, implementing the owner's authenticated password change. Terra implements, Luna tests, and the coordinator reviews authorization, credential storage, session races and the browser flow. This is not a review of the entire Hermes agent or a claim of complete security compliance. Nothing from this patch has been published or deployed.

## Design reviewed

The route requires an existing session, the exact configured Origin, JSON, bounded input and the current password. New passwords are confirmed, must differ from the current value, and use 15–256 Unicode characters. A small offline common-password list and repeated-character check provide baseline screening; this is not a comprehensive breached-password database. The length choice follows [NIST's single-factor guidance](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/). Password managers, paste and long phrases remain supported.

Only a newly salted PBKDF2 verifier is persisted. The configured file is authoritative and outside the checkout; an unsafe or unavailable configured store never falls back to the environment password. The Linux implementation checks ownership, permissions, regular-file status, link count and ancestor directories using descriptor-relative no-follow operations. Replacement uses an exclusive temporary file, file sync, atomic rename and directory sync. Secrets do not enter chat history, URLs or application browser storage.

Successful replacement revokes all sessions, clears the cookie and clears private browser state. If the server detects uncertainty after replacing the verifier, it also revokes sessions and instructs the owner to sign in again. If the browser loses the response, it clears local private state and requires sign-in, but cannot prove what the server completed; it does not automatically repeat the change. Existing already-started agent work is not cancelled by session revocation.

## Review findings addressed

- Session issuance now binds to the exact credential configuration that was verified. A concurrent change cannot attach a newer configuration to an old-password sign-in.
- The handler rechecks session and configuration immediately before writing. Changes and sign-ins serialize in the documented single process.
- Both credential forms explicitly use POST, preventing a JavaScript failure from putting form fields in a GET URL.
- Form secrets clear when cancelled, Help closes, the session ends, or the result is successful or uncertain. In-flight requests block a fresh sign-in until their response completes, preventing late cookie deletion from clobbering it.
- The password form opens a dedicated screen from Help. Browser review at 390px, 320px and enlarged text found no horizontal overflow; Cancel clears all three fields, returns to the manager and restores focus. The separate screen avoids the nested scrolling observed in the first draft.

## Verification completed

All 28 frontend tests pass. Windows ran 42 Python tests with 39 passing and three explicitly skipped POSIX tests. The coordinator then copied only the backend, credential module, planning module and synthetic Python tests to a private temporary Linux folder. With a scrubbed environment and test-only dependencies confined to that folder, all 42 Python tests passed without skips, including real ownership/mode checks, symlink and hard-link rejection, unsafe parents, replacement and injected pre/post-replace failures. The temporary folder was removed; no application files, production credential settings, records or services were modified. The test log is in the workspace's `review-artifacts/password-change/linux-tests.log`.

Browser checks used the loopback synthetic preview only. Cancel, mismatch feedback and successful completion behaved as expected; successful completion cleared all three password inputs and returned to sign-in. Phone widths and enlarged text had no horizontal overflow. This does not establish behavior with an actual phone keyboard or password manager.

No unresolved blocking issue was found in the reviewed feature within the single-process design below. The Linux validation gate is complete. Before deployment, privately provision the current verifier in the protected store and configure `KITCHEN_CREDENTIAL_STORE` following `AUTH_SETUP.md`. The owner must enter any actual new password herself; neither deployment nor this review changes it.

Keep one backend worker. Attempt counters and sessions are in memory; neither distributed throttling nor multiworker coordination is provided. Operator recovery is still required for a forgotten password. A privileged process running as the service owner remains trusted; this feature does not isolate Hermes tools or protect against a compromised server. The previously saved operator login file will become outdated after the owner changes her password; do not replace it with her new plaintext password.
