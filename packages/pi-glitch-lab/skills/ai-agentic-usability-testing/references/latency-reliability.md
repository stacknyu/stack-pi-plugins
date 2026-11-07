# Perceived Speed & Reliability

Users don't experience backend latency; they experience **waiting without knowing why**. Measure and judge what's visible.

## Thresholds (what the user feels)

| Moment | Good | Needs work | Finding |
|---|---|---|---|
| Visible response to a click/tap (pressed state, spinner, navigation start) | < 100 ms | 100–300 ms | > 300 ms with nothing visible: S2 on primary actions |
| Page or view usable after navigation | < 1 s | 1–3 s | > 3 s without skeleton/progress: S2 |
| AI: first sign of work (typing/thinking indicator) | < 300 ms | 300 ms–1 s | > 1 s blank after send: S2 |
| AI: first streamed words | < 2 s | 2–5 s | > 5 s with only a spinner: S2; no indicator at all: S1 |
| Long task (research, report, bulk processing) | progress + background | spinner only | blocking modal / no progress > 10 s: S2 |

Test on the persona's network. The teen on mobile data and the migrant on hostel Wi-Fi feel `slow3g`/`fast3g`, not office fiber.

## How to measure with the scripts

- `ux_affordance_scan` with explicitly authorized `probeClicks=true, interact=true`: time from click to first observable change. No-observable-response is inconclusive, not proof of a dead click.
- `ux_journeys` step `ms`: how long each step took to complete (including waiting for text/response).
- `measureResponse` step: `firstOutputMs` (time to first visible output in the reply container) and `completeMs` (when it stopped changing). Point the selector at the latest assistant message container.
- Record the same journey 3 times and report the median and worst. AI latency varies a lot, and the worst case is what users remember.

## Reliability signals to look for

- **Silent failure**: an asserted expected outcome did not occur and no error was shown. Distinguish this from an explorer not observing a valid clipboard/download/hover action.
- **Partial failure**: one widget fails and blanks the whole dashboard, or chat fails and loses the typed message.
- **Stuck states**: spinner that never ends; "Generating…" after the stream died. Check the screen 30–60 s later.
- **Console errors and failed requests** captured by the scripts: correlate with what the user saw. A 500 behind a friendly retry is fine; a 500 behind a blank panel isn't.
- **Retry behavior**: is there a visible retry? Does retry duplicate the message or the action?
- **Double actions**: fast double-tap sends two messages or creates two notes.
- **Session expiry**: after a long idle, does the next action fail silently or ask to log in again without losing work?

## Recommendations vocabulary (design level)

- Optimistic UI: show the user's message/note immediately, reconcile later.
- Skeletons shaped like the final content, not full-screen spinners.
- In-button pending state plus disabling to prevent double actions.
- Visible AI states: sending → thinking → streaming → done / failed (with retry); stop button during generation.
- Background long tasks with a progress indicator and a notification when done.
- Error messages that say what happened and what to do, in the persona's words, and keep the user's input.
