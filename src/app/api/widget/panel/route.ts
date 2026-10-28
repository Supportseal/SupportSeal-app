import { NextResponse, type NextRequest } from "next/server";

import { WIDGET_RETRY_JS } from "@/lib/widget-retry-source";
import { WIDGET_SOUND_JS } from "@/lib/widget-sound-source";
import { loadWidgetProduct, serviceOriginFrom } from "@/lib/widget";

export const dynamic = "force-dynamic";

/**
 * The widget panel, served as a dependency-free HTML document from the
 * SupportSeal origin and embedded in an iframe by the loader. Loads no fonts
 * and no dashboard bundle (docs/design/chat-widget.md).
 */
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key") ?? "";
  const host = request.nextUrl.searchParams.get("host") ?? "";
  const product = await loadWidgetProduct(key);
  const frameAncestors = buildFrameAncestors(product, serviceOriginFrom(request.headers, request.nextUrl.origin));

  const html = PANEL_HTML.replace("__KEY__", escapeAttr(key)).replace("__HOST__", escapeAttr(host));
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `${PANEL_CSP}; frame-ancestors ${frameAncestors}`,
    },
  });
}

/**
 * Panel CSP (issue #71): strict everywhere except the Cloudflare RUM
 * beacon. Cloudflare zones with Web Analytics inject
 * <script src="https://static.cloudflareinsights.com/beacon.min.js"> into
 * every HTML response — this panel included — and the beacon reports to
 * https://cloudflareinsights.com/cdn-cgi/rum. Blocking it there silently
 * drops the host's analytics for the widget context (observed on a host
 * with Web Analytics enabled). The allow is exactly those two Cloudflare-operated
 * origins and nothing wider: no wildcards, no scheme-less hosts, no
 * loosening of default-src/style-src. Origin granularity (not a pinned
 * path) because Cloudflare serves the beacon under versioned paths
 * (beacon.min.js/vNNN…); decision recorded in docs/open-questions.md.
 */
const PANEL_CSP =
  "default-src 'self'; " +
  "script-src 'unsafe-inline' https://static.cloudflareinsights.com; " +
  "style-src 'unsafe-inline'; " +
  "connect-src 'self' https://cloudflareinsights.com";

/**
 * Only allowlisted sites (plus the service itself, for the in-app preview)
 * may frame the panel. Wildcard domains map to CSP host wildcards.
 */
function buildFrameAncestors(
  product: { domains: string[] } | null,
  serviceOrigin: string,
): string {
  const ancestors = new Set<string>(["'self'", serviceOrigin]);
  const addHttpAndHttps = (host: string) => {
    ancestors.add(`https://${host}`);
    ancestors.add(`http://${host}`);
  };
  // Explicit localhost development path (FR-CHAT-01): port wildcards, http only.
  const addLocalDev = () => {
    ancestors.add("http://localhost:*");
    ancestors.add("http://127.0.0.1:*");
  };
  if (process.env.NODE_ENV !== "production") addLocalDev();
  for (const pattern of product?.domains ?? []) {
    const rule = pattern.trim().toLowerCase();
    if (rule.startsWith("*.")) addHttpAndHttps(`*.${rule.slice(2)}`);
    else if (rule === "localhost" || rule === "127.0.0.1") addLocalDev();
    else addHttpAndHttps(rule);
  }
  return [...ancestors].join(" ");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Chat</title>
<style>
  /* Token values from src/styles/tokens.css (docs/design/chat-widget.md),
     inlined in px; --accent is always the Product colour. */
  :root {
    color-scheme: light;
    --bg: #fff; --bg-2: #f5f8f7; --bubble: #eff4f2; --hover: #eaf1ee;
    --heading: #15261f; --body: #43544d; --muted: #5f6f69;
    --line: #dce5e1; --control: #7a8b85; --danger: #c42b2b; --danger-bg: #fdeaea;
    --accent: #2563eb; --on-accent: #fff; --on-accent-soft: rgba(255,255,255,.2);
    --ring: var(--ring-light, #2563eb); --ring-soft: var(--ring-soft-light, rgba(37,99,235,.2));
    font-synthesis: none;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #16211d; --bg-2: #111a17; --bubble: #23312c; --hover: #23312c;
      --heading: #e8f0ec; --body: #bdcbc5; --muted: #8fa19a;
      --line: #2a3833; --control: #6b7d77; --danger: #ff8a80; --danger-bg: rgba(255,138,128,.14);
      --ring: var(--ring-dark, #2563eb); --ring-soft: var(--ring-soft-dark, rgba(37,99,235,.3));
    }
  }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--body); background: var(--bg); display: flex; flex-direction: column; -webkit-font-smoothing: antialiased; }
  input, textarea, button { font: inherit; color: inherit; }
  button { cursor: pointer; }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  svg { display: block; }
  header { display: flex; align-items: center; gap: 12px; padding: calc(14px + env(safe-area-inset-top)) 12px 14px 16px; background: var(--accent); color: var(--on-accent); }
  header :focus-visible { outline-color: var(--on-accent); }
  .avatar { flex: none; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; font-size: 16px; font-weight: 650; background: var(--on-accent-soft); }
  .hgroup { flex: 1; min-width: 0; }
  header h1 { font-size: 16px; font-weight: 650; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status { display: flex; align-items: center; gap: 6px; font-size: 12.5px; opacity: .92; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #3ddc97; box-shadow: 0 0 0 2px var(--on-accent-soft); }
  .dot.away { background: #c5d0cc; }
  .pill { font-size: 11px; font-weight: 600; padding: 0 8px; border-radius: 999px; background: var(--on-accent-soft); }
  .iconbtn { flex: none; width: 34px; height: 34px; border: 0; border-radius: 10px; background: none; display: grid; place-items: center; transition: background-color .15s; }
  .iconbtn:hover { background: var(--on-accent-soft); }
  .banner { display: none; align-items: center; gap: 8px; padding: 8px 16px; font-size: 12.5px; background: var(--danger-bg); color: var(--danger); }
  .retry { margin-left: auto; padding: 2px 10px; border: 1px solid currentColor; border-radius: 999px; background: none; color: inherit; font-size: 12px; font-weight: 600; }
  #thread { flex: 1; overflow-y: auto; padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 2px; overscroll-behavior: contain; }
  .welcome { margin: auto; text-align: center; color: var(--muted); font-size: 13.5px; padding: 24px 12px; }
  .welcome .avatar { margin: 0 auto 10px; width: 48px; height: 48px; font-size: 20px; background: var(--accent); color: var(--on-accent); }
  .day { align-self: stretch; display: flex; align-items: center; gap: 10px; margin: 12px 0 4px; font-size: 11.5px; font-weight: 500; color: var(--muted); }
  .day::before, .day::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .ticket { align-self: center; margin: 0 0 2px; font-size: 11.5px; font-weight: 500; color: var(--muted); font-variant-numeric: tabular-nums; }
  .who { margin: 10px 0 4px 4px; font-size: 12px; font-weight: 500; color: var(--muted); }
  .msg { max-width: 82%; padding: 8px 13px; border-radius: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.customer { align-self: flex-end; background: var(--accent); color: var(--on-accent); }
  .msg.agent { align-self: flex-start; background: var(--bubble); color: var(--heading); }
  .msg.customer.first { margin-top: 10px; }
  .msg.customer:not(.last) { border-bottom-right-radius: 6px; }
  .msg.customer:not(.first) { border-top-right-radius: 6px; }
  .msg.agent:not(.last) { border-bottom-left-radius: 6px; }
  .msg.agent:not(.first) { border-top-left-radius: 6px; }
  .time { margin: 3px 6px 2px; font-size: 11px; color: var(--muted); }
  .time.customer { align-self: flex-end; }
  .files { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 6px; }
  .file { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 7px 10px; border-radius: 10px; background: rgba(0,0,0,.06); color: inherit; font-size: 12.5px; text-decoration: none; }
  .customer .file { background: var(--on-accent-soft); }
  .file:hover span { text-decoration: underline; }
  .file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file small { flex: none; opacity: .75; }
  .thumb img { display: block; max-width: 220px; max-height: 180px; border-radius: 10px; }
  .sysline { align-self: center; max-width: 88%; margin: 10px 0 4px; font-size: 12.5px; color: var(--muted); text-align: center; }
  .card { align-self: stretch; margin: 14px 0 4px; padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--bg-2); }
  .card p { margin-bottom: 10px; font-size: 13.5px; font-weight: 600; color: var(--heading); }
  .row { display: flex; gap: 8px; }
  .field { flex: 1; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid var(--control); border-radius: 10px; background: var(--bg); color: var(--heading); font-size: 14px; transition: border-color .15s, box-shadow .15s; }
  textarea.field { height: auto; padding: 10px 12px; }
  .field:focus { outline: none; border-color: var(--ring); box-shadow: 0 0 0 3px var(--ring-soft); }
  .field[aria-invalid="true"] { border-color: var(--danger); }
  ::placeholder { color: var(--muted); opacity: 1; }
  .btn { height: 40px; padding: 0 16px; border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent); font-weight: 600; transition: box-shadow .15s; }
  .btn:hover { box-shadow: inset 0 0 0 99px rgba(0,0,0,.08); }
  .btn:active { box-shadow: inset 0 0 0 99px rgba(0,0,0,.16); }
  .btn:disabled { opacity: .55; cursor: default; box-shadow: none; }
  .linkbtn { margin-top: 8px; padding: 2px; border: 0; border-radius: 4px; background: none; color: var(--muted); font-size: 12.5px; }
  .linkbtn:hover { color: var(--heading); text-decoration: underline; }
  .hint { min-height: 16px; font-size: 12.5px; color: var(--danger); }
  .card .hint { margin-top: 6px; min-height: 0; }
  /* Informational, not an error: the support-address line shares the hint
     layout but uses the muted token (widget mirror of --vx-muted). */
  #awaySupport { color: var(--muted); }
  #away { flex: 1; overflow-y: auto; padding: 20px 16px; flex-direction: column; gap: 14px; }
  #away label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: var(--heading); }
  #away .field { width: 100%; }
  #away textarea { resize: none; }
  #awaySend { height: 44px; }
  #composer { flex-direction: column; padding: 10px 12px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); }
  #chips { flex-wrap: wrap; gap: 6px; padding: 0 2px 8px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 30px; padding: 0 4px 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-2); color: var(--heading); font-size: 12.5px; }
  .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip button { flex: none; width: 22px; height: 22px; border: 0; border-radius: 6px; background: none; color: var(--muted); font-size: 16px; line-height: 1; }
  .chip button:hover { background: var(--hover); color: var(--heading); }
  .inputrow { display: flex; align-items: flex-end; gap: 4px; padding: 4px; border: 1px solid var(--control); border-radius: 22px; transition: border-color .15s, box-shadow .15s; }
  .inputrow:focus-within { border-color: var(--ring); box-shadow: 0 0 0 3px var(--ring-soft); }
  #input { flex: 1; min-height: 36px; max-height: 132px; padding: 7px 4px; border: 0; outline: none; resize: none; background: none; color: var(--heading); font-size: 16px; line-height: 22px; }
  #attach, #send { flex: none; width: 36px; height: 36px; border: 0; border-radius: 50%; display: grid; place-items: center; transition: background-color .15s, color .15s, transform .1s; }
  #attach { background: none; color: var(--muted); }
  #attach:hover { background: var(--hover); color: var(--heading); }
  #send { background: var(--accent); color: var(--on-accent); }
  #send:disabled { background: var(--hover); color: var(--muted); cursor: default; }
  #send:not(:disabled):active { transform: scale(.92); }
  .diagnotice { padding: 8px 16px; border-top: 1px solid var(--line); background: var(--bg-2); color: var(--muted); font-size: 11.5px; }
  .diagnotice button, .diaglist button { padding: 0; border: 0; background: none; color: inherit; font-size: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
  .diaglist { display: none; padding: 0 16px 8px; background: var(--bg-2); color: var(--muted); font-size: 11.5px; }
  .diaglist.open { display: block; }
  .diaglist p + p { margin-top: 4px; }
  #away .diagnotice, #away .diaglist { padding: 0; border: 0; background: none; }
  #composer + .sysline, #emailHint { margin: 0; padding: 0 16px 8px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <header id="header">
    <div class="avatar" id="avatar" aria-hidden="true"></div>
    <div class="hgroup">
      <h1 id="title" tabindex="-1">Chat</h1>
      <div class="status"><span class="dot" id="dot"></span><span id="statusline"></span><span class="pill" id="testmode" style="display:none">Test mode</span></div>
    </div>
    <button class="iconbtn" id="soundBtn" type="button" aria-label="Mute message sound"></button>
    <button class="iconbtn" id="closeBtn" type="button" aria-label="Close chat"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
  </header>
  <div class="banner" id="banner" role="status">We can't reach support right now. <button class="retry" id="retryBtn" type="button">Retry</button></div>
  <div id="thread" role="log" aria-live="polite"></div>
  <form id="away" style="display:none" novalidate>
    <div>
      <label for="email">Email</label>
      <input class="field" id="email" type="email" name="email" autocomplete="email" required aria-describedby="awayHint">
    </div>
    <div>
      <label for="message">Message</label>
      <textarea class="field" id="message" rows="5" required aria-describedby="awayHint awaySupport"></textarea>
    </div>
    <div class="hint" id="awayHint" aria-live="polite"></div>
    <div class="hint" id="awaySupport"></div>
    <button class="btn" id="awaySend" type="submit">Send message</button>
  </form>
  <div id="composer" style="display:none">
    <div id="chips" style="display:none"></div>
    <div class="inputrow">
      <input type="file" id="fileInput" multiple hidden>
      <button id="attach" type="button" aria-label="Attach a file"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
      <textarea id="input" rows="1" placeholder="Write a message…" aria-label="Write a message"></textarea>
      <button id="send" type="button" aria-label="Send message" disabled><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
    </div>
  </div>
<script>
${WIDGET_RETRY_JS}
${WIDGET_SOUND_JS}
(function () {
  var params = new URLSearchParams(window.location.search);
  var key = params.get('key') || '';
  var testToken = params.get('testToken') || '';
  var hostOrigin = params.get('host') || '';
  var previewMode = params.get('preview') === '1';
  var hostPath = '/';
  var accent = '#2563eb';
  var inkOnAccent = '#fff';
  var config = null;
  var state = { messages: [], email: null, conversationId: null, ticketRef: null };
  // Attachment tiles are built with DOM APIs + textContent so untrusted
  // filenames can never enter an HTML context (defence-in-depth on top of
  // the server-side filename allowlist).
  function attachmentNodes(list) {
    var nodes = [];
    if (!list) return nodes;
    list.forEach(function (a) {
      var url = '/api/attachments/' + a.id + '?key=' + encodeURIComponent(key);
      var link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      if (a.contentType && a.contentType.indexOf('image/') === 0) {
        link.className = 'thumb';
        var img = document.createElement('img');
        img.src = url;
        img.alt = a.filename;
        link.appendChild(img);
      } else {
        link.className = 'file';
        link.innerHTML = FILE_ICON + '<span></span><small></small>';
        link.querySelector('span').textContent = a.filename;
        link.querySelector('small').textContent = formatSize(a.size);
      }
      nodes.push(link);
    });
    return nodes;
  }
  var FILE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  var lastCount = 0;
  var hidden = true;

  // Shared retry policy (issue #57): capped exponential backoff with jitter,
  // paused while the page is hidden, so one failing panel cannot saturate
  // the per-IP widget budgets for everyone behind that IP.
  var retryApi = window.__ssWidgetRetry;

  // Reply chime (issue #125). Synthesised with WebAudio (no audio asset);
  // sounds only for AGENT messages not already in the thread, so the
  // visitor's own sends and the loaded history stay silent. The mute choice
  // persists in this iframe's localStorage; blocked storage keeps it for
  // the page's lifetime. A browser that blocks autoplay stays silent until
  // the first gesture inside the panel (or the launcher click, via the
  // autoplay permission the loader delegates to this frame).
  var soundStorage = null;
  try { soundStorage = window.localStorage; } catch (e) { /* storage blocked */ }
  var chime = window.__ssWidgetSound.create({ storage: soundStorage, muteKey: 'ss_sound_muted' });
  var soundBtn = document.getElementById('soundBtn');
  var SOUND_ON_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
  var SOUND_OFF_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';
  function renderSoundButton() {
    var muted = chime.isMuted();
    soundBtn.innerHTML = muted ? SOUND_OFF_ICON : SOUND_ON_ICON;
    soundBtn.setAttribute('aria-label', muted ? 'Unmute message sound' : 'Mute message sound');
  }
  renderSoundButton();
  soundBtn.addEventListener('click', function () {
    chime.setMuted(!chime.isMuted());
    renderSoundButton();
    if (!chime.isMuted()) chime.preview();
  });
  function unlockSound() {
    chime.unlock().then(function (ok) {
      if (!ok) return;
      document.removeEventListener('pointerdown', unlockSound, true);
      document.removeEventListener('keydown', unlockSound, true);
    });
  }
  document.addEventListener('pointerdown', unlockSound, true);
  document.addEventListener('keydown', unlockSound, true);
  // Messages the thread has not seen that were written by the team.
  function hasNewAgentReply(known, incoming) {
    var seen = {};
    known.forEach(function (m) { seen[m.id] = true; });
    return incoming.some(function (m) { return m.kind === 'AGENT' && !seen[m.id]; });
  }
  var bannerEl = document.getElementById('banner');
  function showBanner() { bannerEl.style.display = 'flex'; }
  function hideBanner() { bannerEl.style.display = 'none'; }

  var thread = document.getElementById('thread');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var awayForm = document.getElementById('away');
  var attachBtn = document.getElementById('attach');
  var fileInput = document.getElementById('fileInput');
  var chipsEl = document.getElementById('chips');
  var pendingAttachments = [];
  // Uploads still in flight: a send now would leave their files behind.
  var uploading = [];
  var sending = false;
  // Send is enabled only when there is something to send (design doc).
  function updateSendState() {
    sendBtn.disabled = sending || uploading.length > 0 || (!input.value.trim() && pendingAttachments.length === 0);
  }

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.innerHTML = '';
    chipsEl.style.display = pendingAttachments.length || uploading.length ? 'flex' : 'none';
    uploading.forEach(function (u) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = u.name + ' (uploading\\u2026)';
      chipsEl.appendChild(chip);
    });
    pendingAttachments.forEach(function (a, index) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = '<span></span><button type="button">\u00d7</button>';
      chip.firstChild.textContent = a.filename + ' (' + formatSize(a.size) + ')';
      var remove = chip.querySelector('button');
      remove.setAttribute('aria-label', 'Remove ' + a.filename);
      remove.addEventListener('click', function () {
        pendingAttachments.splice(index, 1);
        renderChips();
        input.focus();
      });
      chipsEl.appendChild(chip);
    });
    updateSendState();
  }
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(fileInput.files);
      fileInput.value = '';
      // Until reset() revokes the old credential an upload would still be the previous visitor's.
      if (resetPending && !previewMode) return;
      files.forEach(function (file) {
        var body = new FormData();
        body.append('file', file);
        var uploadGeneration = sessionGeneration;
        var upload = { name: file.name };
        uploading.push(upload);
        renderChips();
        function settled() {
          var at = uploading.indexOf(upload);
          if (at === -1) return;
          uploading.splice(at, 1);
          renderChips();
        }
        apiFetch('/api/widget/attachments', { method: 'POST', body: body })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            settled();
            // An upload from a session retired by reset() must not resurface.
            if (uploadGeneration !== sessionGeneration) return;
            if (data.attachment) { pendingAttachments.push(data.attachment); renderChips(); }
            else {
              var hint = document.createElement('p');
              hint.className = 'sysline';
              hint.textContent = data.error || 'Upload failed.';
              thread.appendChild(hint);
              setTimeout(function () { hint.remove(); }, 3000);
            }
          })
          .catch(settled);
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function autoContrast(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    var c = m[1];
    function lin(x) { return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
    var l = 0.2126 * lin(parseInt(c.slice(0, 2), 16) / 255) + 0.7152 * lin(parseInt(c.slice(2, 4), 16) / 255) + 0.0722 * lin(parseInt(c.slice(4, 6), 16) / 255);
    return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000' : '#fff';
  }
  function apiUrl(path) {
    return path + '?key=' + encodeURIComponent(key) + '&host=' + encodeURIComponent(hostOrigin) + (testToken ? '&testToken=' + encodeURIComponent(testToken) : '');
  }

  // Visitor token fallback: third-party cookie blockers (Safari ITP) drop
  // the widget cookie inside the embedded panel. Keep the session token in
  // this iframe's (partitioned) sessionStorage and present it via header on
  // fetches and via t= on the EventSource stream. Cookie stays primary.
  var tokenKey = 'ss_token_' + key;
  function storedToken() {
    try { return sessionStorage.getItem(tokenKey) || ''; } catch (e) { return ''; }
  }
  function saveToken(value) {
    try { sessionStorage.setItem(tokenKey, value); } catch (e) { /* storage blocked: cookie path only */ }
  }
  function removeToken() {
    try { sessionStorage.removeItem(tokenKey); } catch (e) { /* nothing stored */ }
  }
  // Host sign-out reset intent (issue #151). The sign-out flow commonly
  // navigates away before the revocation DELETE is sent or completes; keep
  // the intent in the same partitioned sessionStorage so the next boot in
  // this tab still revokes the session. Cleared only after the DELETE succeeds.
  var resetKey = 'ss_reset_' + key;
  function resetFlagged() {
    try { return sessionStorage.getItem(resetKey) === '1'; } catch (e) { return false; }
  }
  function flagReset() {
    try { sessionStorage.setItem(resetKey, '1'); } catch (e) { /* storage blocked: in-memory intent only */ }
  }
  function clearResetFlag() {
    try { sessionStorage.removeItem(resetKey); } catch (e) { /* nothing stored */ }
  }
  // The stored token is only a bridge for browsers that drop the widget
  // cookie (Safari ITP). When the cookie transport is proven to work the
  // stored token is deleted: left in place it would outlive a cookie clear
  // and resurrect the cleared session on the next reload (issue #61). Only
  // a success proves the cookie reached the server — a 401 means no cookie
  // arrived, and a network error or 5xx proves nothing (in the Safari case
  // the token is the only working credential, so it must survive those).
  // The probe sends no x-ss-visitor-token so it observes the cookie path
  // alone, and retries on the next boot while a token is still stored.
  function probeCookieTransport() {
    if (!storedToken()) return;
    fetch(apiUrl('/api/widget/messages'), { credentials: 'include' })
      .then(function (r) { if (r.ok) removeToken(); })
      .catch(function () { /* transport unknown: keep the token */ });
  }
  function apiFetch(path, options) {
    options = options || {};
    options.credentials = 'include';
    options.headers = Object.assign({}, options.headers || {});
    var token = storedToken();
    if (token) options.headers['x-ss-visitor-token'] = token;
    return fetch(apiUrl(path), options);
  }
  function pageUrl() {
    try { return new URL(hostOrigin).origin + hostPath; } catch (e) { return hostOrigin + hostPath; }
  }

  // Diagnostics transport (docs/design/diagnostics.md): when the visitor
  // sends a message, ask the loader for a snapshot and wait at most 250 ms.
  // No reply or an empty buffer sends the message without diagnostics —
  // diagnostics never block a message beyond that wait.
  function requestDiagnostics() {
    if (!config || !config.diagnostics) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var settled = false;
      function onMessage(event) {
        if (event.source !== window.parent) return;
        var data = event.data || {};
        if (data.type !== 'ss:diag-snapshot') return;
        finish(data.snapshot || null);
      }
      function finish(value) {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(value);
      }
      var timer = setTimeout(function () { finish(null); }, 250);
      window.addEventListener('message', onMessage);
      parent.postMessage({ type: 'ss:diag-request' }, '*');
    });
  }

  // When the message itself fails to send, hand the snapshot's events back
  // so the visitor's retry carries them (never on server-side rejections —
  // the message was stored there).
  function restoreDiagnostics() {
    if (config && config.diagnostics) parent.postMessage({ type: 'ss:diag-restore' }, '*');
  }

  // One muted disclosure line above the composer and on the away form while
  // the Product has diagnostics enabled. Placeholder copy pending legal.
  function renderDiagNotice() {
    if (document.getElementById('diagNotice')) return;
    var notice = document.createElement('div');
    notice.className = 'diagnotice';
    notice.id = 'diagNotice';
    var text = document.createElement('span');
    text.textContent = 'Technical details from this page are shared with ' + (config ? config.name : 'this') + ' support. ';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = "What's collected";
    notice.appendChild(text);
    notice.appendChild(toggle);
    var list = document.createElement('div');
    list.className = 'diaglist';
    list.id = 'diagList';
    var collected = document.createElement('p');
    collected.textContent = 'Collected when you send a message: JavaScript errors, warnings and failed network requests, this page\\u2019s address, and your browser and screen size.';
    var never = document.createElement('p');
    never.textContent = 'Never collected: passwords, payment details, cookies, form contents, anything you type, or anything from other sites.';
    list.appendChild(collected);
    list.appendChild(never);
    toggle.addEventListener('click', function () {
      var openNow = list.classList.toggle('open');
      toggle.setAttribute('aria-expanded', openNow ? 'true' : 'false');
      toggle.textContent = openNow ? 'Hide details' : "What's collected";
    });
    var composer = document.getElementById('composer');
    if (composer && composer.parentNode) composer.parentNode.insertBefore(notice, composer);
    if (composer && composer.parentNode) composer.parentNode.insertBefore(list, composer);
    var away = document.getElementById('away');
    if (away) {
      var awayNotice = notice.cloneNode(true);
      awayNotice.id = 'awayDiagNotice';
      var awayToggle = awayNotice.querySelector('button');
      var awayList = list.cloneNode(true);
      awayList.id = 'awayDiagList';
      if (awayToggle) awayToggle.addEventListener('click', function () {
        var openNow = awayList.classList.toggle('open');
        if (awayToggle) {
          awayToggle.setAttribute('aria-expanded', openNow ? 'true' : 'false');
          awayToggle.textContent = openNow ? 'Hide details' : "What's collected";
        }
      });
      away.insertBefore(awayList, away.firstChild);
      away.insertBefore(awayNotice, away.firstChild);
    }
  }

  // Relative luminance and WCAG contrast for the Product colour.
  function luminance(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 0;
    function lin(x) { x = parseInt(x, 16) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
    return 0.2126 * lin(m[1].slice(0, 2)) + 0.7152 * lin(m[1].slice(2, 4)) + 0.0722 * lin(m[1].slice(4, 6));
  }
  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function rgba(hex, alpha) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '') || [0, '2563eb'];
    return 'rgba(' + parseInt(m[1].slice(0, 2), 16) + ',' + parseInt(m[1].slice(2, 4), 16) + ',' + parseInt(m[1].slice(4, 6), 16) + ',' + alpha + ')';
  }
  // Focus ring: the Product colour where it reaches 3:1 against the panel
  // surface, otherwise the heading colour (design doc, Accessibility).
  function ringFor(surface, heading) {
    return contrast(accent, surface) >= 3 ? accent : heading;
  }

  function applyConfig(data) {
    config = data;
    accent = /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color : accent;
    inkOnAccent = autoContrast(accent);
    var root = document.documentElement.style;
    var ringLight = ringFor('#ffffff', '#15261f');
    var ringDark = ringFor('#16211d', '#e8f0ec');
    root.setProperty('--accent', accent);
    root.setProperty('--on-accent', inkOnAccent);
    root.setProperty('--on-accent-soft', inkOnAccent === '#000' ? 'rgba(0,0,0,.1)' : 'rgba(255,255,255,.2)');
    root.setProperty('--ring-light', ringLight);
    root.setProperty('--ring-soft-light', rgba(ringLight, 0.2));
    root.setProperty('--ring-dark', ringDark);
    root.setProperty('--ring-soft-dark', rgba(ringDark, 0.3));
    document.getElementById('title').textContent = data.name;
    document.getElementById('avatar').textContent = initial();
    var away = data.availability === 'AWAY';
    // Optional per-Product support address (display only; textContent keeps it inert).
    if (data.supportEmail) document.getElementById('awaySupport').textContent = 'Prefer email? Write to ' + data.supportEmail + '.';
    renderStatus();
    try {
      var h = new URL(hostOrigin).hostname;
      if (h === 'localhost' || h === '127.0.0.1') document.getElementById('testmode').style.display = 'inline-block';
    } catch (e) {}
    if (data.diagnostics) renderDiagNotice();
  }

  // Header dot and status line. Paused = the team's Free plan cutoff
  // (src/lib/service-pause.ts): chat takes no new messages.
  function renderStatus() {
    var paused = !!(config && config.paused);
    var away = config && config.availability === 'AWAY';
    document.getElementById('dot').className = 'dot' + (away || paused ? ' away' : '');
    document.getElementById('statusline').textContent = paused
      ? 'Chat unavailable right now'
      : away
        ? 'Away · Send us a message, we\\u2019ll reply by email'
        : 'Online · Chat with us';
  }

  // A send refused with service_paused: switch to the notice without a reload.
  function markPaused() {
    if (!config) return;
    config.paused = true;
    renderStatus();
    render();
  }

  function renderPausedNotice() {
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'pausedNotice';
    card.setAttribute('role', 'status');
    var title = document.createElement('p');
    title.textContent = 'Chat is unavailable right now';
    title.style.fontWeight = '600';
    var text = document.createElement('p');
    text.className = 'sysline';
    text.style.textAlign = 'left';
    text.textContent = (config.name || 'This team') + ' isn\\u2019t taking chat messages at the moment. ' +
      (config.supportEmail ? 'You can still reach them by email at ' + config.supportEmail + '.' : 'Please try again later.');
    card.appendChild(title);
    card.appendChild(text);
    thread.appendChild(card);
  }

  function initial() {
    var name = (config && config.name) || '';
    return name ? name.charAt(0).toUpperCase() : '?';
  }

  // Consecutive messages from one side within five minutes form a group:
  // one sender label on top, one time below, tighter bubble corners.
  var GROUP_MS = 5 * 60 * 1000;
  function sameGroup(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    var ta = new Date(a.createdAt), tb = new Date(b.createdAt);
    return ta.toDateString() === tb.toDateString() && Math.abs(tb - ta) < GROUP_MS;
  }

  function render() {
    // Every stream event re-renders the thread; keep a half-typed email.
    var oldCapture = document.getElementById('captureEmail');
    var draft = oldCapture ? { value: oldCapture.value, focused: document.activeElement === oldCapture } : null;
    thread.innerHTML = '';
    var paused = !!(config && config.paused);
    if (state.messages.length === 0 && config && config.availability !== 'AWAY' && !paused) {
      var welcome = document.createElement('div');
      welcome.className = 'welcome';
      var mark = document.createElement('div');
      mark.className = 'avatar';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = initial();
      var p = document.createElement('p');
      p.textContent = 'Ask us anything, we\\u2019re here.';
      welcome.appendChild(mark);
      welcome.appendChild(p);
      thread.appendChild(welcome);
    }
    if (state.ticketRef && state.messages.length > 0) {
      var ticket = document.createElement('p');
      ticket.className = 'ticket';
      ticket.id = 'ticketRef';
      ticket.textContent = 'Reference ' + state.ticketRef;
      thread.appendChild(ticket);
    }
    var lastDay = '';
    state.messages.forEach(function (m, i) {
      var day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        var d = document.createElement('p');
        d.className = 'day';
        d.textContent = new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        thread.appendChild(d);
      }
      var side = m.kind === 'CUSTOMER' ? 'customer' : 'agent';
      var first = !sameGroup(state.messages[i - 1], m);
      var last = !sameGroup(m, state.messages[i + 1]);
      if (first && side === 'agent') {
        var who = document.createElement('div');
        who.className = 'who';
        who.textContent = (config ? config.name : '') + ' Support';
        thread.appendChild(who);
      }
      var el = document.createElement('div');
      el.className = 'msg ' + side + (first ? ' first' : '') + (last ? ' last' : '');
      var body = document.createElement('div');
      body.textContent = m.body;
      el.appendChild(body);
      var attachmentNodesForMessage = attachmentNodes(m.attachments);
      if (attachmentNodesForMessage.length > 0) {
        var files = document.createElement('div');
        files.className = 'files';
        attachmentNodesForMessage.forEach(function (node) { files.appendChild(node); });
        el.appendChild(files);
      }
      thread.appendChild(el);
      if (last) {
        var time = document.createElement('time');
        time.className = 'time ' + side;
        time.dateTime = m.createdAt;
        time.textContent = new Date(m.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        thread.appendChild(time);
      }
    });
    if (paused) {
      renderPausedNotice();
    } else if (state.email) {
      var s = document.createElement('p');
      s.className = 'sysline';
      s.textContent = 'We\\u2019ll email ' + state.email + ' if you\\u2019ve left.';
      thread.appendChild(s);
    } else if (state.messages.length > 0 && config && config.availability !== 'AWAY') {
      renderEmailCapture();
      var capture = document.getElementById('captureEmail');
      if (draft && capture) {
        capture.value = draft.value;
        if (draft.focused) capture.focus();
      }
    }
    // Scroll after renderModes: showing the composer shrinks the thread.
    renderModes();
    thread.scrollTop = thread.scrollHeight;
  }

  function renderEmailCapture() {
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<p id="captureTitle">Get replies by email if you leave</p>' +
      '<form class="row" novalidate><input class="field" id="captureEmail" type="email" autocomplete="email" placeholder="you@example.com" aria-labelledby="captureTitle">' +
      '<button class="btn" type="submit" id="captureSave">Save</button></form>' +
      '<button class="linkbtn" type="button" id="captureNo">No thanks</button>';
    thread.appendChild(card);
    card.querySelector('form').addEventListener('submit', function (event) {
      event.preventDefault();
      saveEmail(card.querySelector('#captureEmail').value, card);
    });
    card.querySelector('#captureNo').addEventListener('click', function () { card.remove(); });
  }

  function renderModes() {
    if (config && config.paused) {
      // Paused: the thread stays readable, nothing can be sent.
      awayForm.style.display = 'none';
      thread.style.display = 'flex';
      document.getElementById('composer').style.display = 'none';
      var staleHint = document.getElementById('emailHint');
      if (staleHint) staleHint.remove();
      return;
    }
    var away = config && config.availability === 'AWAY';
    var showAway = away && state.messages.length === 0;
    awayForm.style.display = showAway ? 'flex' : 'none';
    thread.style.display = showAway ? 'none' : 'flex';
    document.getElementById('composer').style.display = showAway ? 'none' : 'flex';
    if (!showAway) {
      document.getElementById('emailHint') && document.getElementById('emailHint').remove();
      if (away && !state.email) {
        var hint = document.createElement('div');
        hint.id = 'emailHint';
        hint.className = 'sysline';
        hint.style.padding = '0 16px 8px';
        hint.textContent = 'We\\u2019re away — leave your email so we can reply.' +
          (config && config.supportEmail ? ' Or write to ' + config.supportEmail + '.' : '');
        document.getElementById('composer').before(hint);
      }
    }
  }

  function captureError(cardEl, message) {
    var hint = cardEl.querySelector('.hint');
    if (!hint) { hint = document.createElement('div'); hint.className = 'hint'; hint.id = 'captureHint'; hint.setAttribute('aria-live', 'polite'); cardEl.insertBefore(hint, cardEl.querySelector('.linkbtn')); }
    hint.textContent = message;
    var field = cardEl.querySelector('#captureEmail');
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', 'captureHint');
    field.focus();
  }

  function saveEmail(email, cardEl) {
    email = String(email || '').trim();
    if (cardEl && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
      captureError(cardEl, 'Enter a valid email address.');
      return Promise.resolve({});
    }
    if (previewMode) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          state.email = email;
          if (cardEl) cardEl.remove();
          render();
          resolve({ email: email });
        }, 300);
      });
    }
    var emailGeneration = sessionGeneration;
    return apiFetch('/api/widget/messages', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email })
    }).then(function (r) { return r.json(); }).then(function (data) {
      // The previous visitor's email must not land on the fresh session's UI.
      if (emailGeneration !== sessionGeneration) return {};
      if (data.email) {
        state.email = data.email;
        if (cardEl) cardEl.remove();
        render();
      } else if (cardEl) {
        captureError(cardEl, data.error || 'Enter a valid email address.');
      }
      return data;
    });
  }

  function flushDevQueue() {
    booted = true;
    while (devQueue.length) {
      var item = devQueue.shift();
      pushDeveloperData(item[0], item[1]);
    }
  }

  function persistToken(data) {
    // Only a newly issued token is stored; session echo for an existing
    // visitor carries no token and must not clobber the stored one.
    if (data && data.token) saveToken(data.token);
  }

  // Boot with capped automatic retries (issue #57); when they run out the
  // banner surfaces the manual Retry affordance. The banner's Retry button
  // starts a fresh cycle.
  var bootRetry = retryApi.createRetry({
    attempt: boot,
    gaveUp: function () { showBanner(); }
  });
  function boot() {
    if (previewMode) {
      booted = true;
      applyConfig({
        name: params.get('name') || 'Support',
        color: params.get('color') || '#2563eb',
        availability: params.get('availability') === 'AWAY' ? 'AWAY' : 'LIVE'
      });
      render();
      startStream();
      return;
    }
    var generation = sessionGeneration;
    // A pending reset (host sign-out, issue #151) must reach the server
    // before any session is requested, or boot would resume the previous
    // user's session from the still-valid cookie. A failed reset fails the
    // boot (retry/banner) rather than silently falling back to that session.
    var ready = resetPending
      ? apiFetch('/api/widget/session', { method: 'DELETE', keepalive: true }).then(function (r) {
          if (!r.ok) return Promise.reject(r.status);
          if (generation === sessionGeneration) { resetPending = false; clearResetFlag(); removeToken(); }
        })
      : Promise.resolve();
    ready.then(function () {
      // A reset() that arrived mid-flight owns the next boot.
      if (generation !== sessionGeneration) return;
      return apiFetch('/api/widget/session', { method: 'POST' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function (data) {
          if (generation !== sessionGeneration) return;
          bootRetry.success();
          hideBanner();
          persistToken(data);
          probeCookieTransport();
          applyConfig(data);
          state.email = data.session && data.session.email;
          state.conversationId = data.thread && data.thread.conversationId;
          state.ticketRef = (data.thread && data.thread.ticketRef) || null;
          state.messages = (data.thread && data.thread.messages) || [];
          lastCount = state.messages.length;
          render();
          flushDevQueue();
          startStream();
        });
    }).catch(function () {
      if (generation !== sessionGeneration) return;
      bootRetry.fail();
    });
  }

  // Bounded polling fallback (ADR-0003), issue #57 hardening: a fixed 4 s
  // interval that never gave up could saturate the widget rate budgets on
  // its own. Consecutive failures now back off exponentially and the chain
  // stops (banner Retry resumes it) after pollMaxFailures; the shared
  // later() pauses the chain while the page is hidden.
  var pollState = { running: false, failures: 0, cancel: null };
  function startPolling() {
    if (pollState.running) return;
    pollState.running = true;
    pollState.failures = 0;
    schedulePoll(retryApi.POLICY.pollBaseMs);
  }
  function stopPolling() {
    pollState.running = false;
    if (pollState.cancel) { pollState.cancel(); pollState.cancel = null; }
  }
  function schedulePoll(delay) {
    pollState.cancel = retryApi.later(function () {
      pollState.cancel = null;
      poll();
    }, delay);
  }
  function pollFailure() {
    if (!pollState.running) return;
    pollState.failures += 1;
    if (pollState.failures >= retryApi.POLICY.pollMaxFailures) {
      stopPolling();
      showBanner();
      return;
    }
    schedulePoll(retryApi.backoffDelay(pollState.failures, retryApi.POLICY.pollBaseMs));
  }
  function pollSuccess() {
    pollState.failures = 0;
    if (pollState.running) schedulePoll(retryApi.POLICY.pollBaseMs);
  }

  function poll() {
    if (previewMode) { reportUnread(); return; }
    // A reset() in flight retires this poll: its response belongs to the
    // signed-out visitor and its reschedule would duplicate the new chain.
    var pollGeneration = sessionGeneration;
    apiFetch('/api/widget/messages', {})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (pollGeneration !== sessionGeneration) return;
        if (!data || !data.thread) { pollFailure(); return; }
        var prev = state.messages;
        var incoming = data.thread.messages || [];
        var changed = prev.length !== incoming.length ||
          (incoming.length > 0 && !prev.some(function (m) { return m.id === incoming[incoming.length - 1].id; }));
        if (changed) {
          if (!previewMode && hasNewAgentReply(prev, incoming)) chime.notify();
          state.messages = incoming;
          state.conversationId = data.thread.conversationId;
          state.ticketRef = data.thread.ticketRef || null;
          if (!hidden) render();
          reportUnread();
        }
        lastCount = hidden ? lastCount : incoming.length;
        pollSuccess();
      })
      .catch(function () {
        if (pollGeneration !== sessionGeneration) return;
        pollFailure();
      });
  }

  function reportUnread() {
    if (hidden && state.messages.length > lastCount) {
      parent.postMessage({ type: 'ss:unread', count: state.messages.length - lastCount }, '*');
    }
  }


  function send() {
    // Enter bypasses the disabled button: one request at a time, and never
    // before an upload in flight has produced the attachment to send with it.
    if (sending || uploading.length > 0) return;
    // After reset() the previous visitor's token stays stored until the
    // revocation DELETE succeeds: a send now would post as the signed-out user.
    if (resetPending && !previewMode) return;
    var body = input.value.trim();
    if (!body && pendingAttachments.length === 0) return;
    if (!body) body = '(attachment)';
    input.value = '';
    input.style.height = 'auto';
    sending = true;
    updateSendState();
    var attachmentIds = pendingAttachments.map(function (a) { return a.id; });
    pendingAttachments = [];
    renderChips();
    if (previewMode) {
      sending = false;
      updateSendState();
      state.messages.push({ id: 'p' + Date.now(), kind: 'CUSTOMER', body: body, createdAt: new Date().toISOString() });
      render();
      setTimeout(function () {
        state.messages.push({ id: 'a' + Date.now(), kind: 'AGENT', body: 'Thanks! This is a preview — replies from your team will appear here.', createdAt: new Date().toISOString() });
        render();
      }, 900);
      return;
    }
    var sendGeneration = sessionGeneration;
    requestDiagnostics().then(function (diagnostics) {
      // reset() while diagnostics were pending: never post this body as the fresh visitor.
      if (sendGeneration !== sessionGeneration) return Promise.reject('superseded');
      var payload = { body: body, pageUrl: pageUrl(), attachmentIds: attachmentIds };
      if (diagnostics) payload.diagnostics = diagnostics;
      return apiFetch('/api/widget/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (result) {
        // A reset() mid-send (host sign-out) retired this session: its
        // thread must not repaint over the fresh one (reset() already
        // cleared the sending state).
        if (sendGeneration !== sessionGeneration) return;
        sending = false;
        updateSendState();
        if (result.ok && result.data.thread) {
          // An agent reply can land while this send is in flight; the POST
          // snapshot would otherwise swallow it before the stream sees it.
          var sent = result.data.thread.messages || [];
          if (hasNewAgentReply(state.messages, sent)) chime.notify();
          state.messages = sent;
          state.conversationId = result.data.thread.conversationId;
          state.ticketRef = result.data.thread.ticketRef || null;
          render();
          // The stream is not opened before a conversation exists; the first
          // send creates it, so open the stream now.
          if (!streamActive && !previewMode) startStream();
        } else {
          input.value = body;
          updateSendState();
          restoreDiagnostics();
          if (result.data.error === 'service_paused') {
            markPaused();
          } else if (result.data.error === 'rate_limited') {
            var hint = document.createElement('p');
            hint.className = 'sysline';
            hint.textContent = 'You\\u2019re sending messages too quickly. Try again in a moment.';
            hint.id = 'rlHint';
            var old = document.getElementById('rlHint'); if (old) old.remove();
            thread.appendChild(hint); thread.scrollTop = thread.scrollHeight;
            setTimeout(function () { hint.remove(); }, 2500);
          }
        }
      })
      .catch(function () {
        if (sendGeneration !== sessionGeneration) return;
        sending = false;
        input.value = body;
        updateSendState();
        restoreDiagnostics();
        showBanner();
      });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  });
  input.addEventListener('input', function () {
    updateSendState();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  });

  awayForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var email = document.getElementById('email').value.trim();
    var message = document.getElementById('message').value.trim();
    var hint = document.getElementById('awayHint');
    // After reset() the previous visitor's credential is still live until the
    // revocation DELETE succeeds: submitting now would act as that visitor.
    if (resetPending && !previewMode) { hint.textContent = 'One moment, setting up a fresh chat…'; return; }
    var emailOk = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
    document.getElementById('email').setAttribute('aria-invalid', emailOk ? 'false' : 'true');
    document.getElementById('message').setAttribute('aria-invalid', emailOk && !message ? 'true' : 'false');
    if (!emailOk) { hint.textContent = 'Enter a valid email address so we can reply.'; return; }
    if (!message) { hint.textContent = 'Write a short message so we know how to help.'; return; }
    hint.textContent = '';
    document.getElementById('awaySend').disabled = true;
    var awayGeneration = sessionGeneration;
    saveEmail(email).then(function (saved) {
      // reset() mid-flight retired this visitor: no follow-up POST as the new one.
      if (awayGeneration !== sessionGeneration) return;
      if (saved && saved.error) {
        // e.g. the visitor typed the team's own support address.
        hint.textContent = saved.error;
        document.getElementById('awaySend').disabled = false;
        return;
      }
      if (previewMode) {
        state.messages.push({ id: 'p' + Date.now(), kind: 'CUSTOMER', body: message, createdAt: new Date().toISOString() });
        render();
        return;
      }
      input.dataset.awayMessage = '';
      return requestDiagnostics().then(function (diagnostics) {
        if (awayGeneration !== sessionGeneration) return null;
        var payload = { body: message, pageUrl: pageUrl() };
        if (diagnostics) payload.diagnostics = diagnostics;
        return apiFetch('/api/widget/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }).then(function (r) { return r && r.json(); }).then(function (data) {
        if (!data || awayGeneration !== sessionGeneration) return;
        document.getElementById('awaySend').disabled = false;
        if (data.error === 'service_paused') { restoreDiagnostics(); markPaused(); return; }
        if (data.thread) {
          var saved = data.thread.messages || [];
          if (hasNewAgentReply(state.messages, saved)) chime.notify();
          state.messages = saved;
          state.conversationId = data.thread.conversationId;
          state.ticketRef = data.thread.ticketRef || null;
          render();
        }
        else restoreDiagnostics();
        if (!streamActive && !previewMode) startStream();
      });
    });
  });

  function closePanel() { parent.postMessage({ type: 'ss:close' }, '*'); }
  document.getElementById('closeBtn').addEventListener('click', closePanel);
  // Esc closes the non-modal panel; the loader returns focus to the launcher.
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closePanel();
  });

  document.getElementById('retryBtn').addEventListener('click', function () {
    hideBanner();
    stopPolling();
    bootRetry.reset();
    bootRetry.run();
  });

  var booted = false;
  var devQueue = [];
  // Host sign-out (issue #151): reset() bumps the generation so results from
  // the retired session are dropped, and resetPending makes the next boot
  // revoke the server session before requesting a fresh one.
  var sessionGeneration = 0;
  // Seeded from storage: a reset requested on a previous page of this tab
  // that never reached the server is still owed.
  var resetPending = resetFlagged();
  // identify()/context()/pageUrl all merge into one stored JSON; serialize
  // the writes so concurrent PUTs cannot clobber each other.
  var devChain = Promise.resolve();
  function pushDeveloperData(kind, payload) {
    // Calls can arrive before the session exists; queue until boot resolves
    // so nothing is dropped (FR-CTX-01).
    if (!booted) {
      devQueue.push([kind, payload]);
      return;
    }
    var body = {};
    if (kind === 'identify') body.identify = payload;
    if (kind === 'context') body.context = payload;
    var generation = sessionGeneration;
    devChain = devChain.then(function () {
      // Identity pushed for a signed-out user must never land on the fresh session.
      if (generation !== sessionGeneration) return null;
      return apiFetch('/api/widget/context', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    }).then(function (r) { return r && r.ok ? r.json() : null; }).then(function (data) {
      if (generation !== sessionGeneration) return;
      if (data && data.email) { state.email = data.email; render(); }
    }).catch(function () { /* silent: developer data is best-effort */ });
  }

  // SupportSealWidget.reset() (host sign-out): drop everything that belongs
  // to the current visitor, then boot a fresh anonymous session. Queued
  // identify()/context() from before the reset are discarded; calls made
  // after it wait for the new session like any pre-boot call.
  function resetSession() {
    if (previewMode) return;
    // A revocation is already pending or retrying: that is the same operation.
    // A second DELETE could land after the first boot and clear the fresh cookie.
    if (resetPending) return;
    sessionGeneration += 1;
    resetPending = true;
    flagReset();
    booted = false;
    devQueue = [];
    streamRetry.reset();
    stopPolling();
    if (activeSource) { activeSource.close(); activeSource = null; }
    streamActive = false;
    state.messages = [];
    state.email = null;
    state.conversationId = null;
    state.ticketRef = null;
    lastCount = 0;
    sending = false;
    pendingAttachments = [];
    renderChips();
    input.value = '';
    input.style.height = 'auto';
    updateSendState();
    document.getElementById('email').value = '';
    document.getElementById('message').value = '';
    document.getElementById('awaySend').disabled = false;
    hideBanner();
    if (config) render();
    bootRetry.reset();
    bootRetry.run();
  }

  window.addEventListener('message', function (event) {
    // The loader runs in the host page, so event.origin is the host origin.
    // Only accept messages from our direct parent (the loader's iframe tag).
    if (event.source !== window.parent) return;
    var data = event.data || {};
    if (data.type === 'ss:page' && typeof data.path === 'string') hostPath = data.path;
    if (data.type === 'ss:open') {
      hidden = false;
      unlockSound();
      lastCount = state.messages.length;
      // Replies that arrived while hidden updated state but not the DOM.
      if (config) render();
      input.focus();
    }
    if (data.type === 'ss:close') hidden = true;
    if (data.type === 'ss:identify') pushDeveloperData('identify', data.payload);
    if (data.type === 'ss:context') pushDeveloperData('context', data.payload);
    if (data.type === 'ss:reset') resetSession();
  });

  var STREAM_SILENCE_MS = 45000;
  var streamActive = false;
  var activeSource = null;
  var previewTimer = null;
  // Stream reconnects follow the shared capped backoff (issue #57) instead
  // of the browser's EventSource default (~3 s loop); when automatic
  // reconnects run out, the bounded polling fallback takes over.
  var streamRetry = retryApi.createRetry({
    attempt: connectStream,
    gaveUp: function () { startPolling(); }
  });
  function startStream() {
    if (previewMode) {
      if (!previewTimer) previewTimer = setInterval(poll, retryApi.POLICY.pollBaseMs);
      return;
    }
    // The server answers 401 "no session" until the visitor has a conversation
    // (a red console error on every page view). The stream opens from boot
    // (restored conversation) or the first send, never before.
    if (!state.conversationId) return;
    streamRetry.reset();
    streamRetry.run();
  }
  function connectStream() {
    if (activeSource) { activeSource.close(); activeSource = null; }
    var after = state.messages.length
      ? state.messages[state.messages.length - 1].createdAt
      : new Date().toISOString();
    var streamUrl = apiUrl('/api/widget/stream') + '&after=' + encodeURIComponent(after);
    // EventSource cannot send the x-ss-visitor-token header, so the stored
    // token rides as t= — without it the stream is 401 wherever third-party
    // cookies are blocked (issue #56: Safari ITP / Firefox / Chrome 3P).
    var streamToken = storedToken();
    if (streamToken) streamUrl += '&t=' + encodeURIComponent(streamToken);
    var source = new EventSource(streamUrl);
    activeSource = source;
    streamActive = true;
    // Watchdog: a connection that dies silently (network change, sleep, a
    // proxy or NAT dropping it) never fires onerror, so the panel would wait
    // forever. The server sends a heartbeat every 15 s; three missed ones
    // count as a failure and reconnect from the cursor.
    var watchdog = null;
    function armWatchdog() {
      clearTimeout(watchdog);
      watchdog = setTimeout(function () { failStream(source); }, STREAM_SILENCE_MS);
    }
    armWatchdog();
    source.addEventListener('heartbeat', armWatchdog);
    source.addEventListener('ready', function () {
      armWatchdog();
      // The stream is established; stop the polling fallback if it ran.
      streamRetry.success();
      stopPolling();
    });
    source.addEventListener('messages', function (event) {
      // A frame from a connection reset() closed must not repaint the retired thread.
      if (activeSource !== source) return;
      armWatchdog();
      try {
        var incoming = JSON.parse(event.data);
        if (hasNewAgentReply(state.messages, incoming)) chime.notify();
        incoming.forEach(function (m) {
          if (!state.messages.some(function (x) { return x.id === m.id; })) state.messages.push(m);
        });
        state.messages.sort(function (a, b) {
          return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        });
        if (!hidden) { render(); lastCount = state.messages.length; }
        reportUnread();
      } catch (e) { /* malformed frame: fall through to polling safety */ }
    });
    source.onerror = function () {
      // Close on every error: a native auto-reconnect loop is exactly the
      // uncontrolled retry rate issue #57 fixes. Reconnect timing is ours.
      failStream(source);
    };
    function failStream(failed) {
      clearTimeout(watchdog);
      failed.close();
      if (activeSource !== failed) return;
      activeSource = null;
      streamActive = false;
      streamRetry.fail();
    }
  }

  bootRetry.run();
})();
</script>
</body>
</html>`;
