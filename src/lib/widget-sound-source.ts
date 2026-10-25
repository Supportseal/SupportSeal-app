import { CHIME, SOUND_MIN_GAP_MS } from "@/lib/notify-sound";

/**
 * ES5 twin of src/lib/notify-sound.ts for the widget panel document (issue
 * #125), embedded verbatim in the panel script like WIDGET_RETRY_JS. Tone,
 * gain and throttle come from the same constants as the desk module;
 * notify-sound.test.ts runs both against one table of scenarios.
 *
 * Same constraints as the retry module: plain ES5, no template literals,
 * no backticks, no "</script>". Exposes `window.__ssWidgetSound` in the
 * browser and `module.exports` only where window is absent (tests).
 */
export const WIDGET_SOUND_JS = String.raw`
(function (global) {
  var CHIME = ${JSON.stringify(CHIME)};
  var MIN_GAP_MS = ${SOUND_MIN_GAP_MS};

  function defaultContext() {
    var Ctor = global.AudioContext || global.webkitAudioContext;
    return Ctor ? new Ctor() : null;
  }

  function playChime(ctx) {
    var start = ctx.currentTime;
    CHIME.notes.forEach(function (note) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      var from = start + note.startSeconds;
      var to = from + note.durationSeconds;
      osc.type = 'sine';
      osc.frequency.value = note.frequency;
      gain.gain.setValueAtTime(CHIME.floorGain, from);
      gain.gain.exponentialRampToValueAtTime(CHIME.peakGain, from + CHIME.attackSeconds);
      gain.gain.exponentialRampToValueAtTime(CHIME.floorGain, to);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(from);
      osc.stop(to + 0.02);
    });
  }

  // opts: { storage, muteKey, now, createContext, minGapMs } (all optional
  // except muteKey). A throwing or missing storage keeps the choice in memory.
  function create(opts) {
    var now = opts.now || Date.now;
    var minGap = typeof opts.minGapMs === 'number' ? opts.minGapMs : MIN_GAP_MS;
    var makeContext = opts.createContext || defaultContext;
    var ctx = null;
    var ctxFailed = false;
    var lastPlayedAt = -Infinity;
    var memoryMuted = false;

    function isMuted() {
      try {
        var stored = opts.storage && opts.storage.getItem(opts.muteKey);
        if (stored === '1') return true;
        if (stored === '0') return false;
      } catch (e) { /* storage blocked */ }
      return memoryMuted;
    }
    function setMuted(muted) {
      memoryMuted = !!muted;
      try { if (opts.storage) opts.storage.setItem(opts.muteKey, muted ? '1' : '0'); }
      catch (e) { /* storage blocked: the choice still holds for this page */ }
    }
    function ensureContext() {
      if (ctx || ctxFailed) return ctx;
      try { ctx = makeContext(); } catch (e) { ctx = null; }
      ctxFailed = ctx === null;
      return ctx;
    }
    // Call from a user gesture; resolves true once audio can play.
    function unlock() {
      var c = ensureContext();
      if (!c) return Promise.resolve(false);
      var ready = c.state === 'running' ? Promise.resolve() : Promise.resolve(c.resume());
      return ready.then(function () { return c.state === 'running'; }, function () { return false; });
    }
    function emit() {
      var c = ensureContext();
      if (!c || c.state !== 'running') return false;
      try { playChime(c); return true; } catch (e) { return false; }
    }
    function notify() {
      if (isMuted()) return 'muted';
      var at = now();
      if (at - lastPlayedAt < minGap) return 'throttled';
      if (!emit()) return 'blocked';
      lastPlayedAt = at;
      return 'played';
    }
    function preview() {
      return unlock().then(function (ok) { return ok ? emit() : false; });
    }
    return { isMuted: isMuted, setMuted: setMuted, unlock: unlock, notify: notify, preview: preview };
  }

  var api = { CHIME: CHIME, MIN_GAP_MS: MIN_GAP_MS, create: create };
  if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.__ssWidgetSound = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
`;
