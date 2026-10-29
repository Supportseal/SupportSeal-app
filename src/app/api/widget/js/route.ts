import { NextResponse } from "next/server";

import { brand } from "@/lib/brand";
import { stripWidgetComments } from "@/lib/widget-bundle-strip";
import { WIDGET_RETRY_JS } from "@/lib/widget-retry-source";

export const dynamic = "force-dynamic";

/**
 * Widget loader: <script async src="{origin}/widget.js" data-key="pk_…"></script>
 * Served without Next's page runtime (plain JS string) so the host page never
 * downloads the dashboard bundle (docs/design/chat-widget.md). The shared retry policy
 * (issue #57) is prepended; it exposes window.__ssWidgetRetry. Comment-only
 * lines are stripped from the served bytes to stay inside the DX-17 budget.
 */
export async function GET() {
  const loader = LOADER_JS.replace("__SS_BRAND_NAME__", () => JSON.stringify(brand.name));
  const js = stripWidgetComments(WIDGET_RETRY_JS) + "\n" + stripWidgetComments(loader);
  return new NextResponse(js, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

const LOADER_JS = String.raw`
(function () {
  if (window.__supportsealWidget) return;
  window.__supportsealWidget = true;

  var script =
    document.currentScript ||
    (function () {
      var all = document.querySelectorAll('script[data-key]');
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && all[i].src.indexOf('/widget.js') !== -1) return all[i];
      }
      return null;
    })();
  if (!script) return;

  var key = script.getAttribute('data-key');
  var previewMode = script.getAttribute('data-preview') === '1';
  var serviceOrigin = (function () {
    try {
      return new URL(script.src).origin;
    } catch (e) {
      return '';
    }
  })();
  if (!key || !serviceOrigin) return;

  var BRAND_NAME = __SS_BRAND_NAME__;
  var hostEl = null;
  var launcher = null;
  var frame = null;
  var open = false;
  var unread = 0;
  var config = null;

  function autoContrast(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    var c = m[1];
    var r = parseInt(c.slice(0, 2), 16) / 255;
    var g = parseInt(c.slice(2, 4), 16) / 255;
    var b = parseInt(c.slice(4, 6), 16) / 255;
    function lin(x) { return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
    var l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000' : '#fff';
  }

  function isMobile() { return window.innerWidth < 640; }

  var testTokenAttr = script.getAttribute('data-test-token') || '';
  // Config loads with capped exponential backoff (issue #57): the loader has
  // no Retry affordance, so after maxAutoRetries it stays dormant until the
  // host page reloads. maxAuto 5 (2, 4, 8, 16, 30 s, jittered) keeps the old
  // ~45 s outage tolerance of the fixed [2, 10, 30] s schedule; the policy
  // default of 3 would give up after ~14 s. Retries also pause while the
  // page is hidden.
  var configRetry = window.__ssWidgetRetry.createRetry({
    maxAuto: 5,
    attempt: loadConfig,
    gaveUp: function () {}
  });
  function loadConfig() {
    if (previewMode) {
      config = {
        name: script.getAttribute('data-name') || 'Support',
        color: script.getAttribute('data-color') || '#2563eb',
        availability: script.getAttribute('data-availability') === 'AWAY' ? 'AWAY' : 'LIVE'
      };
      render();
      return;
    }
    var url = serviceOrigin + '/api/widget/config?key=' + encodeURIComponent(key) +
      '&host=' + encodeURIComponent(window.location.origin) +
      (testTokenAttr ? '&testToken=' + encodeURIComponent(testTokenAttr) : '');
    fetch(url)
      .then(function (r) {
        if (r.status !== 403) return r.ok ? r.json() : Promise.reject(r.status);
        // 403 is the origin gate. The answer will not change on its own, so
        // report it once and stop retrying instead of spamming the console.
        return r.json().then(
          function (body) { return Promise.reject(body && body.error === 'origin_not_allowed' ? 'origin_not_allowed' : 403); },
          function () { return Promise.reject(403); }
        );
      })
      .then(function (data) {
        config = data;
        configRetry.success();
        render();
        // Starts after config loads (design "Start timing"); disabled
        // Products (flag absent) never fetch the collector bundle.
        loadCollector();
      })
      .catch(function (reason) {
        if (reason === 'origin_not_allowed') {
          warnOriginNotAllowed();
          return;
        }
        configRetry.fail();
      });
  }

  var originWarned = false;
  // Integrator self-diagnosis (issue #152): without this the widget just never
  // appears. Logged once per page load; no retry follows.
  function warnOriginNotAllowed() {
    if (originWarned) return;
    originWarned = true;
    try {
      console.error(
        '[' + BRAND_NAME + '] Widget not loaded: ' + window.location.origin +
        ' is not in the allowed domains of this product. Add "' + window.location.hostname +
        '" under Settings > Products > (your product) > Domains: ' + serviceOrigin + '/settings/products'
      );
    } catch (e) { /* logging must never break the host page */ }
  }

  function render() {
    if (!config || hostEl) return;
    hostEl = document.createElement('div');
    hostEl.id = 'supportseal-widget-host';
    hostEl.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
    var root = hostEl.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = [
      '.launcher{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;box-shadow:0 4px 24px rgba(21,38,31,.24);display:flex;align-items:center;justify-content:center;transition:transform .16s ease,box-shadow .16s ease}',
      '@media (max-width:639px){.launcher{bottom:16px;right:16px}}',
      '.launcher:hover{transform:scale(1.05);box-shadow:0 6px 28px rgba(21,38,31,.3)}',
      '.launcher:active{transform:scale(.95)}',
      '.launcher:focus-visible{outline:none;box-shadow:0 0 0 3px #fff,0 0 0 5px #15261f}',
      '.launcher svg{position:absolute;width:26px;height:26px;transition:transform .16s ease,opacity .16s ease}',
      '.launcher .ic-x,.launcher.open .ic-chat{opacity:0;transform:rotate(-30deg) scale(.6)}',
      '.launcher.open .ic-x{opacity:1;transform:none}',
      '.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#c42b2b;color:#fff;box-shadow:0 0 0 2px #fff;font:600 11px/20px system-ui,sans-serif;text-align:center;display:none}',
      '.panel{opacity:0;visibility:hidden;transform:translateY(12px) scale(.98);transform-origin:bottom right;transition:opacity .16s ease,transform .16s ease,visibility 0s .16s}',
      '.panel.open{opacity:1;visibility:visible;transform:none;transition:opacity .16s ease,transform .16s ease}',
      '@media (prefers-reduced-motion:reduce){.launcher,.launcher svg,.panel,.panel.open{transition:none}}',
    ].join('');
    root.appendChild(style);

    launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.setAttribute('aria-label', 'Open chat with ' + config.name);
    launcher.style.background = config.color;
    var ink = autoContrast(config.color);
    launcher.setAttribute('aria-expanded', 'false');
    launcher.innerHTML =
      '<svg class="ic-chat" viewBox="0 0 24 24" fill="none" stroke="' + ink + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
      '<svg class="ic-x" viewBox="0 0 24 24" fill="none" stroke="' + ink + '" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>' +
      '<span class="badge"></span>';
    launcher.addEventListener('click', toggle);
    root.appendChild(launcher);

    frame = document.createElement('iframe');
    frame.className = 'panel';
    frame.title = config.name + ' support chat';
    frame.src = serviceOrigin + '/widget?key=' + encodeURIComponent(key) +
      '&host=' + encodeURIComponent(window.location.origin) +
      (testTokenAttr ? '&testToken=' + encodeURIComponent(testTokenAttr) : '') +
      (previewMode
        ? '&preview=1&name=' + encodeURIComponent(config.name) +
          '&color=' + encodeURIComponent(config.color) +
          '&availability=' + encodeURIComponent(config.availability)
        : '');
    frame.setAttribute('allow', 'clipboard-write; autoplay');
    frame.addEventListener('load', function () {
      panelReady = true;
      // A launcher click that beat the panel document's load posted ss:open
      // to the still-blank iframe, where it was dropped; replay it so the
      // panel knows it is visible and renders incoming replies.
      if (open && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'ss:open' }, serviceOrigin);
      }
      notifyPage();
      flushApi();
    });
    root.appendChild(frame);
    positionPanel();

    document.body.appendChild(hostEl);
    observeRemoval();
    if (previewMode) {
      // Previews start with the panel open (onboarding.md "launcher and open
      // panel"); the visitor can still close it.
      setTimeout(function () { if (!open) toggle(); }, 400);
    }
  }

  // The panel stays laid out while closed (hidden via the class) so open
  // and close can animate; its backdrop matches the panel's colour scheme.
  function positionPanel() {
    if (!frame) return;
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var base = 'position:fixed;border:none;z-index:2147483001;background:' + (dark ? '#16211d' : '#fff') + ';';
    frame.style.cssText = isMobile()
      ? base + 'inset:0;width:100%;height:100dvh'
      : base + 'bottom:92px;right:20px;width:380px;height:' + Math.min(640, window.innerHeight - 120) + 'px;border-radius:16px;box-shadow:0 12px 48px rgba(21,38,31,.22),0 2px 8px rgba(21,38,31,.08)';
    frame.className = 'panel' + (open ? ' open' : '');
  }

  function toggle() {
    open = !open;
    if (open) setUnread(0);
    positionPanel();
    if (launcher) {
      launcher.setAttribute('aria-label', (open ? 'Close chat with ' : 'Open chat with ') + (config ? config.name : ''));
      launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
      launcher.classList.toggle('open', open);
    }
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: open ? 'ss:open' : 'ss:close' }, serviceOrigin);
    }
  }

  function setUnread(n) {
    unread = n;
    if (!launcher) return;
    var badge = launcher.querySelector('.badge');
    if (!badge) return;
    badge.style.display = n > 0 ? 'block' : 'none';
    badge.textContent = n > 9 ? '9+' : String(n);
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== serviceOrigin || !event.data) return;
    if (event.data.type === 'ss:unread' && !open) setUnread(event.data.count || 1);
    // The panel recorded a reset() durably: tell the host page so it can stop
    // retrying (a reset still queued when a page unloads is otherwise lost).
    if (event.data.type === 'ss:reset-ack') {
      try { window.dispatchEvent(new CustomEvent('supportseal:reset-acknowledged')); } catch (e) { /* never surfaced */ }
    }
    if (event.data.type === 'ss:close' && open) {
      toggle();
      if (launcher) launcher.focus();
    }
    if (event.data.type === 'ss:navigate' && frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: 'ss:page', path: event.data.path }, serviceOrigin);
    }
    // Panel asks for a diagnostics snapshot when the visitor sends a message
    // (docs/design/diagnostics.md "Transport"). Only the panel (service
    // origin) can reach this branch; the reply goes only to the panel.
    if (event.data.type === 'ss:diag-request') {
      var snapshot = null;
      try { if (window.__ssDiag) snapshot = window.__ssDiag.snapshot(); } catch (e) { snapshot = null; }
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'ss:diag-snapshot', snapshot: snapshot }, serviceOrigin);
      }
    }
    // The message send failed: give the snapshot's events back to the buffer
    // so the visitor's retry carries them.
    if (event.data.type === 'ss:diag-restore') {
      try { if (window.__ssDiag) window.__ssDiag.restore(); } catch (e) { /* never surfaced */ }
    }
  });

  window.addEventListener('resize', positionPanel);

  // SPA survival: keep the host mounted and report client-side navigation.
  var pushState = history.pushState;
  history.pushState = function () {
    var result = pushState.apply(this, arguments);
    notifyPage();
    return result;
  };
  window.addEventListener('popstate', notifyPage);
  function notifyPage() {
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: 'ss:page', path: window.location.pathname }, serviceOrigin);
    }
  }

  function observeRemoval() {
    if (!('MutationObserver' in window) || !hostEl) return;
    var observer = new MutationObserver(function () {
      if (hostEl && !document.body.contains(hostEl)) {
        document.body.appendChild(hostEl);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Developer context API (FR-CTX-01): window.SupportSeal -------------
  // identify()/context() are queued until the panel exists, then forwarded.
  var apiQueue = [];
  var panelReady = false;
  function enqueue(type, payload) {
    apiQueue.push({ type: type, payload: payload });
    flushApi();
  }
  function flushApi() {
    // Only post once the panel document has loaded: earlier postMessages hit
    // about:blank (origin "null") and are silently dropped.
    if (!panelReady || !frame || !frame.contentWindow) return;
    while (apiQueue.length) {
      var item = apiQueue.shift();
      frame.contentWindow.postMessage({ type: 'ss:' + item.type, payload: item.payload }, serviceOrigin);
    }
  }
  // --- Diagnostics (docs/design/diagnostics.md) ---------------------------
  // The collector bundle loads only when the Product enabled it; the
  // developer switch can only narrow (pause), never widen.
  var diagUserEnabled = true;
  var diagLoaded = false;
  function setDiagnostics(enabled) {
    diagUserEnabled = !!enabled;
    try {
      if (!enabled && window.__ssDiag) window.__ssDiag.pause();
      if (enabled && window.__ssDiag) window.__ssDiag.resume();
    } catch (e) { /* collector issues never surface on the host page */ }
  }
  function loadCollector() {
    if (diagLoaded || previewMode || !config.diagnostics) return;
    diagLoaded = true;
    try {
      window.__ssDiagConfig = { serviceOrigin: serviceOrigin, startPaused: !diagUserEnabled };
      var s = document.createElement('script');
      s.async = true;
      s.src = serviceOrigin + '/widget-diagnostics.js';
      s.setAttribute('data-service-origin', serviceOrigin);
      (document.body || document.head).appendChild(s);
    } catch (e) { /* no diagnostics rather than a broken page */ }
  }
  function dispatch(entry) {
    try {
      var type = entry && entry[0];
      if (type === 'identify' || type === 'context') enqueue(type, entry[1] || {});
      if (type === 'reset') resetSession();
      if (type === 'diagnostics') setDiagnostics(entry[1] !== false);
    } catch (e) { /* untrusted queue entries never break the widget */ }
  }
  // reset(): call when the host signs the user out. Ends the visitor session
  // (cookie + stored token) and starts a fresh anonymous one, so the next
  // user on a shared device never sees the previous thread or identity.
  function resetSession() {
    setUnread(0);
    // identify()/context() still queued belong to the user who signed out.
    apiQueue.length = 0;
    // Buffered errors / failed-request URLs belong to the signed-out user too:
    // pause() drops the buffer, resume() restores the host's own setting.
    try {
      if (window.__ssDiag) { window.__ssDiag.pause(); if (diagUserEnabled) window.__ssDiag.resume(); }
    } catch (e) { /* never surfaced */ }
    enqueue('reset', {});
  }
  var publicApi = {
    reset: function () { resetSession(); },
    identify: function (payload) { enqueue('identify', payload || {}); },
    context: function (payload) { enqueue('context', payload || {}); },
    diagnostics: function (enabled) { setDiagnostics(enabled !== false); },
    // Keep the documented async-safety queue usable after the loader takes
    // over window.SupportSealWidget: q.push(['identify', {...}]) keeps working.
    q: {
      push: function (entry) { dispatch(entry); },
    },
  };
  var existing = window.SupportSealWidget || {};
  var pending = (existing && Array.isArray(existing.q)) ? existing.q : [];
  window.SupportSealWidget = publicApi;
  for (var i = 0; i < pending.length; i++) {
    dispatch(pending[i]);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { configRetry.run(); });
  } else {
    configRetry.run();
  }
})();
`;
