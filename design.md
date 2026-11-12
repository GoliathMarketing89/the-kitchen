# Phone usability design

## Goal and scope

Help the mother read the manager, reach the next control, understand the result and recover from a mistake on her phone. The approved action plan and request authorize this existing-interface refinement. Keep the cream background and four tabs. The owner requested welcoming green accents and Poppins, self-hosted with a system-font fallback. The owner approved publication and deployment after reviewing the local preview; actual-phone acceptance follows release.

This is a task interface. Success means completing a familiar task comfortably, with a clear indication of what happened. Marketing sections, decorative assets and conversion-page patterns do not apply to this patch.

## Screen outline and references

The shared design-reference library was checked. Its marketing navigation and landing-page examples do not fit this small application refinement. Reuse the existing manager as the visual reference for each section, with the WAI references already included in `NEXT_ACTION_PLAN.md` guiding labels, contrast, focus, feedback and responsive behavior. This preserves the product direction authorized by the user rather than introducing a new visual concept.

| Section | Job | Reference and what to retain or improve |
| --- | --- | --- |
| Sign in | Open the kitchen with a familiar form | Existing manager login at `https://manager.freshlymade.net/`: warm white card, visible labels, clear brown action. Improve readable labels, short-screen scrolling and helpful errors. |
| Header and tabs | Make each available view obvious | Existing `.topbar` and `.tabbar` in `static/app.css`: retain four named tabs; improve target sizes, contrast, wrapping and selected state. Apply [WAI navigation and viewport guidance](https://www.w3.org/WAI/tips/designing/). |
| Conversation and composer | Read replies and send a reviewed message | Existing `.messages`, `.msg` and `.composer`: retain familiar message bubbles; give conversation its own scroll area and keep composer controls reachable. |
| Recipes and shopping | Scan names, prices and quantities comfortably | Existing `.data-row`: retain simple rows, allow long content to wrap, and clearly label missing or uncertain values. |
| Money | Understand what the estimates represent | Existing `.profit-grid`: retain grouped totals, stack on narrow screens, and remove reassuring profit language when costs may be incomplete. |
| Status and help | Explain success, errors and recovery beside the task | [WAI form notification guidance](https://www.w3.org/WAI/tutorials/forms/notifications/): concise status, actionable errors and explicit completion feedback. Use short main copy with optional explanations. |

## Copy before layout

- Greeting: “Welcome back. Use the tabs to view your recipes, shopping list and recorded sales, or type a message below.”
- Navigation: one row of four named tabs. Remove the duplicate view-shortcut row at the owner's request.
- Composer: “Type a message, or tap the microphone to dictate. Review it before sending.”
- Reply speech: “Read replies aloud”, with an explicit selected state. Dictation produces a draft for review.
- Money: “Estimates for all recorded sales. Check missing costs before relying on totals.” Expand “How these estimates work” for current-price/cost assumptions, missing recipes and other expenses.
- Shopping: describe one batch per matched menu dish and ask the user to check quantities and units. Explain missing recipes and demand/stock limitations beside this view.
- Missing price: “Price not set”. Missing or invalid cost: an incomplete state rather than a reassuring margin color.
- Unknown chat outcome: “The reply didn't arrive. Your request may still have been processed. Check your records before sending it again.”

## Interaction and visual checks

Use comfortable phone body text, readable supporting text and large tap targets. Preserve zoom, visible focus and reduced-motion behavior. Keep ordinary navigation drafts in memory and clear private state across sessions. Keep requests sequenced and separate a failed refresh from fresh data. Do not automatically retry a potentially consequential chat request.

Check 320, 390, 430, 768 and desktop widths, short landscape, long conversations and names, enlarged text, login errors, tab keyboard controls, offline/error states and delayed responses. A reduced desktop-browser viewport is a useful check, but does not establish actual iOS/Android keyboard behavior.

## Review and release

Terra implements, Luna supplies independent behavior tests and synthetic preview fixtures, and the coordinator reviews the diff and actual browser layout. A fresh visual critic reviews screenshots against these references. The owner reviewed the preview and authorized publication with the single navigation row and green/cream Poppins refinements. No production data, credentials or live Hermes execution is needed for this patch.
