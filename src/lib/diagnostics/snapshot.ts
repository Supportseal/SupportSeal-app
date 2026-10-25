import { parseUserAgent } from "@/lib/diagnostics/user-agent";
import {
  REDACTION_LIMITS,
  redactMessage,
  redactName,
  redactPagePath,
  redactString,
  redactUrl,
} from "@/lib/diagnostics/redact";

/**
 * Server-side snapshot validation and bounding
 * (docs/design/diagnostics.md "Size bounds", "How the bans are enforced" #4).
 * Everything from the host page is untrusted: unknown fields are dropped,
 * types and lengths are checked, every string is re-redacted, and only the
 * capture-table fields survive. The server is authoritative.
 */

export type DiagFrame = { fn: string; file: string; line: number; col: number };

export type DiagEvent = {
  kind: "js_error" | "promise_rejection" | "warning" | "network";
  name?: string;
  message?: string;
  frames?: DiagFrame[];
  pagePath?: string;
  method?: string;
  url?: string;
  status?: number;
  firstSeen: number;
  lastSeen: number;
  count: number;
};

export type DiagEnvironment = {
  pageUrl: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  appVersion: string;
  browser: string;
  os: string;
};

export type NormalizedSnapshot = {
  schemaVersion: number;
  environment: DiagEnvironment;
  events: DiagEvent[];
  errorCount: number;
  warningCount: number;
  networkFailureCount: number;
  droppedCount: number;
};

export type RejectionReason = "invalid" | "too_large";

export const DIAGNOSTICS_LIMITS = {
  maxEvents: 50,
  windowMs: 30 * 60 * 1000,
  maxSnapshotBytes: 32 * 1024,
  maxIncomingEvents: 500,
  maxDroppedCount: 10_000,
} as const;

export type NormalizeResult =
  | { ok: true; snapshot: NormalizedSnapshot }
  | { ok: false; reason: RejectionReason };

const EVENT_KINDS = new Set(["js_error", "promise_rejection", "warning", "network"]);

function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/** devicePixelRatio is fractional (1.25, 1.5 …) — its own bounded number. */
function boundedFloat(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/** Strings are trimmed, never rejected for length (DX-07); garbage types are. */
function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, max * 4);
}

/** App version from the visitor's stored developer context, copied at attach time. */
function appVersionFromContext(devContext: unknown): string {
  if (devContext && typeof devContext === "object" && !Array.isArray(devContext)) {
    const context = devContext as Record<string, unknown>;
    for (const key of ["appVersion", "buildVersion", "version"]) {
      const match = Object.entries(context).find(
        ([entryKey]) => entryKey.toLowerCase() === key.toLowerCase(),
      );
      const value = match?.[1];
      if (typeof value === "string" && value.trim()) {
        return redactString(value).slice(0, REDACTION_LIMITS.appVersion) || "Not provided";
      }
    }
  }
  return "Not provided";
}

function normalizeFrames(input: unknown): DiagFrame[] | null {
  if (!Array.isArray(input)) return null;
  const frames: DiagFrame[] = [];
  for (const raw of input.slice(0, REDACTION_LIMITS.stackFrames * 2)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const frame = raw as Record<string, unknown>;
    const fn = boundedString(frame.fn, REDACTION_LIMITS.frameFn);
    const file = boundedString(frame.file, REDACTION_LIMITS.url);
    const line = boundedInt(frame.line, 0, 1_000_000_000);
    const col = boundedInt(frame.col, 0, 1_000_000_000);
    if (fn === null || file === null || line === null || col === null) return null;
    frames.push({
      fn: redactName(fn).slice(0, REDACTION_LIMITS.frameFn),
      file: redactUrl(file),
      line,
      col,
    });
    if (frames.length >= REDACTION_LIMITS.stackFrames) break;
  }
  // Stack bound: 2,000 serialized characters, dropping trailing frames.
  while (frames.length > 0 && JSON.stringify(frames).length > REDACTION_LIMITS.stackChars) {
    frames.pop();
  }
  return frames;
}

function normalizeEvent(raw: unknown, now: number, pageBaseUrl: string): DiagEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  const kind = event.kind;
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind)) return null;
  const firstSeen = boundedInt(event.firstSeen, 0, now + 5 * 60 * 1000);
  const lastSeen = boundedInt(event.lastSeen, 0, now + 5 * 60 * 1000);
  const count = boundedInt(event.count, 1, 10_000);
  if (firstSeen === null || lastSeen === null || count === null) return null;

  const base = { firstSeen, lastSeen, count };
  if (kind === "network") {
    const methodRaw = boundedString(event.method, REDACTION_LIMITS.method);
    const urlRaw = boundedString(event.url, REDACTION_LIMITS.url);
    const status = boundedInt(event.status, 0, 599);
    if (methodRaw === null || urlRaw === null || status === null) return null;
    // Relative URLs are resolved against the page before redaction.
    let url = urlRaw;
    try {
      url = new URL(urlRaw, pageBaseUrl).href;
    } catch {
      // keep as-is; redaction still applies
    }
    return {
      kind,
      method: redactString(methodRaw).toUpperCase().slice(0, REDACTION_LIMITS.method),
      url: redactUrl(url),
      status,
      ...base,
    };
  }
  const message = boundedString(event.message, REDACTION_LIMITS.message);
  if (message === null) return null;
  const pagePath = boundedString(event.pagePath, REDACTION_LIMITS.pagePath);
  if (kind === "warning") {
    return {
      kind,
      message: redactMessage(message),
      ...(pagePath !== null ? { pagePath: redactPagePath(pagePath) } : {}),
      ...base,
    };
  }
  const name = boundedString(event.name, REDACTION_LIMITS.name);
  const frames = normalizeFrames(event.frames ?? []);
  if (name === null || frames === null) return null;
  return {
    kind: kind as "js_error" | "promise_rejection",
    name: redactName(name),
    message: redactMessage(message),
    frames,
    ...(pagePath !== null ? { pagePath: redactPagePath(pagePath) } : {}),
    ...base,
  };
}

function snapshotBytes(environment: DiagEnvironment, events: DiagEvent[]): number {
  return Buffer.byteLength(JSON.stringify({ environment, events }), "utf8");
}

/**
 * Validate, re-redact and bound a client snapshot. Never throws: garbage in
 * yields `{ ok: false, reason }`, never a message rejection.
 */
export function normalizeSnapshot(
  input: unknown,
  options: { userAgent: string; devContext: unknown; now?: Date },
): NormalizeResult {
  const now = (options.now ?? new Date()).getTime();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "invalid" };
  }
  const payload = input as Record<string, unknown>;
  const envRaw = payload.environment;
  if (!envRaw || typeof envRaw !== "object" || Array.isArray(envRaw)) {
    return { ok: false, reason: "invalid" };
  }
  const env = envRaw as Record<string, unknown>;
  const pageUrl = boundedString(env.pageUrl, REDACTION_LIMITS.url);
  const viewportWidth = boundedInt(env.viewportWidth, 0, 100_000);
  const viewportHeight = boundedInt(env.viewportHeight, 0, 100_000);
  const devicePixelRatio = boundedFloat(env.devicePixelRatio, 0.1, 20);
  if (
    pageUrl === null ||
    viewportWidth === null ||
    viewportHeight === null ||
    devicePixelRatio === null
  ) {
    return { ok: false, reason: "invalid" };
  }
  const clientDropped = boundedInt(payload.droppedCount, 0, DIAGNOSTICS_LIMITS.maxDroppedCount) ?? 0;
  const incoming = Array.isArray(payload.events) ? payload.events : null;
  if (incoming === null) return { ok: false, reason: "invalid" };

  const environment: DiagEnvironment = {
    pageUrl: redactUrl(pageUrl),
    viewportWidth,
    viewportHeight,
    devicePixelRatio,
    appVersion: appVersionFromContext(options.devContext),
    ...parseUserAgent(options.userAgent),
  };

  // Bound the incoming array before per-event work (hostile payloads).
  const considered = incoming.slice(0, DIAGNOSTICS_LIMITS.maxIncomingEvents);
  let dropped =
    clientDropped + Math.max(0, incoming.length - DIAGNOSTICS_LIMITS.maxIncomingEvents);

  const events: DiagEvent[] = [];
  for (const raw of considered) {
    const event = normalizeEvent(raw, now, environment.pageUrl);
    if (!event) {
      dropped++;
      continue;
    }
    if (now - event.lastSeen > DIAGNOSTICS_LIMITS.windowMs) {
      dropped++; // outside the 30-minute window
      continue;
    }
    events.push(event);
  }
  // At most 50 events, oldest dropped first (client sends oldest-first).
  if (events.length > DIAGNOSTICS_LIMITS.maxEvents) {
    dropped += events.length - DIAGNOSTICS_LIMITS.maxEvents;
    events.splice(0, events.length - DIAGNOSTICS_LIMITS.maxEvents);
  }

  // 32 KB serialized: trim oldest events to fit; reject only when a single
  // remaining event cannot fit.
  while (events.length > 0 && snapshotBytes(environment, events) > DIAGNOSTICS_LIMITS.maxSnapshotBytes) {
    if (events.length === 1) return { ok: false, reason: "too_large" };
    dropped++;
    events.shift();
  }

  const snapshot: NormalizedSnapshot = {
    schemaVersion: 1,
    environment,
    events,
    errorCount: events.filter((e) => e.kind === "js_error" || e.kind === "promise_rejection").length,
    warningCount: events.filter((e) => e.kind === "warning").length,
    networkFailureCount: events.filter((e) => e.kind === "network").length,
    droppedCount: Math.min(dropped, DIAGNOSTICS_LIMITS.maxDroppedCount),
  };
  return { ok: true, snapshot };
}
