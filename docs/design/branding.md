# Product branding — V2 design

Status: design for a later build; no implementation in this change.
Based on `main` at `0048aa8` (2026-10-01), [PRD](../PRD.md#later-and-outside-scope) and
[FR-PROD-02](../FRD.md). Choices labelled **Default** are working defaults
the maintainer can override, not recorded approvals. Open questions are indexed in
[open-questions.md](../open-questions.md#product-branding-v2-design-2026-10-01).

## Goals and boundaries

V1 already supplies Product name and primary colour. V2 adds one optional
Product logo/avatar, a widget launcher corner and a custom Product greeting.
Visitors should recognise the Product they contacted; agents should identify
it consistently across a multi-Product inbox. Existing Products must continue
working without configuration, migration uploads or an embed-snippet change.
Hosted and self-hosted editions have the same branding features.

Non-goals:

- V3 launcher icon customisation, custom online/offline wording and required
  visitor contact fields. The logo does **not** replace the launcher icon.
- Agent avatars, presence and typing indicators: separate later work.
- Arbitrary CSS, HTML, JavaScript, fonts, offsets or per-page branding rules.
- Dashboard white-labelling, app brand changes, email logos/templates, custom
  sending domains, automatic translation or a full widget localisation system.
- Proactive messages, automated replies or changes to availability, visitor
  identity, contact validation, conversation history or billing.

## Relationship to existing designs

| Document | V2 extension and retained contract |
| --- | --- |
| [product-settings.md](product-settings.md) | Add logo under General; position and greeting under Widget. Retain Admin-only access, explicit Save/Discard, dirty-navigation warning and error/conflict handling. Creating a Product and onboarding still require only the V1 fields. |
| [chat-widget.md](chat-widget.md) | Extend the supplied config, panel identity and empty-state greeting; add a left launcher option. Retain Shadow DOM/iframe isolation, the existing bubble/close icon, Product colour, availability copy, contact rules, keyboard handling and mobile full-screen panel. |
| [brand.md](brand.md) | Product identity remains customer data. Dashboard tokens, app logo and centrally configured app name stay separate. The widget gains no app-brand attribution. |
| [product-switcher.md](product-switcher.md), [support-inbox.md](support-inbox.md), [conversation-view.md](conversation-view.md) | Extend existing Product marks/chips without replacing Product names or visitor/agent identity. |
| FR-PROD-02 | V1 fulfils the requirement with name and colour. V2 enriches that identity; the requirement does not imply mandatory logos or expand V1 scope. |

These documents retain their V1 statements as historical scope. This document
owns the V2 additions. A later build should reconcile affected implementation
notes and shipped-feature documentation without claiming unbuilt features.

## Defaults

| Setting | Default and validation |
| --- | --- |
| Logo/avatar | Optional, one shared square mark per Product; no separate widget/inbox variants. No logo initially. |
| Accepted upload | Static PNG, JPEG or WebP; at most 2 MiB (2,097,152 bytes), positive dimensions at most 2,048 px per side and 4,194,304 decoded pixels. Reject SVG, GIF and animated files, including animated WebP/APNG. |
| Stored logo | Decode, orient, strip metadata and re-encode to static WebP, contained within 256 × 256 px without upscaling or cropping. Preserve transparency. At most 100 KiB (102,400 bytes); reject with an actionable error if normalisation cannot meet the budget. Store only the sanitised derivative. |
| Launcher | `bottom-right` initially; `bottom-left` is the other supported value. No top corners or free positioning. |
| Greeting | Nullable plain text. Blank/whitespace resets to the built-in greeting. Maximum 240 Unicode code points after NFC normalisation, newline normalisation to LF and outer trimming; at most 3 lines and 1,024 UTF-8 bytes. Reject controls other than LF. |
| Language | One greeting per Product, in the language the Admin writes. No locale map, interpolation, Markdown, HTML or auto-linking. Built-in UI copy remains English. |
| Publication | Saved branding takes effect on the next widget configuration/session load or dashboard refresh. Already-open widgets need not update live. |

Client checks give quick feedback; the server is authoritative. Validation
messages name the limit, preserve the draft and never silently truncate text.

## Surfaces and interaction

### Product settings

**General:** below name and primary colour, add “Product logo” with current
mark, a labelled file picker, Replace and Remove. Explain that it appears in
the widget header and team inbox and is publicly viewable after saving.
Show accepted formats and limits before selection. Recommend a square image;
wide logos fit inside the square rather than being cropped. No crop editor.

Selection, replacement and removal change the local draft only. Discard
restores the saved mark. On Save, publish name/colour/logo together; an invalid
upload or storage failure must leave all previous General values intact.
Show validation/upload progress and retain a retryable draft on failure.
Do not upload an asset simply to preview it; use a local object URL and revoke
it after replacement, discard or unmount. Prevent duplicate submission.

**Widget:** add a labelled “Launcher position” radio group with Bottom right
and Bottom left, and a “Greeting” textarea with counter, limits and the
built-in text as placeholder/help. Empty means reset, not hide. Save these
two values together, independently of General and existing domain actions.

The existing preview must exercise the same rendering and validation rules
as the real widget, with draft values and a fresh-conversation Live/Away
toggle. Demonstrate the corner inside the preview viewport, never by moving
the dashboard's own UI. Preview sends no visitor messages or sessions.
General previews include both the panel header and an inbox Product chip.
On narrow screens, stack the preview below the form.

Concurrent edits use an expected Product revision (see model sketch). A
conflict retains the draft and offers reload; it must not overwrite another
Admin's changes. Archived Product branding may be edited and previewed;
archiving still disables the public widget.

### Widget launcher and panel

- Launcher stays a 56 px Product-coloured circle with the existing bubble
  icon, close state, unread count and accessible labels. A logo is never a
  custom launcher icon or an unread-message preview.
- Mirror horizontal anchoring for bottom-left: launcher, floating panel,
  preview bubble and opening transform origin move together. Keep 20 px
  edge spacing on desktop, 16 px on mobile, plus the corresponding safe-area
  inset. Do not accept raw CSS positions or offsets from config.
- Desktop panel stays above the selected launcher corner. Mobile keeps its
  full-screen panel, hides the launcher while open and returns focus when
  closed. Position is a physical corner, not automatically reversed for RTL.
- Header adds a 28 px Product mark before the name; the name and availability
  text remain visible. Logos sit contained on a neutral white tile with a
  subtle border; do not tint or distort the image. Reserve dimensions before
  loading. The colour still controls existing accent surfaces.
- **Default greeting placement:** replace the built-in empty-thread prompt
  “Ask us anything, we're here.” in Live mode. In Away mode show the same
  custom greeting above the email/message form; with no custom greeting,
  retain V1's away form without adding an extra prompt. The existing
  online/away status and response instructions remain separately visible.
- Show the greeting only before a Conversation has messages. Hide it once
  the first message succeeds; failed submission keeps it. Resumed or reopened
  history does not gain a greeting message. It is UI text, never persisted as
  a Message, sent by email, counted as unread or billed as a Conversation.
- Preserve line breaks, wrap long words and allow content to scroll without
  covering the composer. Use text rendering (`textContent`/escaped text),
  with `dir="auto"` for the greeting. No links or template variables execute.

### Inbox Product identity and fallback

Extend `src/components/product-identity.tsx` (`ProductMark`/`ProductChip`) so
the same logo appears in existing Product settings list/detail marks,
Product switcher entries, inbox conversation-row chips and the conversation
header/context wherever a Product mark already appears. Keep current mark
sizes (20/28 px) and readable names; add no logo-only replacement for labels.
Historical Conversations show current Product branding, not snapshots.

**Default fallback:** absent, removed, loading or failed logo uses the
existing primary-colour tile and Product initial, with the existing contrasting
letter treatment; an unusable name falls back to `?`. Image failure must not
break layout or retry in a loop. Product colour remains visible elsewhere
even when the logo replaces the initial. Never fall back to the app logo,
a remote avatar service or an agent/visitor photo.

Marks beside a Product name are decorative (`alt=""`, hidden from assistive
technology); any mark-only control keeps its Product-name accessible label.
Check uploaded white/transparent/dark logos and fallback states in dashboard
light/dark themes and the light widget. Keyboard access, focus indicators and
minimum 44 px interaction targets apply to the new controls.

## Data model and API sketch

Names below are illustrative; use existing Product services and server actions
rather than introducing a parallel settings API.

```text
Product (additive)
  launcherPosition  enum(BOTTOM_RIGHT, BOTTOM_LEFT), default BOTTOM_RIGHT
  greeting          nullable text, default null
  brandingRevision  integer, default 0

ProductLogo (zero or one per Product)
  productId         unique FK -> Product, cascade delete
  publicId          unique random identifier, replaced on every replacement
  storageKey        internal generated key, never a client-supplied path
  mimeType          image/webp
  byteSize, width, height
  createdAt
```

Workspace ownership is derived through Product; queries must filter by the
authenticated Workspace, not accept a caller's assertion of ownership.
No logo row means fallback. Migration leaves existing name/colour values
untouched and gives every Product the defaults above.

- Extend General save with optional logo operation `keep | replace | remove`,
  the replacement file and `expectedBrandingRevision`. Widget save accepts
  `launcherPosition`, `greeting`, `expectedBrandingRevision`. Both check Admin
  role and Product ownership, compare/increment the shared revision atomically,
  and return saved state or structured validation/conflict/storage errors.
- Decode and store a replacement before committing its reference. Commit
  metadata and associated form changes in one database transaction. On
  validation/conflict/transaction failure, delete the new unreferenced file;
  on success remove the superseded file. Failures of cleanup are surfaced in
  operational logs with retry information; never report “nothing outstanding”
  while leaving untracked files. See BQ6 for crash-recovery policy.
- Extend existing `/api/widget/config` and the branding payload in
  `/api/widget/session` consistently with `logoUrl: string | null`,
  `launcherPosition: "bottom-right" | "bottom-left"`, `greeting: string | null`.
  Retain existing `name`, `color`, `availability`, key/origin/archive checks
  and no-store configuration responses. Do not expose storage keys or admin
  metadata. Missing optional fields in an older response use V1 defaults.
- A shared public-branding projection should feed loader, panel/session and
  authenticated preview, avoiding divergent copies. Branding text must be
  safely serialised if embedded in script/HTML; `</script>` is a test fixture.
- Proposed `GET /api/product-logos/{publicId}` serves only a currently
  referenced sanitised logo. It accepts no filesystem path, external URL or
  arbitrary attachment ID. Unknown/replaced/removed IDs return 404. Dashboard
  reads stay Workspace-scoped; the published image alone is intentionally public.

## Storage, publication and security

**Default:** use the existing local file-store abstraction in
`src/lib/attachment-storage.ts` with distinct logo metadata/access rules.
It currently supplies a local adapter; S3-compatible hosting is a future
option, not an already implemented capability. Reuse its interface where
appropriate without making private conversation attachments publicly readable.
Self-hosted logos live on the installation's persistent storage volume and
need no hosted service, third-party image host or hosted credentials. Include
logos in backup/restore and Product/Workspace deletion procedures.

Serve public logo bytes through the application initially, in both modes.
Use `Content-Type: image/webp`, `X-Content-Type-Options: nosniff` and a default
`Cache-Control: public, max-age=300, must-revalidate`, without stale serving.
A replacement gets a new URL. Removed/replaced URLs stop working at the
origin immediately; a previously fetched copy may remain cached for five
minutes, and downloaded public images cannot be recalled. Archived Product
logos remain available for inbox identity; archive is not logo deletion.

A public CDN can later cache only these sanitised images with the same TTL
and invalidation rules. No CDN/provider decision is made here. Signed read
URLs are not the default: these images are public branding, and expiring
links would introduce broken logos in long-open widgets. If the maintainer requires
private logos, redesign delivery and renewal explicitly; a random URL or
the widget domain allowlist is not a confidentiality boundary for an image.

Upload controls required in the build:

- Authenticate and authorise before decoding; apply the existing mutation
  CSRF/origin protections and server-side Workspace isolation to every write.
- Limit raw file bytes while reading (not only after buffering). Bound the
  multipart request too (**Default:** 3 MiB). Check signature, declared type
  and successful decode; never trust extensions or browser MIME alone.
- Enforce pixel/dimension limits before expensive allocation where the
  decoder permits; bound processing time/memory and reject animation,
  malformed images, unsupported types and decoder failures. Re-encoding is
  required; never publish original bytes or embedded metadata.
- **Default:** 10 logo-changing save attempts per Admin per 10 minutes and
  30 per Workspace per 10 minutes; oversized requests also count. Return a
  retryable rate-limit response. Greeting/corner-only edits do not consume
  this upload budget.
- Accept files, not fetched URLs (avoids SSRF and visitor tracking pixels).
  Use generated keys; prevent path traversal and cross-Product asset reuse.
  Render greetings as plain text and positions as enums. No arbitrary CSS.
- The later build must choose and review a maintained image decoder; do not
  hand-write image parsing or silently rely on filename checks. Adding a
  dependency needs the repository's normal checkpoint (BQ5).

## Acceptance criteria

Stable IDs for implementation and tests:

| ID | Observable result |
| --- | --- |
| BR-01 | Migration and new Product creation produce no logo, bottom-right and null greeting; existing name/colour, widget availability and conversation flows still work with the existing snippet. |
| BR-02 | Admin can save, replace and remove a logo; Save publishes atomically, Discard publishes nothing, failures retain draft and saved values. Agent writes and cross-Workspace Product writes fail server-side without leaking another Product. |
| BR-03 | Valid static PNG/JPEG/WebP becomes a metadata-free WebP within the stored budget. Exact upload/dimension limits pass when otherwise valid; limit + 1, spoofed MIME, SVG, animated/malformed files and excess pixels fail without changing saved data. |
| BR-04 | General and Widget preview match published rendering, including removal and both corners, and create no visitor session, Message or Conversation. |
| BR-05 | The same logo appears beside Product names in settings, switcher, inbox rows and conversation identity. Visitor/agent avatars and app chrome remain distinct; old Conversations show current branding. |
| BR-06 | Missing, removed, loading and broken logos show the initial/colour fallback at reserved dimensions; names remain readable and accessible. A broken image cannot prevent chat use. |
| BR-07 | Both supported corners position launcher, panel and preview bubble consistently at desktop/mobile widths and safe areas. Unsupported enum values fail validation; mobile full-screen, focus return, unread badge and fixed launcher icon still work. |
| BR-08 | Custom greeting appears only before messages in Live/Away as specified; null preserves V1 defaults. A first-send failure retains it, success hides it, and resume/reopen never inserts greeting history. No email, unread count or usage event results from displaying it. |
| BR-09 | Greeting boundary tests cover 240/241 code points, 3/4 lines, UTF-8 budget, whitespace reset, Unicode/RTL and controls. HTML/script-looking input renders literally in preview and real widget with no execution or links. |
| BR-10 | Concurrent saves with the same revision allow one commit and return a visible conflict for the other. Losing uploads are cleaned up; no partial General/Widget save or silent overwrite occurs. |
| BR-11 | Config and session agree on branding; disallowed origins and archived Products retain existing widget denial. Already-open widgets may keep old branding; a fresh load receives the saved values without snippet changes. |
| BR-12 | Public logo routes expose only sanitised current logo bytes with correct headers. Private attachments remain protected; guessed paths, foreign logo references and external URL uploads fail. Removal/replacement/deletion obey origin and five-minute cache semantics. |
| BR-13 | Rate, body and processing limits reject abusive uploads. Simulated database/storage failures preserve the previous usable brand and expose actionable errors; deletion and cleanup failures are observable and retryable. |
| BR-14 | Hosted and self-hosted flows pass with equivalent features. Self-hosted save/load/backup/restore needs only the installation; no external image-service request occurs. |

Later build verification: run formatting checks where available, lint,
typecheck, unit/integration tests and build via the repository verification
interface. Add integration tests for authorisation, concurrent writes, asset
lifecycle and upload validation; browser tests in both hosting modes for
save/discard, preview, greetings, both corners and resume. Inspect realistic
logos in dashboard light/dark and widget mobile/desktop, including failed
image loads, keyboard use and long text. Report loader/panel gzip sizes
against `chat-widget.md` budgets (5/50 KB); image requests have their own
100 KiB budget. The widget must not import the image decoder or dashboard.

## Open questions

No immediate answer is needed to finish this design. BQ1–BQ4 have documented
defaults for the build unless the maintainer overrides them; BQ5–BQ6 require a concrete
implementation proposal before choosing new dependencies or infrastructure.

| ID | The maintainer's decision / alternatives | Working default or unresolved boundary |
| --- | --- | --- |
| BQ1 | Are raster-only logos, a 2 MiB input / 100 KiB output budget and a contained square mark sufficient? SVG or larger artwork widens processing/security scope. | **Default:** the formats, dimensions and budgets above; initial/colour fallback everywhere, including the widget header. |
| BQ2 | Keep app-served public logos, or select hosted object storage/CDN or private signed delivery? | **Default:** existing local persistent storage and public app route in both editions. Provider, bucket and CDN are unselected; private delivery needs a revised design. |
| BQ3 | Are the two bottom corners sufficient? Top corners/free offsets add layout cases. | **Default:** bottom-right and bottom-left only, physical positions. |
| BQ4 | Is one 240-code-point, three-line greeting shared by fresh Live/Away views sufficient? Is translated per-locale content required? | **Default:** single plain-text value, no translation; V1 default when empty. Custom status/online/offline wording remains V3 regardless. |
| BQ5 | Which maintained server image decoder and deployment support should the build adopt? | **Unresolved:** inspect available tooling and propose the smallest supported option with dependency/runtime costs. Do not weaken sanitisation to avoid the decision. |
| BQ6 | How should interrupted file/DB operations and failed deletes be reconciled operationally? | **Default:** immediate compensating cleanup and observable failures. **Unresolved:** approve a concrete recovery procedure using existing operations, or explicitly approve a new job. A crash can leave an unreferenced file; deletion/backup documentation and retry ownership must be settled before shipping. |
