# Kitchen authentication deployment status

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

- Complete the Cloudflare MCP account connection and rotate the tunnel secret exposed in Git history. The existing server-side API token returns 401, so rotation has not been performed. Removing files from the current source tree does not erase history exposure.
- Have the owner sign in on her actual phone and confirm keyboard, navigation, voice, expiry and retry behavior. Automated browser-state tests do not replace this walkthrough.
- Verify the installed Hermes profile's permissions and supported operations before promoting chat-driven business writes.
- Follow `NEXT_ACTION_PLAN.md` for phone usability, structured orders and Today, dependable money records, and production-driven shopping.
