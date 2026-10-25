# Message sound

A short two-note chime plays when a message comes in, on two surfaces:

| Surface | Plays when | Never plays for | Mute toggle |
| --- | --- | --- | --- |
| Desk inbox (signed-in dashboard tab) | a new **customer** message arrives in the Workspace | the agent's own replies, notes, status changes | account menu → **Message sound** |
| Chat widget (visitor side) | a team (**agent**) reply arrives in the open thread | the visitor's own messages, the loaded history | speaker button in the panel header |

## Behaviour

- On by default, quiet (peak gain 0.05) and ~0.35 s long. Unmuting confirms
  with a preview chime.
- The mute choice persists in `localStorage`, per surface (desk: per user and
  Workspace; widget: per browser, inside the panel iframe). Blocked storage
  keeps the choice for the page's lifetime. A muted desk tab makes no extra
  requests.
- A burst of arrivals sounds once; further arrivals within 3 s are dropped.
- Autoplay policy: the audio context is unlocked by the first click or key
  press on the page (the widget loader also delegates `autoplay` to the panel
  frame, so the launcher click counts). Until then the chime is silently
  skipped and the throttle window does not start, so the next message after
  the first gesture sounds.
- Desk tabs sound in the background too (noticing tickets while away is the
  point). Delivery reuses the `/api/inbox/notifications` customer-message
  feed: ~1 s after a realtime event on inbox pages, otherwise within the
  20 s poll. Several open tabs each sound; there is no cross-tab election.

## Provenance and licence

There is **no audio asset**. The chime is synthesised at play time with the
WebAudio API (two sine oscillators, 880 Hz then 1318.51 Hz, exponential
envelope; see `CHIME` in `src/lib/notify-sound.ts`). It is original code
covered by this repository's AGPLv3 licence; nothing is sampled, downloaded
or ripped, so there is nothing to attribute.

## Where it lives

- `src/lib/notify-sound.ts`: tone spec, mute storage, autoplay unlock,
  throttle (desk). `src/lib/widget-sound-source.ts` is its ES5 twin embedded
  in the widget panel; `src/lib/__tests__/notify-sound.test.ts` runs both
  against the same scenarios.
- `src/lib/notify-sound-feed.ts` + `src/components/layout/inbox-sound-listener.tsx`:
  desk trigger. Widget trigger: `hasNewAgentReply` in `src/app/api/widget/panel/route.ts`.
- E2E: `tests/e2e/notification-sound.spec.ts` (stub `AudioContext` counts chimes).
