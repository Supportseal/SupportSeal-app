import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Attachment storage abstraction (architecture.md: recoverable file store —
 * local for simple self-hosting, S3-compatible for managed storage later).
 * The local adapter stores files under STORAGE_DIR (default .dev-data/uploads
 * in dev) using unguessable generated keys — never the user-supplied name.
 */
export interface AttachmentStorage {
  /**
   * Store `data` and return its key. With an explicit `key` the write is
   * idempotent: same key + same bytes overwrites to identical content, so
   * callers that derive deterministic keys (inbound reprocessing) can retry
   * safely.
   */
  put(data: Uint8Array, key?: string): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

const UPLOADS_DIR = process.env.STORAGE_DIR?.trim() || path.join(".dev-data", "uploads");

const KEY_PATTERN = /^[a-f0-9-]+$/u;

class LocalAttachmentStorage implements AttachmentStorage {
  async put(data: Uint8Array, key?: string): Promise<string> {
    const storageKey = key ?? `${randomUUID()}${createHash("sha256").update(data).digest("hex").slice(0, 16)}`;
    if (!KEY_PATTERN.test(storageKey)) throw new Error("Invalid storage key.");
    const dir = path.join(UPLOADS_DIR, storageKey.slice(0, 2));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, storageKey), data);
    return storageKey;
  }

  async get(key: string): Promise<Uint8Array> {
    if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key.");
    const file = await readFile(path.join(UPLOADS_DIR, key.slice(0, 2), key));
    return new Uint8Array(file);
  }

  async delete(key: string): Promise<void> {
    if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key.");
    await rm(path.join(UPLOADS_DIR, key.slice(0, 2), key), { force: true });
  }
}

const globalForStorage = globalThis as unknown as { __supportsealStorage?: AttachmentStorage };

export function getAttachmentStorage(): AttachmentStorage {
  globalForStorage.__supportsealStorage ??= new LocalAttachmentStorage();
  return globalForStorage.__supportsealStorage;
}

/** Test helper: swap or clear the storage adapter (in-memory). */
export function setAttachmentStorageForTest(storage: AttachmentStorage | null): void {
  globalForStorage.__supportsealStorage = storage ?? undefined;
}
