"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { format, isSameDay } from "date-fns";
import {
  IconArrowLeft,
  IconChevronDown,
  IconLock,
  IconMail,
  IconMessage2,
  IconMessageCircle,
  IconLayoutSidebarRight,
  IconPaperclip,
} from "@tabler/icons-react";

import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { ProductChip } from "@/components/product-identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@radix-ui/react-popover";

import { Spinner } from "@/components/ui/spinner";
import {
  findSlashToken,
  SavedReplyPopoverBody,
  SavedReplyResults,
  savedReplyOptionId,
  usePaletteNav,
  type PaletteReply,
} from "./saved-reply-palette";
import { SaveReplyModal } from "./save-reply-modal";
import { UNREAD_REFRESH_EVENT } from "@/components/layout/unread-title";
import { UNREAD_MARK_BATCH } from "@/lib/unread-shared";

import { ContextSection } from "./context-section";
import {
  DiagnosticsChip,
  DiagnosticsSection,
  SnapshotSheet,
  type DiagSnapshotView,
} from "./diagnostics-panel";
import { toast } from "sonner";
import { formatFileSize } from "@/lib/format";
import { formatTicketRef } from "@/lib/ticket";
import {
  nextConversationAfterCloseLoading,
  noteConversationStatus,
  closeExitDelay,
} from "@/lib/inbox-advance";
import { connectInboxStream } from "@/lib/inbox-stream-client";
import { broadcastNotifyKick } from "@/lib/notifications/client";
import { visitorLabel } from "../list-pane";
import { addTagAction, removeTagAction, sendMessageAction, setStatusAction } from "../actions";

type Message = {
  id: string;
  kind: "CUSTOMER" | "AGENT" | "NOTE";
  body: string;
  createdAt: string;
  authorName: string | null;
  /** Channel this message was written through; null = unknown (old rows, notes, undecided routing). */
  channel: "CHAT" | "EMAIL" | null;
  attachments?: Array<{ id: string; filename: string; contentType: string; size: number }>;
};

export type ConversationViewData = {
  id: string;
  ticketNumber: number;
  status: "OPEN" | "PENDING" | "CLOSED";
  channel: "CHAT" | "EMAIL";
  subject: string | null;
  createdAt: string;
  contact: { id: string; name: string | null; email: string | null };
  /** Email the chat visitor entered; may differ from the contact's (takeover guard). */
  visitorEmail: string | null;
  product: { id: string; name: string; primaryColor: string };
  productArchived: boolean;
  tags: { id: string; name: string }[];
  messages: Message[];
};

export type DevContextProp = {
  identifiedUserId: string | null;
  entries: Array<{ key: string; value: string; updatedAt: string | null }>;
};

export type DiagnosticsProp = {
  enabled: boolean;
  snapshots: DiagSnapshotView[];
  hasExpired: boolean;
};

const STATUS_META = {
  OPEN: { label: "Open", color: "primary" as const },
  PENDING: { label: "Pending", color: "warning" as const },
  CLOSED: { label: "Closed", color: "secondary" as const },
};

/** Agent-readable reason for a failed upload. 400 carries the validation message. */
function uploadFailureReason(status: number, error?: string): string {
  if (status === 400 && error && error !== "bad_request") return error;
  if (status === 401 || status === 403) return "You are not allowed to attach files here.";
  if (status === 404) return "This conversation no longer exists.";
  if (status >= 500) return "The server could not store the file. Try again.";
  return "Upload failed. Try again.";
}

function DaySeparator({ date }: { date: string }) {
  return (
    <div className="my-3 flex items-center gap-3" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted">{format(new Date(date), "EEE d MMM")}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function ConversationView({
  conversation,
  availableTags,
  savedReplies,
  canManageSavedReplies,
  savedReplyProducts,
  devContext,
  diagnostics,
  failedDeliveryCount = 0,
}: {
  conversation: ConversationViewData;
  availableTags: { id: string; name: string }[];
  /** This conversation's offered saved replies (All-products + this Product). */
  savedReplies: PaletteReply[];
  canManageSavedReplies: boolean;
  /** Product options for the Save-reply modal (admins only). */
  savedReplyProducts: { id: string; name: string }[];
  devContext: DevContextProp;
  diagnostics: DiagnosticsProp;
  failedDeliveryCount?: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"REPLY" | "NOTE">("REPLY");
  const [body, setBody] = useState("");
  // Whether the draft used a saved reply, for the reply_sent event.
  const usedSavedReply = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const [saveReplyOpen, setSaveReplyOpen] = useState(false);
  const [saveReplySession, setSaveReplySession] = useState(0);
  const [slash, setSlash] = useState<{ start: number; query: string } | null>(null);
  const slashId = useId();
  const [attachments, setAttachments] = useState<
    Array<{ id: string; filename: string; size: number }>
  >([]);
  const [uploading, setUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  // Set while the closed thread animates out ahead of the next one opening.
  const [leavingId, setLeavingId] = useState<string | null>(null);
  // The exit state belongs to one conversation: once the view shows another,
  // drop it so returning (Undo, Back) never replays the exit.
  if (leavingId !== null && leavingId !== conversation.id) setLeavingId(null);
  const leaving = leavingId === conversation.id;
  const [openSnapshot, setOpenSnapshot] = useState<DiagSnapshotView | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const lastLength = conversation.messages.length;

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastLength]);

  // Keep the newest message in view when the thread pane shrinks (a phone
  // keyboard opening, the composer growing), unless the agent scrolled up.
  useEffect(() => {
    const el = threadRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let atBottom = true;
    const onScroll = () => {
      atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    const observer = new ResizeObserver(() => {
      if (atBottom) el.scrollTop = el.scrollHeight;
    });
    el.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
    // The thread root is re-keyed per conversation, so follow its element.
  }, [conversation.id]);

  const contactLabel = useMemo(() => visitorLabel(conversation.contact), [conversation.contact]);

  // Saved replies (FR-INBOX-02): `/` at the start of a line and the Saved
  // button share one palette. Insertion never sends; focus and caret return
  // to the composer after the new text.
  const slashToken =
    slash && mode === "REPLY" && savedReplies.length > 0 && body.startsWith(`/${slash.query}`, slash.start)
      ? slash
      : null;
  const slashNav = usePaletteNav(savedReplies, slashToken?.query ?? "");

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
  }, [body]);

  function insertSavedReply(reply: PaletteReply, range: { start: number; end: number }) {
    pendingCaret.current = range.start + reply.body.length;
    setBody((current) => current.slice(0, range.start) + reply.body + current.slice(range.end));
    usedSavedReply.current = true;
    track("saved_reply_inserted");
    setSlash(null);
    setSavedOpen(false);
  }

  function syncSlash(target: HTMLTextAreaElement) {
    setSlash(
      mode === "REPLY" && savedReplies.length > 0
        ? findSlashToken(target.value, target.selectionStart)
        : null,
    );
  }

  // Realtime: server-rendered thread stays fresh when this conversation
  // changes (new messages, status changes by other agents).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 300);
    };
    const disconnect = connectInboxStream({
      onConversation: (event) => {
        broadcastNotifyKick();
        // "*" = cross-process refresh tick; refresh the open thread too.
        if (event.conversationId === "*" || event.conversationId === conversation.id) {
          scheduleRefresh();
        }
      },
      // Back after a dropped stream: the thread may have changed meanwhile.
      onResync: scheduleRefresh,
    });
    return () => {
      disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [conversation.id, router]);

  // Mark displayed CUSTOMER messages read only while this tab is visible.
  // Batches stop when the tab hides or the effect is cancelled; succeeded
  // batches still refresh the count (break, so those IDs are not discarded).
  const markedReadRef = useRef<Set<string>>(new Set());
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") setFocusTick((tick) => tick + 1);
    };
    const onFocus = () => setFocusTick((tick) => tick + 1);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (document.visibilityState !== "visible") return;
    const displayed = conversation.messages
      .filter((message) => message.kind === "CUSTOMER" && !markedReadRef.current.has(message.id))
      .map((message) => message.id);
    if (displayed.length === 0) return;
    let cancelled = false;
    void (async () => {
      const succeeded: string[] = [];
      let failed = false;
      for (let offset = 0; offset < displayed.length && !failed; offset += UNREAD_MARK_BATCH) {
        if (document.visibilityState !== "visible") break;
        const batch = displayed.slice(offset, offset + UNREAD_MARK_BATCH);
        try {
          const response = await fetch("/api/inbox/unread/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conversation.id, messageIds: batch }),
          });
          if (!response.ok) throw new Error(`mark-read failed (${response.status})`);
          succeeded.push(...batch);
        } catch {
          failed = true;
        }
        if (cancelled) break;
      }
      for (const id of succeeded) markedReadRef.current.add(id);
      if (succeeded.length > 0) {
        window.dispatchEvent(new CustomEvent(UNREAD_REFRESH_EVENT));
      }
      if (failed && !cancelled) {
        toast.error("Could not mark messages as read — retrying when you next focus this tab.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation.id, conversation.messages, focusTick]);

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadErrors([]);
    try {
      await uploadFilesInner(files);
    } finally {
      setUploading(false);
    }
  }

  async function uploadFilesInner(files: FileList) {
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      form.append("conversationId", conversation.id);
      let failure: string | null = null;
      let failedStatus = 0;
      try {
        const response = await fetch("/api/inbox/attachments", { method: "POST", body: form });
        failedStatus = response.status;
        const data = (await response.json().catch(() => null)) as
          | { attachment?: { id: string; filename: string; size: number }; error?: string }
          | null;
        if (data?.attachment) {
          setAttachments((current) => [...current, data.attachment!]);
        } else {
          failure = uploadFailureReason(response.status, data?.error);
        }
      } catch {
        failure = "Network error. Check your connection and try again.";
      }
      if (failure) {
        const message = `${file.name} was not attached: ${failure}`;
        setUploadErrors((current) => [...current, message]);
        track("attachment_failed", { status: failedStatus });
        toast.error(message);
      }
    }
  }

  async function send() {
    const text = body.trim();
    if ((!text && attachments.length === 0) || sending) return;
    setSending(true);
    const result = await sendMessageAction({
      conversationId: conversation.id,
      body: text || "(attachment)",
      kind: mode === "NOTE" ? "NOTE" : "AGENT",
      attachmentIds: attachments.map((a) => a.id),
    });
    setSending(false);
    const kind = mode === "NOTE" ? "note" : "reply";
    if (result.error) {
      track("reply_failed", { kind });
      toast.error(result.error);
      return;
    }
    track("reply_sent", {
      kind,
      channel: conversation.channel === "CHAT" ? "chat" : "email",
      saved_reply: usedSavedReply.current,
      attachments: attachments.length,
    });
    usedSavedReply.current = false;
    setBody("");
    setAttachments([]);
    setUploadErrors([]);
    startTransition(() => router.refresh());
  }

  function changeStatus(status: "OPEN" | "PENDING" | "CLOSED") {
    const previous = conversation.status;
    // Closing moves on to the next conversation in the tab's order (#199)
    // rather than leaving the agent on a finished thread. The target is
    // picked before the save: the live list drops this row as soon as the
    // status change lands. When the closed row is the loaded tail, the next
    // page is fetched first; when it was truly last, the empty state shows,
    // and when the next page can't be loaded the agent stays on this thread.
    const advance = status === "CLOSED" && conversation.status !== "CLOSED";
    const query = searchParams.size ? `?${searchParams.toString()}` : "";
    const reopenHref = `/inbox/${conversation.id}${query}`;
    startTransition(async () => {
      const target = advance ? await nextConversationAfterCloseLoading(conversation.id) : null;
      // Slide the thread out while the save runs, only when a next one follows.
      const exiting = target?.kind === "next" || target?.kind === "last";
      if (exiting) setLeavingId(conversation.id);
      const exited = exiting ? closeExitDelay() : Promise.resolve();
      // Without a known next conversation the agent stays on the closed one.
      const advancePath = target?.kind === "next" ? `/inbox/${target.id}` : target?.kind === "last" ? "/inbox" : null;
      const result = await setStatusAction({ conversationId: conversation.id, status }).catch(() => ({
        error: "Couldn't update the conversation. Check your connection and try again.",
      }));
      if (result.error) {
        setLeavingId(null);
        toast.error(result.error);
        return;
      }
      track("conversation_status_changed", { status: status.toLowerCase(), from: "thread" });
      await exited;
      noteConversationStatus(conversation.id, status);
      // One shared id: closing top-down replaces the toast instead of
      // stacking them over the header's Close button.
      toast(`Moved to ${STATUS_META[status].label}`, {
        id: "conversation-status",
        description: target?.kind === "unavailable"
          ? "Couldn't load the next conversation. Pick one from the list."
          : undefined,
        action: {
          label: "Undo",
          onClick: () => {
            void setStatusAction({ conversationId: conversation.id, status: previous }).then((undone) => {
              if (undone.error) {
                toast.error(undone.error);
                return;
              }
              noteConversationStatus(conversation.id, previous);
              // Only pull the agent back if they are still where Close left them.
              if (advancePath && window.location.pathname === advancePath) {
                router.push(reopenHref);
              } else {
                router.refresh();
              }
            });
          },
        },
      });
      // Skip the jump if the agent already navigated away while the action ran.
      if (advancePath && window.location.pathname === `/inbox/${conversation.id}`) {
        router.push(`${advancePath}${query}`);
      } else {
        setLeavingId(null);
        router.refresh();
      }
    });
  }

  return (
    <div
      key={conversation.id}
      className={cn("flex min-h-0 min-w-0 flex-1", leaving ? "thread-exit" : "thread-enter")}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            variant="text"
            color="secondary"
            size="sm"
            iconOnly
            className="lg:hidden"
            aria-label="Back to inbox"
            onClick={() => router.push("/inbox")}
          >
            <IconArrowLeft className="size-5" />
          </Button>
          {/* Phones stack the reference under the name so neither is cut to "Priya Na…". */}
          <div className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
            <span className="min-w-0 truncate text-sm font-medium leading-tight text-heading sm:text-base">
              {contactLabel}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted sm:text-sm">
              <span className="shrink-0 tabular-nums" data-testid="ticket-ref">
                {formatTicketRef(conversation.ticketNumber)}
              </span>
              <span className="truncate sm:hidden">· {conversation.product.name}</span>
            </span>
          </div>
          <ProductChip
            name={conversation.product.name}
            color={conversation.product.primaryColor}
            className="hidden sm:inline-flex"
          />
          <div className="ms-auto flex shrink-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="text" color="secondary" size="sm">
                  <Badge variant="light" color={STATUS_META[conversation.status].color}>
                    {STATUS_META[conversation.status].label}
                  </Badge>
                  <IconChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(Object.keys(STATUS_META) as Array<keyof typeof STATUS_META>).map((status) => (
                  <DropdownMenuItem key={status} onSelect={() => changeStatus(status)}>
                    {STATUS_META[status].label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {conversation.status !== "CLOSED" ? (
              <Button variant="solid" color="primary" size="sm" onClick={() => changeStatus("CLOSED")} disabled={pending}>
                Close
              </Button>
            ) : (
              <Button variant="solid" color="primary" size="sm" onClick={() => changeStatus("OPEN")} disabled={pending}>
                Reopen
              </Button>
            )}
            <Button
              variant="text"
              color="secondary"
              size="sm"
              iconOnly
              className="xl:hidden"
              aria-label="Show context"
              onClick={() => setContextOpen(true)}
            >
              <IconLayoutSidebarRight className="size-5" />
            </Button>
          </div>
        </header>

        {failedDeliveryCount > 0 ? (
          <p className="border-b border-border bg-danger-label px-4 py-2 text-sm text-danger">
            {failedDeliveryCount} email {failedDeliveryCount === 1 ? "reply" : "replies"} could not be
            delivered — the thread is still here; retry from your mail provider or reply again.
          </p>
        ) : null}
        <div
          ref={threadRef}
          className="min-h-0 flex-1 space-y-2 overflow-x-hidden overflow-y-auto p-4"
          role="log"
          aria-live="polite"
        >
          {conversation.messages.map((message, index) => {
            const previous = conversation.messages[index - 1];
            const showDay =
              !previous || !isSameDay(new Date(previous.createdAt), new Date(message.createdAt));
            return (
              <div key={message.id}>
                {showDay ? <DaySeparator date={message.createdAt} /> : null}
                <MessageBubble
                  message={message}
                  snapshot={
                    diagnostics.snapshots.find((s) => s.messageId === message.id) ?? null
                  }
                  onOpenSnapshot={setOpenSnapshot}
                />
              </div>
            );
          })}
        </div>

        {conversation.productArchived ? (
          <div className="shrink-0 border-t border-border bg-secondary-label p-3 text-sm text-body">
            {conversation.product.name} is archived. Incoming email bounces and new chats are
            blocked. Unarchive it in Product settings to reply. Notes, tags and status changes
            still work.
          </div>
        ) : (
        <div
          className={cn(
            "shrink-0 border-t border-border p-3",
            mode === "NOTE" && "bg-warning-label",
          )}
        >
          <div className="mb-2 flex items-center gap-3">
            <div className="flex gap-1" role="tablist" aria-label="Composer mode">
              {(
                [
                  { id: "REPLY", label: "Reply" },
                  { id: "NOTE", label: "Note" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === tab.id}
                  onClick={() => setMode(tab.id)}
                  className={cn(
                    "-mb-px border-b-2 px-2 py-1 text-sm",
                    mode === tab.id
                      ? "border-primary font-medium text-heading"
                      : "border-transparent text-body hover:text-heading",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {mode === "NOTE" ? (
              <span className="flex items-center gap-1 text-xs text-warning">
                <IconLock className="size-3.5" />
                Internal note — never sent to the customer
              </span>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void uploadFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <Button
              variant="text"
              color="secondary"
              size="xs"
              iconOnly
              aria-label="Attach files"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? <Spinner className="size-4" /> : <IconPaperclip className="size-4" />}
            </Button>
            {mode === "REPLY" ? (
              <Popover open={savedOpen} onOpenChange={setSavedOpen}>
                <PopoverTrigger asChild>
                  <Button variant="text" size="xs" className="ms-auto">
                    <IconMessage2 className="size-4" />
                    Saved
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="z-50 w-80 rounded-lg border border-border bg-surface p-2 shadow-menu"
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    textareaRef.current?.focus();
                  }}
                >
                  <SavedReplyPopoverBody
                    replies={savedReplies}
                    canManage={canManageSavedReplies}
                    onPick={(reply) =>
                      insertSavedReply(reply, {
                        start: textareaRef.current?.selectionStart ?? body.length,
                        end: textareaRef.current?.selectionEnd ?? body.length,
                      })
                    }
                  />
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
          {uploadErrors.length > 0 ? (
            <div
              role="alert"
              className="mb-2 flex items-start justify-between gap-2 rounded-md border border-danger px-2 py-1 text-xs text-danger"
            >
              <ul>
                {uploadErrors.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
              <button
                type="button"
                aria-label="Dismiss upload errors"
                onClick={() => setUploadErrors([])}
              >
                ×
              </button>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((attachment, index) => (
                <span
                  key={attachment.id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-heading"
                >
                  {attachment.filename}
                  <span className="text-muted">{formatFileSize(attachment.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.filename}`}
                    className="text-muted hover:text-danger"
                    onClick={() =>
                      setAttachments((current) => current.filter((_, i) => i !== index))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="relative">
          {slashToken ? (
            <div
              className="absolute inset-x-0 bottom-full z-50 mb-1 rounded-lg border border-border bg-surface p-2 shadow-menu"
              onMouseDown={(event) => event.preventDefault()}
            >
              <SavedReplyResults
                listId={slashId}
                results={slashNav.results}
                active={slashNav.active}
                onActivate={slashNav.setActive}
                onPick={(reply) =>
                  insertSavedReply(reply, {
                    start: slashToken.start,
                    end: slashToken.start + 1 + slashToken.query.length,
                  })
                }
              />
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              syncSlash(event.target);
            }}
            onClick={(event) => syncSlash(event.currentTarget)}
            onBlur={() => setSlash(null)}
            onKeyUp={(event) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                syncSlash(event.currentTarget);
              }
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void send();
                return;
              }
              if (slashToken) {
                slashNav.handleKey(event, {
                  onPick: (reply) =>
                    insertSavedReply(reply, {
                      start: slashToken.start,
                      end: slashToken.start + 1 + slashToken.query.length,
                    }),
                  onEscape: () => setSlash(null),
                });
              }
            }}
            role={slashToken ? "combobox" : undefined}
            aria-expanded={slashToken ? true : undefined}
            aria-controls={slashToken ? slashId : undefined}
            aria-activedescendant={
              slashToken && slashNav.results[slashNav.active]
                ? savedReplyOptionId(slashId, slashNav.results[slashNav.active])
                : undefined
            }
            rows={2}
            placeholder={
              mode === "NOTE"
                ? "Add an internal note (not sent to the customer)"
                : "Write a reply… (/ for saved replies, Ctrl+Enter to send)"
            }
            aria-label={mode === "NOTE" ? "Internal note" : `Reply to ${contactLabel}`}
            // Grows with the text (where supported) but never past a third of the
            // screen, so the thread stays readable with a phone keyboard open.
            className="max-h-[33dvh] min-h-16 w-full resize-none rounded-md border border-border-strong bg-surface p-2.5 text-sm text-heading [field-sizing:content] placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary sm:min-h-[5.5rem]"
          />
          </div>
          <div className="mt-2 flex items-center gap-2">
            {conversation.status === "CLOSED" ? (
              <span className="text-xs text-muted">Sending reopens this conversation</span>
            ) : null}
            <div className="ms-auto flex items-center gap-2">
              {mode === "REPLY" && canManageSavedReplies ? (
                <Button
                  variant="outline"
                  color="secondary"
                  size="sm"
                  onClick={() => {
                    setSaveReplySession((session) => session + 1);
                    setSaveReplyOpen(true);
                  }}
                  disabled={!body.trim()}
                >
                  Save reply
                </Button>
              ) : null}
              <Button
                size="sm"
                onClick={() => void send()}
                disabled={sending || uploading || (!body.trim() && attachments.length === 0)}
              >
                {sending ? "Sending…" : mode === "NOTE" ? "Add note" : "Send"}
              </Button>
            </div>
          </div>
        </div>
        )}
      </div>

      <aside className="hidden w-80 shrink-0 overflow-y-auto border-s border-border bg-surface xl:block">
        <ContextPanel
          conversation={conversation}
          contactLabel={contactLabel}
          availableTags={availableTags}
          devContext={devContext}
          diagnostics={diagnostics}
          onOpenSnapshot={setOpenSnapshot}
        />
      </aside>

      {contextOpen ? (
        <div className="fixed inset-0 z-50 xl:hidden" role="dialog" aria-label="Conversation context">
          <div className="absolute inset-0 bg-black/40" onClick={() => setContextOpen(false)} />
          <div className="absolute inset-y-0 end-0 w-[22rem] max-w-full overflow-y-auto bg-surface p-4 shadow-menu">
            <button
              type="button"
              className="mb-2 text-sm text-primary"
              onClick={() => setContextOpen(false)}
            >
              Close
            </button>
            <ContextPanel
              conversation={conversation}
              contactLabel={contactLabel}
              availableTags={availableTags}
              devContext={devContext}
              diagnostics={diagnostics}
              onOpenSnapshot={setOpenSnapshot}
            />
          </div>
        </div>
      ) : null}

      <SnapshotSheet
        snapshot={openSnapshot}
        onOpenChange={(open) => {
          if (!open) setOpenSnapshot(null);
        }}
      />

      <SaveReplyModal
        key={saveReplySession}
        open={saveReplyOpen}
        onOpenChange={setSaveReplyOpen}
        draft={body}
        products={savedReplyProducts}
        // Refresh so the palette (`/` and Saved button) offers the new reply.
        onSaved={() => startTransition(() => router.refresh())}
      />
    </div>
  );
}

/** Small origin badge (issue #128): chat vs email, labelled — never color-only. */
function ChannelBadge({ channel }: { channel: "CHAT" | "EMAIL" | null }) {
  if (!channel) return null;
  const label = channel === "EMAIL" ? "Sent via email" : "Sent via chat";
  return channel === "EMAIL" ? (
    <IconMail className="size-3.5 shrink-0" role="img" aria-label={label} title={label} />
  ) : (
    <IconMessageCircle className="size-3.5 shrink-0" role="img" aria-label={label} title={label} />
  );
}

function MessageBubble({
  message,
  snapshot,
  onOpenSnapshot,
}: {
  message: Message;
  snapshot: DiagSnapshotView | null;
  onOpenSnapshot: (snapshot: DiagSnapshotView) => void;
}) {
  if (message.kind === "NOTE") {
    return (
      <article
        aria-label={`Internal note by ${message.authorName ?? "agent"}`}
        className="min-w-0 rounded-lg bg-warning-label p-3 [overflow-wrap:anywhere]"
      >
        <p className="flex items-center gap-1 text-xs font-medium text-warning">
          <IconLock className="size-3.5" />
          Internal note · {message.authorName ?? "Agent"}
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm text-heading">{message.body}</p>
      </article>
    );
  }

  const isAgent = message.kind === "AGENT";
  return (
    <article
      aria-label={`${isAgent ? message.authorName ?? "Agent" : "Customer"}, ${format(
        new Date(message.createdAt),
        "p",
      )}`}
      className={cn("flex min-w-0", isAgent ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "min-w-0 max-w-[min(85%,70ch)] rounded-lg p-3 [overflow-wrap:anywhere]",
          isAgent ? "bg-primary-label" : "border border-border bg-surface",
        )}
      >
        {isAgent ? (
          <p className="text-xs font-medium text-primary">{message.authorName ?? "Agent"}</p>
        ) : null}
        <p className="whitespace-pre-wrap text-sm text-heading">{message.body}</p>
        {message.attachments && message.attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.attachments.map((attachment) =>
              attachment.contentType.startsWith("image/") ? (
                <a
                  key={attachment.id}
                  href={`/api/attachments/${attachment.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/attachments/${attachment.id}`}
                    alt={attachment.filename}
                    className="max-h-40 rounded-md border border-border"
                  />
                </a>
              ) : (
                <a
                  key={attachment.id}
                  href={`/api/attachments/${attachment.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs text-heading hover:bg-hover"
                >
                  <IconPaperclip className="size-3.5" />
                  {attachment.filename}
                  <span className="text-muted">{formatFileSize(attachment.size)}</span>
                </a>
              ),
            )}
          </div>
        ) : null}
        <p className="mt-1 flex items-center justify-end gap-1 text-right text-[0.6875rem] text-muted">
          {format(new Date(message.createdAt), "p")}
          <ChannelBadge channel={message.channel} />
        </p>
        {!isAgent && snapshot ? (
          <div className="mt-1 flex justify-start">
            <DiagnosticsChip snapshot={snapshot} onOpen={onOpenSnapshot} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ContextPanel({
  conversation,
  contactLabel,
  availableTags,
  devContext,
  diagnostics,
  onOpenSnapshot,
}: {
  conversation: ConversationViewData;
  contactLabel: string;
  availableTags: { id: string; name: string }[];
  devContext: DevContextProp;
  diagnostics: DiagnosticsProp;
  onOpenSnapshot: (snapshot: DiagSnapshotView) => void;
}) {
  const router = useRouter();
  const [tagName, setTagName] = useState("");

  async function addTag() {
    const name = tagName.trim();
    if (!name) return;
    setTagName("");
    await addTagAction({ conversationId: conversation.id, name });
    router.refresh();
  }

  return (
    <div className="space-y-5 p-4">
      <section>
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted">
          Customer
        </h3>
        <p className="mt-1 text-sm font-medium text-heading">{contactLabel}</p>
        {conversation.contact.email ? (
          <p className="text-sm text-body">{conversation.contact.email}</p>
        ) : (
          <p className="text-sm text-muted">Anonymous visitor</p>
        )}
        {conversation.visitorEmail &&
        conversation.visitorEmail.toLowerCase() !== conversation.contact.email?.toLowerCase() ? (
          <p className="mt-1 text-xs text-muted">
            Entered in chat: <span className="text-body">{conversation.visitorEmail}</span>
          </p>
        ) : null}
        {devContext.identifiedUserId ? (
          <p className="mt-1 text-xs text-muted">
            Identified by {conversation.product.name} as user{" "}
            <code className="font-mono">{devContext.identifiedUserId}</code>
          </p>
        ) : null}
      </section>

      <ContextSection
        productName={conversation.product.name}
        entries={devContext.entries}
      />

      {diagnostics.enabled ? (
        <DiagnosticsSection
          snapshots={diagnostics.snapshots}
          hasExpired={diagnostics.hasExpired}
          onOpen={onOpenSnapshot}
        />
      ) : null}

      <section>
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted">Tags</h3>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {conversation.tags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 rounded-md bg-secondary-label px-2 py-0.5 text-xs text-body"
            >
              {tag.name}
              <button
                type="button"
                aria-label={`Remove tag ${tag.name}`}
                className="text-muted hover:text-danger"
                onClick={() =>
                  void removeTagAction({ conversationId: conversation.id, tagId: tag.id }).then(() =>
                    router.refresh(),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
          {conversation.tags.length === 0 ? <span className="text-xs text-muted">None</span> : null}
        </div>
        <div className="mt-2 flex gap-1.5">
          <input
            value={tagName}
            onChange={(event) => setTagName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addTag();
            }}
            list="workspace-tags"
            placeholder="Add tag…"
            className="h-8 flex-1 rounded-md border border-border-strong bg-surface px-2 text-sm"
            aria-label="Add tag"
          />
          <datalist id="workspace-tags">
            {availableTags.map((tag) => (
              <option key={tag.id} value={tag.name} />
            ))}
          </datalist>
        </div>
      </section>

      <section>
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted">
          Attachments
        </h3>
        {conversation.messages.every((m) => !m.attachments || m.attachments.length === 0) ? (
          <p className="mt-1.5 text-xs text-muted">None</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {conversation.messages
              .flatMap((m) => m.attachments ?? [])
              .map((attachment) => (
                <li key={attachment.id}>
                  <a
                    href={`/api/attachments/${attachment.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 break-all text-sm text-primary hover:underline"
                  >
                    <IconPaperclip className="size-3.5 shrink-0" />
                    {attachment.filename}
                    <span className="text-xs text-muted">{formatFileSize(attachment.size)}</span>
                  </a>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted">
          Details
        </h3>
        <dl className="mt-1.5 space-y-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Product</dt>
            <dd className="text-body">{conversation.product.name}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Channel</dt>
            <dd className="text-body">{conversation.channel === "CHAT" ? "Chat" : "Email"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Created</dt>
            <dd className="text-body">{format(new Date(conversation.createdAt), "d MMM yyyy")}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
