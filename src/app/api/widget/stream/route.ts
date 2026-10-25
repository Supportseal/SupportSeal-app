import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { subscribeToConversationEvents } from "@/lib/events";
import { rateLimitWidgetRequest } from "@/lib/widget-rate-limit";
import {
  isWidgetOriginAllowed,
  loadWidgetProduct,
  resolveVisitorSession,
  serviceOriginFrom,
  sessionOriginMatches,
  visitorTokenFromRequest,
} from "@/lib/widget";

export const dynamic = "force-dynamic";

const TICK_MS = 2000;
const HEARTBEAT_MS = 15_000;

/**
 * Visitor message stream (FR-CHAT-03, ADR-0003): durable writes first, then
 * SSE delivery with a resumable timestamp cursor (`?after=<ISO>`; the client
 * resends its newest message timestamp on reconnect, so reconnects neither
 * duplicate nor lose messages). Same-process events wake the stream
 * immediately; the interval tick re-checks the database, which also covers a
 * second app process (bounded polling fallback).
 */
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key") ?? "";
  const hostParam = request.nextUrl.searchParams.get("host");
  const product = await loadWidgetProduct(key);
  if (!product) return new Response("not found", { status: 404 });

  const allowed = isWidgetOriginAllowed({
    productDomains: product.domains,
    hostParam,
    referer: request.headers.get("referer"),
    serviceOrigin: serviceOriginFrom(request.headers, request.nextUrl.origin),
    serviceIsProduction: process.env.NODE_ENV === "production",
    testToken: request.nextUrl.searchParams.get("testToken"),
    productId: product.id,
  });
  if (!allowed) return new Response("forbidden", { status: 403 });
  // Read-only reconnect budget (issue #57): generous, but a reconnect storm
  // from one visitor cannot crowd out the state-changing endpoints.
  if (!rateLimitWidgetRequest(request, "read", product.id)) {
    return new Response("rate limited", { status: 429 });
  }

  const token = visitorTokenFromRequest(request, product.id);
  const visitor = await resolveVisitorSession(product, token);
  if (!visitor || !visitor.conversationId) {
    return new Response("no session", { status: 401 });
  }
  if (!sessionOriginMatches(visitor, hostParam)) {
    return new Response("forbidden", { status: 403 });
  }
  const conversationId = visitor.conversationId;

  const afterParam = request.nextUrl.searchParams.get("after");
  let lastSentAt = afterParam ? new Date(afterParam) : new Date();
  if (Number.isNaN(lastSentAt.getTime())) lastSentAt = new Date();
  const seenIds: string[] = [];

  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let checking = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      send("ready", { conversationId });
      const unsubscribe = subscribeToConversationEvents((event) => {
        if (event.conversationId === conversationId) {
          // Low-latency wake for same-process writes; the tick covers the rest.
          void check();
        }
      });

      async function check() {
        if (closed || checking) return;
        checking = true;
        try {
          // >= plus a sent-id filter so messages sharing a millisecond with
          // the cursor are delivered, never duplicated.
          const candidates = await prisma.message.findMany({
            where: {
              conversationId,
              kind: { in: ["CUSTOMER", "AGENT"] },
              createdAt: { gte: lastSentAt },
            },
            orderBy: { createdAt: "asc" },
            take: 100,
            include: {
              attachments: {
                select: { id: true, filename: true, contentType: true, size: true },
              },
            },
          });
          const fresh = candidates.filter((m) => !seenIds.includes(m.id));
          if (fresh.length > 0) {
            for (const m of fresh) {
              seenIds.push(m.id);
              if (seenIds.length > 500) seenIds.shift();
            }
            const newest = fresh[fresh.length - 1].createdAt;
            if (newest > lastSentAt) lastSentAt = newest;
            send(
              "messages",
              fresh.map((m) => ({
                id: m.id,
                kind: m.kind,
                body: m.body,
                createdAt: m.createdAt.toISOString(),
                attachments: m.attachments.map((a) => ({
                  id: a.id,
                  filename: a.filename,
                  contentType: a.contentType,
                  size: a.size,
                })),
              })),
            );
          }
        } catch {
          // transient DB error: the next tick retries
        } finally {
          checking = false;
        }
      }

      const tick = setInterval(() => void check(), TICK_MS);
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          // A named event, not an SSE comment: EventSource hides comments
          // from scripts, and the panel's watchdog needs to see liveness.
          controller.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      cleanup = () => {
        closed = true;
        clearInterval(tick);
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      // Client went away without an abort signal.
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
