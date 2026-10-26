# Diagnostics: request and interaction timings

The dashboard's Diagnostics page has two tabs, both backed by one SQLite file
(`requestTimingsPath()` in `core/src/paths.ts`), each sample kept 7 days:

- **Requests**: server-side timing of every `/api/*` call
  (`core/src/request-timings.ts`, middleware at the top of `server/src/app.ts`).
- **Interactions**: browser-side timing of every human interaction with the
  dashboard (`dashboard/src/interactions.ts` measures,
  `core/src/interaction-timings.ts` stores and aggregates).

Read this before changing either, or when using the data to find out why the UI
feels slow.

## Reading the data

Query the running server directly; no browser needed:

```bash
curl -s 'http://localhost:5173/api/diagnostics/interactions?action=mention&minMs=200'
curl -s 'http://localhost:5173/api/diagnostics/requests?request=seats'
```

Filters are listed in `InteractionQuery` / `TimingQuery` (`server/src/schemas.ts`).
Each snapshot returns aggregates plus the 50 slowest and 50 newest samples,
computed over at most the newest 5000 matching samples.

An interaction has two durations:

- **paintMs**: input to the first frame painted after it. This is
  responsiveness: a slow value means rendering, not the network.
- **ms**: input to the end of the interaction. With outcome `settled` that is
  the frame painted after every attributed request finished, with no new
  request for 100 ms. `superseded` means the operator acted again first (ms
  runs up to that next input, it is not a latency). `timeout` means requests
  were still running at 15 s.

Aggregates (p50/p95, max, total) for `ms` use `settled` samples only; `unsettled`
counts the rest. `requests` on each sample lists the fetches it started, with
offset, duration and status, so a slow settle can be split into network time
versus render time. A request with `ms: null` was still in flight when the
interaction ended.

## How interactions are measured

`installInteractionTracking` runs once from `main.tsx`. It listens in the
capture phase on `window`, so it labels the element before any handler changes
the DOM, and it starts the clock at `event.timeStamp` (includes input delay).

What counts as one interaction:

| kind     | trigger                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------- |
| `click`  | any trusted click, except on text fields and native pickers (that click only focuses or opens)    |
| `key`    | keydown outside text fields; inside them only Enter, Escape and Ctrl/Alt/Meta combos; never Tab, modifiers alone or auto-repeat |
| `change` | `<select>` and native pickers (date, color, range, file)                                          |
| `input`  | each keystroke in a text field                                                                    |

Gotchas that look removable but are not:

- Enter/Space on a button and Enter submitting a form make the browser
  synthesize a click (`detail === 0`). It is dropped when it follows a keydown
  within 50 ms, otherwise it would supersede the key interaction.
- A click on a `<label>` is re-dispatched to its control; only the control's
  click is recorded.
- Only one interaction is open at a time; a new input supersedes it.

Request attribution: `window.fetch` is wrapped, and every fetch started while
an interaction is open belongs to it. That includes background polls that
happen to fire in the window (visible in the request list). A request ends when
its body is read (`json`/`text`/`arrayBuffer`/`blob`), or right after the
headers if the caller does not read the body in the same turn, so streamed
responses end at the headers. `EventSource` is not tracked. Polls run in the
shared hub (a SharedWorker), outside the wrapped fetch: a refresh the page asks
for (`refreshPoll`) is attributed from the request until the hub's answer for
that url arrives; the hub's own timed polls are not.

The settle state machine is `InteractionTracker`, written against injected
clock, timer and paint hooks so `interactions.test.ts` drives it with a fake
clock. Change the timing rules there and cover them in that test.

## Labels

`action` names what was acted on: `button "Close"`, `link "Issues"`,
`select "Harness"`, `Escape on button "Close"`, `dialog backdrop`. The name is
taken from, in order: `aria-label`, `aria-labelledby`, a form control's
`<label>`/placeholder/name, the element's text if under 40 characters,
otherwise its first text node, then `title`. `context` is the title of the
enclosing `<dialog>` or `role="dialog"` (aria label, first heading, or first
text). `route` is the TanStack route id (`/tasks/$id`) so pages aggregate;
`path` is the concrete pathname.

Aggregates group by kind + action + context + route, so a label that embeds a
changing value (a count, a relative time) splits into many rows. When a control
reads badly in the data, give it an `aria-label`; that fixes both the
diagnostics label and accessibility.

## Upload and storage

The browser buffers samples and posts them to `POST
/api/diagnostics/interactions` every 5 s or at 50 samples, using the unwrapped
`fetch` so the upload is not attributed to an interaction. The flush on
`visibilitychange` to hidden uses `keepalive`, which caps the body at 64 KiB;
that is why only that last flush sets it. The request-timing middleware skips
every `/api/diagnostics/*` route, so neither the upload nor the page's own
polling shows up under Requests.

`InteractionTimings.record` prunes against `Date.now()`, since `at` comes from
the browser clock: tests must use recent `at` values or the rows are pruned on
insert.
