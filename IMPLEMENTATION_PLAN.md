# Kitchen Manager implementation plan

Start with a safe phone pilot, then make business records trustworthy, then connect dependable Hermes actions. Build and review one small patch at a time. Terra owns deeper implementation, Luna handles bounded supporting work, and the coordinating agent scopes changes, reviews integration and reports results.

Prepared 12 November 2026 against repository revision `aa8cfab`. The original requirements remain in `../The-Kitchen-improvements.md`.

## First working session

- Completed: downloaded the repository into `source/` and checked the current backend, manager UI and planning engine against the handoff.
- Completed: Terra assessed the authentication and Hermes boundary without reading credential contents or contacting production.
- Completed: Luna added standard-library tests using temporary synthetic data. This gives later calculation changes a reproducible starting point; it does not certify the existing arithmetic. The four-test baseline passes with Python 3.12.
- Completed locally: Terra implemented server authorization and the matching browser login/logout lifecycle; Luna added independent authentication regression tests. The coordinating agent reviewed the patch and requested fixes for request handling, session races and Unicode limits.

The authentication patch is published as `2a2027e` and deployed to the existing Hermes host using a separate runtime, protected external configuration and localhost-only binding. External HTTPS checks verify API gates, login, secure cookies, session persistence and logout invalidation. A private backup and separate restore copy were verified; all four business-record checksums are unchanged. See `DEPLOYMENT_STATUS.md`. Runtime credential files have been removed from the current source tree. The application password has been replaced; historically exposed tunnel credentials still require rotation, pending working Cloudflare administration access.

Local verification: 27 Python tests and seven Node tests pass, covering authentication, request validation, session races and the initial calculation baseline. Tests use synthetic fixtures and mocked business operations. Actual browser/phone checks, production configuration, credential remediation and backup restore verification remain pilot acceptance work.

The updated product sequence and usability acceptance criteria are in `NEXT_ACTION_PLAN.md`.

## 1 Secure access and recovery

**Implementation: Terra. Supporting fixtures: Luna. Integration and review: coordinator.**

Implement explicit password-hash configuration with no default password, opaque server sessions, expiry and logout invalidation. Require authorization on chat, status, recipes, shopping and money APIs. Update the browser to use the server session, restore a valid session on refresh, handle expiry and invalidate it on logout. Remove raw login-response logging and return safe errors.

Add login rate limits, request/body bounds, a configured same-origin policy for state-changing requests, and Secure, HttpOnly, SameSite cookies. Restrict API documentation appropriately. Select session and rate-limit storage from the confirmed process topology; an in-memory implementation must be explicitly limited to a single-process pilot and invalidate sessions on restart.

Prepare deployment instructions for secrets outside web-served/tracked paths, credential rotation, backup and restore. Execute rotation and live access changes under the owner's approval. Confirm which service serves the customer menu and which serves the manager before changing URLs.

**Exit check:** every private route rejects unauthenticated access; login, expiry, logout invalidation, cross-origin requests and malformed/oversized requests have automated coverage. Tests mock Hermes and use temporary state. A backup restores successfully into a separate location before live changes.

## 2 Phone usability and request lifecycle

**Implementation: Terra for stateful interactions; Luna for bounded accessibility and UI checks. Coordinator reviews the full phone flow.**

Keep the composer visible while messages scroll; increase phone text and tap targets; handle short viewports, safe areas and long names. Improve labels, focus, tab semantics and loading/error states. Preserve drafts across normal navigation, reset them across sessions, block duplicate sends and ignore replies from ended sessions. Separate dictation from automatic sending and spoken replies.

Follow the applicable design skill before UI implementation. Recheck any earlier local drafts; none were present in this checkout.

**Exit check:** widths 320, 390, 430, 768 and desktop, short landscape and enlarged text work without clipped controls. Verify delayed replies, repeated sends, tab changes and logout. Actual iOS/Android keyboard behavior needs device verification before pilot acceptance.

## 3 Trustworthy records and calculations

**Implementation: Terra. Scenario fixtures and regression cases: Luna. Coordinator owns the model and migration review.**

First distinguish damaged/missing storage from intentionally empty data. Then introduce stable record IDs and explicit currency, batch yield, sale unit and timezone. Use decimal money, immutable sale price/cost snapshots, dated sales, correct weekly boundaries and explicit incomplete-cost states. Normalize compatible ingredient units and warn about missing recipes. Label the summary as revenue after ingredient costs.

Resolve the curry price/unit discrepancy with the owner before migrating it. Preserve off-menu recipes and original records. Use SQLite for a confirmed single-host deployment if appropriate; test migration on copies, validate reconciliation and retain human-readable exports. Make production quantities and stock explicit before promising a demand-based shopping list.

**Exit check:** manually checked fixtures cover price changes after sales, missing recipes, renamed dishes, mixed units, portions versus batches, rounding, week boundaries, corrections and refunds. Migration and recovery preserve records.

## 4 Dependable Hermes actions

**Implementation: Terra. Failure and retry scenarios: Luna. Coordinator verifies capability claims.**

Verify the actual authorized Hermes installation, profile and supported response format. Replace terminal scraping with a supported structured interface, use bounded background execution, check failures safely and maintain conversation state on the server. Keep business writes behind deterministic validated operations; return saved record IDs and concise receipts.

Add request IDs and idempotency for writes, unknown-outcome recovery and status checks before retrying. Refresh affected views after confirmed changes. Do not advertise photo uploads, sale entry or other tools until their end-to-end behavior is verified. Leave the existing spending limit unchanged while preparing accurate usage accounting and a proposed operating threshold.

**Exit check:** each advertised action passes against sandbox records. Timeouts, concurrent submissions and retries cannot duplicate sales. A response never claims success before a confirmed write.

## 5 Daily operations and controlled improvement

**Implementation: Terra for workflows; Luna for bounded forms, fixtures and regression checks. Coordinator reviews each increment.**

After the safe pilot, implement order capture and corrections, a Today preparation queue, stock-aware shopping, deposits/payment state and exports according to observed bakery tasks. Keep customer inquiries, accepted orders, fulfillment and paid sales distinct.

Then add persistent feature proposals, an isolated coding worker, automated checks, independent review, release authority and rollback. Ordinary bakery chat must not acquire deployment credentials. Start with one requested feature moving through the full review and approved release process before enabling an ongoing queue.

**Exit check:** one complete real task is easy on a phone; one feature request reaches a tested preview and approved release with traceability and rollback that preserves subsequent business records.

## Decisions needed when their stage begins

| Decision | Needed before |
| --- | --- |
| Manager and customer-menu URLs, hosting/proxy topology and HTTPS termination | Security release configuration |
| Mother's phone/browser and preferred language | Phone pilot acceptance and voice defaults |
| Shop timezone, week boundary, curry price and batch/sale units | Calculation migration |
| Backup destination and retention | Live data changes |
| Who can request features and approve releases | Controlled improvement workflow |
| Chat and improvement spending thresholds | Ongoing improvement jobs or budget changes |

Continue local implementation and synthetic testing while these are gathered. Ask only for the decision needed by the next dependent action.

## Delivery discipline

Keep each patch scoped to one coherent behavior, run relevant checks and review the diff before moving on. Share what changed, verification evidence and remaining limits. Prepare a concrete preview before requesting release approval. Credential rotation, live access changes, destructive data migration, spending changes and production release remain separate owner decisions.
