# Make the manager useful in a bakery day

Source-only product review, 12 November 2026. This uses the checked-out UI and code, not bakery records or live behavior. Findings below describe the local source. Product needs are hypotheses until checked with the mother.

## What the current screen promises

After login, the manager opens a chat and offers Recipes, Shopping list, and Money tabs. The composer and greeting imply the assistant can add dishes, change prices, log sales, and keep a weekly list current.

## Verified gaps that affect trust

- The three tabs are read-only views. The backend exposes chat plus status, recipes, shopping, and profit reads; it has no structured order, sale, payment, correction, or stock-write routes. Chat writes therefore depend on the external Hermes profile, which this source review does not verify.
- The Money screen calls its period “This week”, but `weekly_profit()` reads every sale record and has no date filter. It estimates cost and revenue from the recipe as it exists now, so changing a recipe can alter an old sale's reported result.
- The Shopping list copy says it covers the week and suggests that sales keep it current. The calculation instead adds one recipe's ingredient quantities for each menu dish. It does not use orders, planned production, stock on hand, or sales demand; ingredients are matched by name without unit conversion.
- The interface groups order value, cash received, stock, and sales nowhere. An order request, confirmed order, fulfilled order, and paid sale need distinct states before their totals can be presented as the same thing.
- There is no single “what should I do next?” view. The user must choose a tab or know what to ask the chat, and the greeting is longer than a practical first action.

## Prioritized plan

### 0. Set honest expectations

Before promoting chat actions, verify each actual Hermes capability with a sandbox record. For unsupported actions, show “not available yet” or capture a proposal. Remove or qualify claims that shopping follows sales and that Money is weekly until the data supports those labels. Mark missing recipe costs or unpriced items as incomplete instead of showing a confident total.

### 1. Build one confirmed-order flow

Treat this as the first product hypothesis to validate with the mother: capturing a phone or walk-in order and knowing when it is due. Keep entry short and plain. Ask only for details needed to fulfill the particular order: what was requested, quantity, pickup date/time, agreed total, and any optional customer/contact note she chooses to provide. Do not assume that every bakery order needs the same custom fields.

Show a review before saving when the date, quantity, item, or price is unclear. On save, return a short receipt with a stable order number, pickup time, amount agreed, and amount received/balance if she entered a deposit. Provide edit, cancel, and mark-ready/fulfilled actions; preserve the prior value and change time so corrections are recoverable. A retry after a timeout must find the original order, not create another.

### 2. Add a Today view from confirmed records

Make the first screen answer “what needs my attention today?” Show pickup time, item/quantity, and a simple state such as needs confirmation, confirmed, ready, picked up, or cancelled. Separate overdue and upcoming items. An empty state should say that no confirmed orders are due, rather than imply there is no work. Add a quick path to enter an order and record a sale, while keeping both actions separately named.

### 3. Make money and shopping match real activity

Record an actual sale separately from an order and from cash received. Snapshot the agreed sale amount and cost basis at the sale date; allow a correction or refund without rewriting history. Label ingredient-only profit clearly and show “incomplete” when recipe cost is missing. Filter a defined week only after the owner chooses the timezone and week boundary.

Build shopping from an explicit production plan: planned batches/servings less usable stock. Convert only supported compatible units; otherwise show a clear “check unit” warning. Each line should explain the quantity and planned dishes behind it. Checking an item off means purchased; it must not silently subtract stock or change a sale.

### 4. Make chat a reliable helper around records

Let the assistant draft an order or data change, then ask for a focused confirmation before saving. After a confirmed save, show what record changed and how to find or correct it. Keep chat interpretation separate from deterministic validation and persistence. For unknown outcomes, show a status/retry path that checks whether the action already saved. Do not claim success from a generated sentence alone.

## First sprint: order to Today queue

Validate the order flow with the mother before implementing the form. Then keep the first increment to structured order capture, confirmation, persistence, and a Today list; defer inventory forecasting and broad Hermes actions.

Acceptance criteria:

1. A user can enter a straightforward order on a phone and review item, quantity, pickup time, and agreed amount before saving. Unclear required values are confirmed before the record is committed.
2. The saved order has a stable ID, appears under the correct local date/time on Today after refresh and restart, and can be edited or cancelled with a visible result.
3. A timeout or repeated tap cannot create a duplicate. If save status is unknown, the UI can find the original order by its request ID and report its status.
4. Order value, deposit received, remaining balance, fulfillment, and sale/cash collection remain separate fields and labels. The order is not automatically counted as a completed sale or paid cash.
5. Today distinguishes confirmed, awaiting confirmation, ready, fulfilled, and cancelled records; cancelled items do not appear as work due.
6. Synthetic fixtures cover same-day and next-day pickup boundaries in the chosen timezone, edits, cancellation, double submission, and restart recovery. No live customer or bakery data is used for these checks.
7. In a short phone walkthrough, the mother can add, find, and correct an order without needing to know API terms. Record where she hesitates and adjust the language before expanding the workflow.

## Decisions to gather from the mother

Ask her to walk through one typical order and one change/cancellation. Confirm which fields she already writes down, what she checks first each morning, how she distinguishes a deposit from a paid order, and what should appear on a prep list. Also confirm her preferred language and how she describes order states. These answers determine the next fields and labels; do not infer them from the current demo copy.
