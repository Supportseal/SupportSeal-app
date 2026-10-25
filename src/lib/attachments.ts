import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getAttachmentStorage } from "@/lib/attachment-storage";
import { formatFileSize } from "@/lib/format";

export { formatFileSize };

/**
 * Attachment validation and access control (FR-FILE-01). Uploads are
 * untrusted: type allowlist (extension AND magic bytes for images), size
 * cap, sanitised display filenames, unguessable storage keys. Only
 * authorised Workspace users or the owning visitor can retrieve a file.
 */
export const ATTACHMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxFilenameLength: 120,
} as const;

const ALLOWED_TYPES: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "application/pdf": ["pdf"],
  "text/plain": ["txt", "log", "csv"],
  "text/csv": ["csv"],
  "application/json": ["json"],
  "application/zip": ["zip"],
} as const;

/** Magic-byte sniffing for the types where it matters (images). */
function sniff(data: Uint8Array): string | null {
  if (data.length < 12) return null;
  const b = data;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0x50 && b[1] === 0x4b) return "application/zip";
  return null;
}

export class AttachmentError extends Error {}

/** Strip path separators and control characters from a display filename. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  const safe = cleaned.replace(/[^a-zA-Z0-9 ._\-'()]/gu, "_");
  return (safe || "file").slice(0, ATTACHMENT_LIMITS.maxFilenameLength);
}

export type ValidatedFile = {
  filename: string;
  contentType: string;
  data: Uint8Array;
};

export function validateAttachment(input: { name: string; type: string; data: Uint8Array }): ValidatedFile {
  if (input.data.byteLength === 0) throw new AttachmentError("The file is empty.");
  if (input.data.byteLength > ATTACHMENT_LIMITS.maxBytes) {
    throw new AttachmentError("Files must be under 10 MB.");
  }
  const filename = sanitizeFilename(input.name);
  const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  const declaredType = (input.type || "").split(";")[0].trim().toLowerCase();

  const snifferType = sniff(input.data);
  let contentType: string | null = null;

  if (snifferType) {
    // Binary content: the sniffed type must be allowlisted and must agree
    // with the declared type when one is given; extensions never override
    // content ("do not trust file extensions alone").
    if (ALLOWED_TYPES[snifferType] && (!declaredType || declaredType === snifferType)) {
      contentType = snifferType;
    }
  } else {
    // No magic bytes: only text-ish types qualify, and the declared type and
    // extension must agree.
    const extensionOk = extension !== "" && (ALLOWED_TYPES[declaredType]?.includes(extension) ?? false);
    if (
      extensionOk &&
      (declaredType === "text/plain" || declaredType === "text/csv" || declaredType === "application/json")
    ) {
      contentType = declaredType;
    }
  }

  if (!contentType) {
    throw new AttachmentError("This file type isn't supported.");
  }
  return { filename, contentType, data: input.data };
}

export type StoredAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
};

export async function storeAttachment(input: {
  workspaceId: string;
  productId: string;
  conversationId?: string | null;
  uploadedByUserId?: string | null;
  visitorId?: string | null;
  file: ValidatedFile;
  /**
   * Deterministic storage key (inbound reprocessing): a crashed attempt may
   * already have stored this exact file; the unique key makes the retry
   * reuse that row instead of duplicating the blob.
   */
  storageKey?: string;
}): Promise<StoredAttachment> {
  const storage = getAttachmentStorage();
  const storageKey = await storage.put(input.file.data, input.storageKey);
  const row = await prisma.attachment
    .create({
      data: {
        workspaceId: input.workspaceId,
        productId: input.productId,
        conversationId: input.conversationId ?? null,
        uploadedByUserId: input.uploadedByUserId ?? null,
        visitorId: input.visitorId ?? null,
        filename: input.file.filename,
        contentType: input.file.contentType,
        size: input.file.data.byteLength,
        storageKey,
      },
    })
    .catch(async (error: { code?: string }) => {
      // A prior attempt stored this deterministic key but crashed before
      // linking it to a message: reuse the row (same content by key).
      if (input.storageKey && error.code === "P2002") {
        const existing = await prisma.attachment.findUnique({ where: { storageKey: input.storageKey } });
        if (existing) return existing;
      }
      throw error;
    });
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
  };
}

export async function linkAttachmentToMessage(input: {
  workspaceId: string;
  attachmentIds: string[];
  conversationId: string;
  messageId: string;
  /** Run inside a caller's transaction (atomic with the Message insert). */
  tx?: Prisma.TransactionClient;
}): Promise<number> {
  const linked = await (input.tx ?? prisma).attachment.updateMany({
    where: {
      id: { in: input.attachmentIds },
      workspaceId: input.workspaceId,
      messageId: null,
      OR: [
        { conversationId: input.conversationId },
        // Pre-message uploads (visitor/agent attached before sending).
        { conversationId: null },
      ],
    },
    data: { messageId: input.messageId, conversationId: input.conversationId },
  });
  return linked.count;
}

export type AttachmentAccess =
  | { ok: true; storageKey: string; filename: string; contentType: string; size: number }
  | { ok: false };

/** Authorised retrieval (FR-FILE-01): agent membership or the owning visitor. */
export async function getAttachmentForDownload(input: {
  attachmentId: string;
  workspaceId?: string | null;
  visitorId?: string | null;
}): Promise<AttachmentAccess> {
  const attachment = await prisma.attachment.findUnique({
    where: { id: input.attachmentId },
  });
  if (!attachment) return { ok: false };

  const agentAllowed =
    input.workspaceId !== undefined && input.workspaceId !== null && attachment.workspaceId === input.workspaceId;
  const visitorAllowed =
    input.visitorId !== undefined &&
    input.visitorId !== null &&
    attachment.visitorId === input.visitorId;
  if (!agentAllowed && !visitorAllowed) return { ok: false };

  return {
    ok: true,
    storageKey: attachment.storageKey,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
  };
}
