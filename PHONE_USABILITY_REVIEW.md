# Phone usability patch review

Reviewed locally on 2026-11-12. Terra implemented the interface, Luna expanded the isolated tests, and the coordinator reviewed the changes and browser behavior. The initial local preview was reviewed; the owner subsequently authorized publication and deployment, with the refinements below.

## Changes

- Larger readable text, 48px minimum primary controls, visible focus, safe-area spacing and responsive navigation.
- A labelled Message field and text Send button; independent conversation scrolling and a whole-screen scrolling fallback on very short screens.
- Dictation stays a draft even when replies are read aloud. Switching tabs preserves drafts; logout clears private state.
- Offline messages remain unsent. Uncertain outcomes restore the draft without overwriting newer typing and ask the owner to check records before retrying.
- Contextual Help, a single four-tab navigation row and sequenced refreshes.
- Missing recipe prices/costs are explicit. Shopping and Money describe the existing estimates and limitations accurately; calculation behavior is unchanged.

## Owner refinements before release

The owner requested removal of the duplicate shortcut row, green and cream colors, and Poppins. The final design uses dark green controls with soft sage accents and self-hosted Poppins 400/600/700, bundled with its SIL Open Font License. The one tab group uses two columns on narrow phones so the larger font preserves whole-word labels. The final independent visual review scored these refinements 9/10. Commit `d73dbaa` is deployed; the live sign-in view and asset checks passed.

## Verification

All 22 Node frontend tests and 27 Python authentication/planning tests pass. `git diff --check` is clean. Python emitted an existing Starlette/httpx deprecation warning.

Browser checks used only the loopback synthetic preview, with no bakery records, production credentials, Hermes calls or live backend writes. Checked 320, 390, 430, 768 and 1280px widths, landscape/short heights, long content, draft preservation and keyboard tab navigation. No horizontal page overflow was observed. At 200% text size, the field reflows above its actions; an empty field has no internal overflow. On a 390x260 viewport with enlarged text, focusing the draft scrolls the full field and Send button into view.

The independent visual review scored the revised screenshots 9/10, with no visible composer blocker. Screenshots are in the workspace's `review-artifacts/phone-usability` folder. The screenshots and browser dimensions do not establish behavior with an actual phone keyboard or screen reader.

## Owner preview and next step

The synthetic preview is available on this computer at http://127.0.0.1:8790/. It is not reachable from another device through that address. Run `.venv\Scripts\python.exe tests\preview_server.py` from this checkout if it has stopped. The mock preview accepts any sign-in text; never enter real credentials there.

Before release, check on the owner's actual phone: sign in, read a long reply, type and dictate a draft, switch tabs and return, then reach Send with the keyboard open. Review the missing-price and estimate explanations for clarity. The owner authorized publication and deployment; see DEPLOYMENT_STATUS.md for the completed release record.
