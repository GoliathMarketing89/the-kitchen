# Kitchen Manager next action plan

Make the manager answer three practical questions for the mother: what needs doing, what has been saved, and how to correct a mistake. Give common tasks visible buttons and keep Hermes available for help and interpretation. Validate the sequence against one real bakery day before adding more screens.

Prepared 12 November 2026. Authentication release `2a2027e` is published to GitHub. Deployment to the existing Hermes host is pending an accepted SSH login; the live manager still returns 404 for `/api/session`. The public menu and manager both respond over HTTPS. The live sign-in screen was inspected; the signed-in workflow assessment comes from source, without entering credentials or invoking Hermes.

## What needs attention

The current manager opens with a long chat greeting and read-only Recipes, Shopping list and Money tabs. Structured order, payment, stock and correction routes are absent. Any chat-driven write depends on the installed Hermes profile, whose live tools still need verification.

Money currently calls an all-time calculation “This week” and recalculates historical sales from current recipe values. Shopping adds one batch for each matching menu dish and combines ingredients by name without checking compatible units. Those labels can give a confident impression that the underlying records do not support.

The sign-in form has visible labels and a clear primary action. The next usability work belongs inside the manager: readable phone controls, a reachable composer, concise guidance and an understandable saved result. Ease of use should include safe recovery when the connection drops or the user taps twice.

## 0 Finish and verify the authentication release

Use the existing host and domain. Preserve records, back up and verify a separate restore, provision the password hash and origin in protected configuration, and use a verified Python 3.11+ runtime. Follow `DEPLOYMENT_RUNBOOK.md`; a Git push alone does not update this systemd service. Preserve host runtime files before any Git update that removes formerly tracked configuration.

Check unauthorized rejection on every private route, owner login, refresh, expiry and logout on the real HTTPS origin. Rotate previously exposed credentials and tunnel credentials through the existing administration path. Current-tree removal does not remove Git history. Keep rollback access restricted because the previous backend has no API authorization.

**Owner:** coordinator with Terra supporting deployment diagnosis. **Done when:** the expected revision is running, the owner can sign in on her phone, and unauthorized requests fail. Publication is complete; deployment remains pending server access.

## 1 Make the present app comfortable and honest

First watch the mother perform a typical task and a correction. Confirm her phone, preferred language, shop timezone, terminology and usual order-taking process. Use her own example to choose labels and shortcuts. A short observation should shape this sprint; research can proceed meanwhile.

- Replace the long greeting with a short welcome and a few verified actions. Keep a visible path to ask Hermes for help.
- Make phone text and tap targets comfortable, keep the composer reachable, preserve unsent work during navigation, and test with the keyboard open.
- Describe current money and shopping calculations accurately until their data models are corrected. Display missing prices and costs as incomplete.
- Show clear states such as “Saving”, “Saved”, “Could not save” and “Checking whether this saved”. Preserve entered details when a correction is needed.
- Let her dictate into a visible draft. Give spoken replies and automatic sending separate controls, with review before consequential saves.
- Add a plainly named help path that explains the current screen and how to fix an error. Support requests can become saved proposals; external messages require their own authorization.

**Owners:** Terra implements interaction changes; Luna tests phone behavior and failure states; coordinator reviews the language and complete flow. **Acceptance:** she can sign in, navigate, type or dictate, retry a failed request and explain what saved without technical guidance. Verify small and short phone viewports, enlarged text, keyboard use and her actual browser.

## 2 Complete one order from entry to pickup

The first substantial feature should be a small, dependable order workflow. Proposed entry: item, quantity, agreed price and pickup date/time, with customer/contact notes only when useful. Offer familiar products and recent choices. Show an explicit price and date for review; an old preference must not silently decide a new commitment.

Use stable IDs, transactional persistence, validation, an audit trail and idempotent save requests. SQLite is a reasonable starting point if the verified deployment remains a single host. Test new storage and restore on synthetic copies before using business records.

Return a short receipt: what was ordered, pickup time, agreed total and deposit if recorded. Put Edit, Cancel and Mark ready within reach of the saved order. Preserve earlier values so a correction can be explained and recovered.

Then make a **Today** view from those confirmed records: next pickups, item quantities and visible status. Overdue work should stand out; cancelled orders should leave the work queue. Show an explicit empty state and a separate upcoming view. Keep Chat readily available from each task.

**Owners:** Terra builds storage and the complete flow; Luna supplies synthetic scenarios and phone regression checks; coordinator reviews the model and walkthrough. **Acceptance targets:** enter a straightforward order in about a minute, find the next pickup in a few seconds, and correct it without losing the record. Refresh, restart, repeated taps and uncertain network outcomes must preserve one order under the correct shop date. Adjust the speed targets after observing her use.

## 3 Give her a useful end-of-day view

Separate order value, payment received, outstanding balance and completed sales. A deposit needs its own record; it must not count as both a deposit and another full payment. Let her record payment against an order, record an ordinary counter sale, and correct an amount with a visible history.

Show a concise daily close: money received today, outstanding amounts and sales recorded. Add historical sale-price and cost snapshots, decimal arithmetic, explicit currency and correct date filtering. Label revenue after ingredient costs precisely, and mark results incomplete when costs are missing. Resolve price/batch/portion discrepancies before showing reassuring margins.

**Acceptance:** a synthetic order with a deposit, final payment, price change and correction reconciles by hand. Changing today's recipe cannot alter an earlier sale. The mother can identify who still owes money and distinguish payment received from an order's value.

## 4 Turn orders into preparation and shopping

Start with an explicit production plan for a selected day. Group confirmed quantities into recipe batches using reviewed yields and sale units. Let her adjust planned production for extra counter stock, then review the plan before calculating ingredients.

Show a preparation checklist and shopping quantities with an explanation of the batches behind them. Normalize supported units and visibly flag uncertain matches. Add stock deductions only after she agrees how stock is counted; support an estimated/manual plan until those records are dependable. A shopping tick and a stock adjustment should have explicit meanings.

**Acceptance:** she can trace a shopping quantity to the selected production plan, spot a missing recipe and check off purchases on a phone. Mixed grams/kilograms and missing costs cannot silently create a misleading total. Capacity warnings should use limits she supplies.

## Later improvements worth testing

| Idea | Benefit to test | Prerequisite |
| --- | --- | --- |
| Repeat a previous order | Less typing for regular orders | Review the new date, quantity and current agreed price before saving |
| Favorites and recent products | Faster selection with familiar names | Stable product IDs and clear sale units |
| Photo beside an order or dish | Easier recognition and custom-order reference | Validated upload, safe storage and a private/public distinction |
| A simple baking or packing checklist | Fewer forgotten handover steps | Her own process; avoid invented food-safety instructions |
| Offline draft recovery | Less lost typing on an unreliable connection | Protect local private data, clear it on logout, and reconcile before saving |
| A phone home-screen shortcut | Easier return to the app | Verified HTTPS/auth and help installing it on her actual device |
| A short “what changed” note | Less surprise after improvements | Verified release notes and a persistent feedback backlog |

Treat these as hypotheses to choose from after the first complete workflow. Avoid adding background notifications or customer messaging until recipients, timing and authorization are agreed.

## How to choose the next patch

After the deployment is verified, start with sprint 1 and a small prototype of order entry. Before designing the interface, follow the repository's design skill and use the mother's real task to check the design. Build one vertical slice at a time, review it independently, and test the failure path as carefully as the happy path. New feature requests belong in the persistent improvement backlog; release credentials stay outside ordinary bakery chat.

Use visible labels, consistent navigation, readable contrast and feedback beside the task. These choices follow [W3C WAI design guidance](https://www.w3.org/WAI/tips/designing/). Keep save and error feedback concise and actionable, following [WAI form notification guidance](https://www.w3.org/WAI/tutorials/forms/notifications/).
