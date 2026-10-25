import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { subscribeToConversationEvents } from "@/lib/events";
import { getPrimaryMembership } from "@/lib/workspace";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const DB_TICK_MS = 10_000;

/**
 * Workspace conversation stream for the agent inbox (FR-CHAT-03, ADR-0003):
 * emits `{conversationId, kind}` whenever a conversation in the caller's
 * Workspace changes (message/status). The client refetches on event — the
 * list stays correct even across processes thanks to the refetch.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const membership = await getPrimaryMembership(user.id);
  if (!membership) return new Response("forbidden", { status: 403 });
  const workspaceId = membership.workspaceId;

  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
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

      send("ready", { workspaceId });

      const unsubscribe = subscribeToConversationEvents((event) => {
        if (event.workspaceId === workspaceId) {
          send("conversation", { conversationId: event.conversationId, kind: event.kind });
        }
      });

      // Slow database tick: wakes the inbox when another app process wrote
      // (its events never reach this process's bus). The baseline is seeded
      // at connect: a null baseline on the first tick would silently swallow
      // every write that lands between connect and the first tick
      // (ADR-0003 spike finding, issue #2).
      const readSignature = async (): Promise<string> => {
        const rows = await prisma.conversation.findMany({
          where: { workspaceId },
          orderBy: { updatedAt: "desc" },
          take: 20,
          select: { id: true, updatedAt: true },
        });
        return rows.map((r) => `${r.id}:${r.updatedAt.getTime()}`).join("|");
      };
      let lastSignature: string | null = null;
      void readSignature()
        .then((signature) => {
          lastSignature ??= signature;
        })
        .catch(() => {
          // transient DB error: the first tick seeds the baseline instead
        });
      const dbTick = setInterval(async () => {
        if (closed) return;
        try {
          const signature = await readSignature();
          if (lastSignature !== null && signature !== lastSignature) {
            send("conversation", { conversationId: "*", kind: "refresh" });
          }
          lastSignature = signature;
        } catch {
          // transient DB error: retry next tick
        }
      }, DB_TICK_MS);

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          // A named event, not an SSE comment: EventSource never exposes
          // comments to scripts and the desk's watchdog needs to see liveness.
          controller.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        clearInterval(dbTick);
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
