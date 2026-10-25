import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { WIDGET_RETRY_JS } from "@/lib/widget-retry-source";
import { WIDGET_RATE_LIMITS } from "@/lib/widget-rate-limit";

/**
 * Issue #57: after a session failure the widget's automatic retries must
 * never exceed the intended request rate — enforced here against the SAME
 * module the loader and panel embed, cross-checked with the server budgets.
 */

type RetryApi = {
  POLICY: {
    baseMs: number;
    factor: number;
    maxDelayMs: number;
    jitterRatio: number;
    maxAutoRetries: number;
    pollBaseMs: number;
    pollMaxFailures: number;
  };
  backoffDelay: (failures: number, baseMs?: number, random?: () => number) => number;
  later: (fn: () => void, delay: number) => () => void;
  createRetry: (opts: {
    attempt: () => void;
    gaveUp: () => void;
    maxAuto?: number;
  }) => { run: () => void; success: () => void; fail: () => void; reset: () => void };
};

let api: RetryApi;

beforeAll(() => {
  const harness = { exports: {} as RetryApi };
  new Function("module", "exports", WIDGET_RETRY_JS)(harness, harness.exports);
  api = harness.exports;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("backoffDelay", () => {
  it("grows exponentially from the base and caps at maxDelayMs", () => {
    const min = (failures: number) => api.backoffDelay(failures, api.POLICY.baseMs, () => 0);
    expect(min(0)).toBe(1000); // 2000 * 0.5 (fastest jitter shrinks)
    expect(min(1)).toBe(2000);
    expect(min(2)).toBe(4000);
    expect(min(10)).toBe(15000); // capped at 30000 * 0.5
  });

  it("stays inside the jitter band [0.5x, 1.5x)", () => {
    expect(api.backoffDelay(0, 2000, () => 0)).toBe(1000);
    expect(api.backoffDelay(0, 2000, () => 0.999)).toBe(2998);
    expect(api.backoffDelay(0, 4000, () => 0.5)).toBe(4000);
  });

  it("supports a different base for the polling fallback", () => {
    expect(api.backoffDelay(0, api.POLICY.pollBaseMs, () => 0)).toBe(2000);
    expect(api.backoffDelay(2, api.POLICY.pollBaseMs, () => 0)).toBe(8000);
  });
});

type Controller = ReturnType<RetryApi["createRetry"]>;

/**
 * Lets an attempt reference its own controller (fail/success) without a
 * self-referential let: the bound methods arrive via the box.
 */
function harness(opts: {
  onAttempt: (controller: Controller) => void;
  gaveUp?: () => void;
}) {
  const box: { controller: Controller | null } = { controller: null };
  const controller = api.createRetry({
    attempt: () => {
      const bound = box.controller;
      if (bound) opts.onAttempt(bound);
    },
    gaveUp: opts.gaveUp ?? (() => {}),
  });
  box.controller = controller;
  return controller;
}

describe("createRetry", () => {
  it("retries with backoff, then gives up once at the cap", () => {
    const gaveUp = vi.fn();
    const attempts: number[] = [];
    const controller = harness({
      onAttempt: (ctl) => {
        attempts.push(Date.now());
        ctl.fail();
      },
      gaveUp,
    });
    controller.run();
    vi.advanceTimersByTime(60_000);
    expect(attempts.length).toBe(1 + api.POLICY.maxAutoRetries);
    expect(gaveUp).toHaveBeenCalledTimes(1);
    // Further fail() calls after give-up are ignored.
    controller.fail();
    vi.advanceTimersByTime(60_000);
    expect(attempts.length).toBe(1 + api.POLICY.maxAutoRetries);
    expect(gaveUp).toHaveBeenCalledTimes(1);
  });

  it("success() resets the failure counter after a good attempt", () => {
    const gaveUp = vi.fn();
    let failFirst = true;
    const controller = harness({
      onAttempt: (ctl) => {
        if (failFirst) {
          failFirst = false;
          ctl.fail();
        } else {
          ctl.success();
        }
      },
      gaveUp,
    });
    controller.run();
    vi.advanceTimersByTime(10_000);
    expect(gaveUp).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) {
      failFirst = true;
      controller.reset();
      controller.run();
      vi.advanceTimersByTime(10_000);
    }
    expect(gaveUp).not.toHaveBeenCalled();
  });

  it("run() while a retry is pending does not start a second chain", () => {
    const attempts = vi.fn();
    const controller = harness({ onAttempt: (ctl) => { attempts(); ctl.fail(); } });
    controller.run();
    controller.run();
    vi.advanceTimersByTime(60_000);
    expect(attempts).toHaveBeenCalledTimes(1 + api.POLICY.maxAutoRetries);
  });

  it("reset() cancels a pending retry", () => {
    const attempts = vi.fn();
    const controller = harness({ onAttempt: attempts });
    controller.run();
    controller.fail();
    controller.reset();
    vi.advanceTimersByTime(60_000);
    expect(attempts).toHaveBeenCalledTimes(1);
  });

  it("pauses retries while the page is hidden and resumes on visibilitychange", () => {
    const listener: { vis?: () => void } = {};
    const doc = {
      hidden: true,
      addEventListener: (_: string, fn: () => void) => {
        listener.vis = fn;
      },
      removeEventListener: () => {},
    };
    vi.stubGlobal("document", doc);
    const attempts: number[] = [];
    const controller = harness({
      onAttempt: (ctl) => {
        attempts.push(Date.now());
        ctl.fail();
      },
    });
    controller.run();
    vi.advanceTimersByTime(120_000);
    // Timer fired while hidden: the retry must wait for visibility.
    expect(attempts.length).toBe(1);
    listener.vis?.(); // still hidden: keeps waiting
    expect(attempts.length).toBe(1);
    doc.hidden = false;
    listener.vis?.(); // page became visible again
    expect(attempts.length).toBe(2);
  });

  it("later() ignores still-hidden events, removes its listener and cancels cleanly", () => {
    const listeners: Array<() => void> = [];
    const removed: Array<() => void> = [];
    const doc = {
      hidden: true,
      addEventListener: (_: string, fn: () => void) => {
        listeners.push(fn);
      },
      removeEventListener: (_: string, fn: () => void) => {
        removed.push(fn);
      },
    };
    vi.stubGlobal("document", doc);
    const fired: number[] = [];
    const cancel = api.later(function () {
      fired.push(Date.now());
    }, 50);
    vi.advanceTimersByTime(100); // timer elapsed while hidden: wait
    expect(fired).toHaveLength(0);
    expect(listeners).toHaveLength(1);
    listeners[0](); // still hidden: ignored
    expect(fired).toHaveLength(0);
    doc.hidden = false;
    listeners[0](); // visible now: fires and detaches
    expect(fired).toHaveLength(1);
    expect(removed).toContain(listeners[0]);
    cancel(); // no-op after fire
    const fired2: number[] = [];
    const cancel2 = api.later(function () {
      fired2.push(Date.now());
    }, 50);
    cancel2();
    vi.advanceTimersByTime(100);
    expect(fired2).toHaveLength(0);
  });
});

describe("export target (PR #67 review)", () => {
  it("always sets the browser global when the host page leaks module.exports", () => {
    const hostPageWindow: { __ssWidgetRetry?: RetryApi } = {};
    const hostModule = { exports: {} };
    vi.stubGlobal("window", hostPageWindow);
    vi.stubGlobal("module", hostModule);
    new Function(WIDGET_RETRY_JS)();
    expect(hostPageWindow.__ssWidgetRetry).toBeDefined();
    expect(typeof hostPageWindow.__ssWidgetRetry?.createRetry).toBe("function");
    expect(hostPageWindow.__ssWidgetRetry?.POLICY).toEqual(api.POLICY);
    // The host page's own module.exports is not clobbered either.
    expect(hostModule.exports).toEqual({});
  });
});

describe("automatic retry rate bound (issue #57)", () => {
  /** Max requests in any `windowMs` sliding window. */
  function maxInWindow(times: number[], windowMs: number): number {
    let max = 0;
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((t) => t >= times[i] && t < times[i] + windowMs).length;
      max = Math.max(max, inWindow);
    }
    return max;
  }

  /** Worst case (fastest) jitter so delays are as short as allowed. */
  function failureTimes(opts: { baseMs: number; maxFailures: number }): number[] {
    const times: number[] = [];
    let t = 0;
    for (let failure = 0; failure <= opts.maxFailures; failure++) {
      times.push(t);
      t += api.backoffDelay(failure, opts.baseMs, () => 0);
    }
    return times;
  }

  it("session retries never exceed the per-identity session budget in any 60s window", () => {
    const times = failureTimes({ baseMs: api.POLICY.baseMs, maxFailures: api.POLICY.maxAutoRetries });
    expect(times.length).toBe(1 + api.POLICY.maxAutoRetries);
    expect(maxInWindow(times, WIDGET_RATE_LIMITS.windowMs)).toBeLessThanOrEqual(
      WIDGET_RATE_LIMITS.session,
    );
  });

  it("polling fallback never exceeds the per-identity read budget in any 60s window", () => {
    const times = failureTimes({ baseMs: api.POLICY.pollBaseMs, maxFailures: api.POLICY.pollMaxFailures });
    expect(times.length).toBe(1 + api.POLICY.pollMaxFailures);
    expect(maxInWindow(times, WIDGET_RATE_LIMITS.windowMs)).toBeLessThanOrEqual(
      WIDGET_RATE_LIMITS.read,
    );
  });

  it("a live retry controller driven to give-up stays inside the session budget", () => {
    const attempts: number[] = [];
    const controller = harness({
      onAttempt: (ctl) => {
        attempts.push(Date.now());
        ctl.fail();
      },
    });
    controller.run();
    vi.advanceTimersByTime(600_000); // 10 minutes: nothing more may fire
    expect(attempts.length).toBe(1 + api.POLICY.maxAutoRetries);
    expect(maxInWindow(attempts, WIDGET_RATE_LIMITS.windowMs)).toBeLessThanOrEqual(
      WIDGET_RATE_LIMITS.session,
    );
  });
});
