/**
 * Shared widget retry policy (issue #57), embedded verbatim in BOTH widget
 * scripts — the loader (`/widget.js`) and the panel document. In a browser
 * the module exposes `window.__ssWidgetRetry`; in tests it is evaluated with
 * `new Function("module", "exports", …)` and exports the same API
 * (same pattern as `src/lib/diagnostics/collector-source.ts`).
 *
 * Constraints:
 *  - Exponential backoff with jitter, a hard cap on automatic retries
 *    (then the host code surfaces its Retry affordance), and retries that
 *    pause while the page is hidden (visibilitychange) so one failing
 *    background tab cannot keep re-hitting the widget endpoints.
 *  - Plain ES5-style JS like the loader: no template literals, no
 *    backticks, no dollar-brace sequences, no "</script>".
 *  - The worst-case automatic request rate must stay inside the server's
 *    per-identity budgets (src/lib/widget-rate-limit.ts) — enforced by
 *    src/lib/__tests__/widget-retry.test.ts.
 */
export const WIDGET_RETRY_JS = String.raw`
(function (global) {
  var POLICY = {
    baseMs: 2000,
    factor: 2,
    maxDelayMs: 30000,
    jitterRatio: 0.5,
    maxAutoRetries: 3,
    pollBaseMs: 4000,
    pollMaxFailures: 5,
  };

  function backoffDelay(failures, baseMs, random) {
    var r = random || Math.random;
    var base = typeof baseMs === 'number' ? baseMs : POLICY.baseMs;
    var d = Math.min(base * Math.pow(POLICY.factor, failures), POLICY.maxDelayMs);
    var j = 1 - POLICY.jitterRatio + 2 * POLICY.jitterRatio * r();
    return Math.max(1, Math.round(d * j));
  }

  // Runs fn after delay ms, but only while the page is visible: a fire that
  // lands on a hidden page waits for visibilitychange instead. Returns a
  // cancel function.
  function later(fn, delay) {
    var doc = global.document;
    var done = false, timer = null, onVis = null;
    function fire() {
      if (done) return;
      done = true;
      fn();
    }
    timer = global.setTimeout(function () {
      if (doc && doc.hidden) {
        onVis = function () {
          if (doc && doc.hidden) return;
          doc.removeEventListener('visibilitychange', onVis);
          fire();
        };
        doc.addEventListener('visibilitychange', onVis);
      } else {
        fire();
      }
    }, delay);
    return function cancel() {
      if (done) return;
      done = true;
      global.clearTimeout(timer);
      if (onVis && doc) doc.removeEventListener('visibilitychange', onVis);
    };
  }

  // Capped automatic retries for one logical operation (config load, boot
  // session, stream connect). The host calls success() when the attempt
  // works and fail() when it does not; after maxAuto consecutive failures
  // gaveUp() runs once (host surfaces its Retry affordance) and further
  // fail() calls are ignored until success()/reset().
  function createRetry(opts) {
    var maxAuto = typeof opts.maxAuto === 'number' ? opts.maxAuto : POLICY.maxAutoRetries;
    var failures = 0;
    var cancelPending = null;
    var done = false;
    function run() {
      if (cancelPending) return;
      opts.attempt();
    }
    function success() {
      failures = 0;
      done = false;
    }
    function fail() {
      if (done || cancelPending) return;
      failures += 1;
      if (failures > maxAuto) {
        done = true;
        opts.gaveUp();
        return;
      }
      cancelPending = later(function () {
        cancelPending = null;
        opts.attempt();
      }, backoffDelay(failures - 1, POLICY.baseMs));
    }
    function reset() {
      if (cancelPending) {
        cancelPending();
        cancelPending = null;
      }
      failures = 0;
      done = false;
    }
    return { run: run, success: success, fail: fail, reset: reset };
  }

  var api = {
    POLICY: POLICY,
    backoffDelay: backoffDelay,
    later: later,
    createRetry: createRetry,
  };
  // The browser global always wins: host pages can leak a CommonJS
  // module.exports onto window, and the widget scripts read
  // window.__ssWidgetRetry (global is window there). module.exports is
  // only for the test/CommonJS evaluation context, where window is absent
  // (PR #67 review).
  if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.__ssWidgetRetry = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
`;
