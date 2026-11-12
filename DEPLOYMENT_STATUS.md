# Kitchen authentication deployment status

## Owner password-change release

Published and deployed commit `5e1f4bc0cf021372f5a6257e90923ddf88735696` on 13 November 2026 at `https://manager.freshlymade.net/`. The existing username and password were preserved and verified over HTTPS after release. No password change was performed during deployment or verification.

The protected persistent verifier is authoritative, including after restart and after the owner changes her password. A graceful backend restart ended existing sessions. Live assets match the reviewed release, private routes remain protected, and secure-cookie/session/logout checks pass. A validation-only request confirmed the authenticated password-change route without changing a password. All four business records are unchanged, no assistant command was executed, and the public customer menu remains available.

Mom can use **Help → Change password**, enter her current password, and enter her chosen new password twice. Actual phone/password-manager acceptance remains for the owner. The pre-release review passed 42 isolated Linux Python tests and 28 frontend tests; see `PASSWORD_CHANGE_REVIEW.md`. Detailed operational notes are retained privately.

## Phone usability release

Published and deployed commit `d73dbaa7b5fb412cbeaa15f9b22d981a1d5e31bd` on 12 November 2026 to `https://manager.freshlymade.net/`. This static-only release includes larger controls and text, labelled Message/Send actions, safer draft and dictation behavior, contextual help and clearer estimate wording. The owner's final refinements remove duplicate shortcuts and introduce a green-and-cream theme with self-hosted Poppins. A single tab group uses two columns on narrow phones to keep whole words readable.

All 22 frontend tests pass; the 27 Python authentication/planning tests passed during review. The final independent visual review scored the revised screenshots 9/10. The live phone-sized sign-in page was checked in a browser and displays the green theme and Poppins without horizontal overflow.

Only the three manager UI files and bundled font/license assets were transferred from the committed release. Prior assets were backed up privately, replacements were atomic, and no service restart was required. Origin HTML and every public asset match release checksums. Public HTML is identical after accounting for Cloudflare's existing analytics beacon injection; the first strict check rolled back safely before this was diagnosed. Private APIs still return 401 without a session, the public customer menu returns 200, and the backend and all four business-record checksums remain unchanged. Credentials, tunnel configuration and DNS were not modified.

The owner can now try the release on her phone using her existing login. Actual phone keyboard, dictation permissions and screen-reader behavior remain acceptance checks; the deployment checks did not sign in or execute a live chat request.

Verified 12 November 2026 at `https://manager.freshlymade.net`. The authentication source from commit `2a2027e6e1cd988a9444a7623b8f7afc575a8019` was deployed through a code-only transfer to the existing Hermes host. Deployed file checksums match the reviewed release; the host checkout was not updated with a blanket Git pull.

## Verified release behavior

- The manager loads over HTTPS; private session, status, recipe, shopping and money routes reject unauthenticated requests with 401.
- An unauthenticated chat submission is rejected before Hermes can run. Cross-origin login is rejected, and API documentation endpoints are unavailable.
- Login succeeds using the newly provisioned private password. The cookie is Secure, HttpOnly and SameSite Strict, scoped to `/` without a Domain attribute.
- A subsequent session request succeeds. Logout invalidates the server session, and replaying the previous cookie fails.
- The backend runs as one process in a separate Python 3.14.7 environment with the pinned runtime dependencies. Its listener is bound to localhost and Uvicorn does not trust forwarded headers.
- Protected environment configuration is outside the checkout. New login details are stored privately and were not printed or committed.

The first external check was blocked for Python's default client signature. A named release-check client completed the full HTTPS verification. The public customer menu continues to respond separately from the manager.

## Record preservation and recovery

The previous service stopped gracefully with a timeout longer than its agent-request timeout. A private backup preserves the earlier code, actual service units, effective configuration, runtime configuration and business JSON records. A separate restore copy was parsed and checked against the originals.

The checksums of `menu.json`, `recipes.json`, `sales.json` and `state.json` remained unchanged through deployment and live verification. No Hermes chat or business mutation was used as a health check. Code rollback and data recovery remain separate operations; the old unauthenticated backend must not be reopened publicly without independent access control.

## Remaining acceptance work

- Have the owner sign in on her actual phone and confirm keyboard, navigation, voice, expiry and retry behavior. Automated browser-state tests do not replace this walkthrough.
- Verify the installed Hermes profile's permissions and supported operations before promoting chat-driven business writes.
- Follow `NEXT_ACTION_PLAN.md` for phone usability, structured orders and Today, dependable money records, and production-driven shopping.

## Tunnel security completed

Verified 12 November 2026 using the authenticated Cloudflare MCP connection. The account owns `freshlymade.net`, and its locally managed `kitchen-manager` tunnel matches the existing host configuration.

The exposed tunnel secret was replaced with a fresh 32-byte random secret. It was transferred to the host using an encrypted envelope and installed in owner-only configuration outside the checkout. Cloudflare disconnected the old connectors; the replacement connector is healthy with four edge connections. A separate negative test explicitly rejected the retired credential without establishing a connection.

The tunnel service now reads the protected external configuration. File ownership and permissions were verified, and the temporary transfer private key was removed. The manager and public menu return 200; unauthenticated private API access returns 401. Live login, cookie, session and logout/replay checks pass, and all business-record checksums remain unchanged.

Old credential copies remain in Git history and private audit backups, but the tested retired tunnel credential cannot reconnect. Preserve the current rotated credential and service override during future code rollback; do not restore a retired secret from an earlier backup.
