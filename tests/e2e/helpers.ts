import fs from "node:fs";

import { expect, type FrameLocator, type Page } from "@playwright/test";
import { E2E_SHARED_SECRET } from "./shared-secret.mjs";

export const APP_ORIGIN = process.env.E2E_APP_URL || "http://localhost:3100";
export const SUPPORT_ORIGIN = "http://localhost:3101";
/** Second host-page port: cookies and partition keys ignore ports, so this
 * exercises "fresh port, same host" session isolation (issue #61). */
export const SUPPORT_ORIGIN_ALT = "http://localhost:3102";

/** Widget host page for a specific app origin (self-hosted suite uses 3200). */
export function hostPageFor(appOrigin: string, supportOrigin = SUPPORT_ORIGIN): string {
  return `${supportOrigin}/?app=${encodeURIComponent(appOrigin)}`;
}

export const HOST_PAGE = hostPageFor(APP_ORIGIN);

export type Fixtures = {
  support: {
    workspace: { id: string };
    product: { id: string; key: string };
  };
  beta: {
    workspace: { id: string; name: string };
    product: { id: string; key: string; inboundEmail: string };
    owner: { email: string; password: string };
  };
  gamma: {
    workspace: { id: string; name: string };
    product: { id: string; key: string };
    owner: { email: string; password: string };
    conversation: { id: string; subject: string; ticketRef: string };
  };
};

export function loadFixtures(): Fixtures {
  return JSON.parse(
    fs.readFileSync(new URL("./.runtime/hosted/fixtures.json", import.meta.url), "utf8"),
  ) as Fixtures;
}

export const INBOUND_SECRET = E2E_SHARED_SECRET;

export type CapturedEmail = {
  from: string;
  to: string[];
  subject: string;
  replyTo: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  body: string;
};

export async function resetCapturedEmails(): Promise<void> {
  const response = await fetch(`${SUPPORT_ORIGIN}/_smtp/reset`, { method: "POST" });
  if (!response.ok) throw new Error("smtp capture reset failed");
}

export async function capturedEmails(): Promise<CapturedEmail[]> {
  const response = await fetch(`${SUPPORT_ORIGIN}/_smtp`);
  if (!response.ok) throw new Error("smtp capture read failed");
  const data = (await response.json()) as { messages: CapturedEmail[] };
  return data.messages;
}

/** Poll the SMTP capture until an email matching the predicate arrives. */
export async function waitForEmail(
  predicate: (email: CapturedEmail) => boolean,
  timeoutMs = 15_000,
): Promise<CapturedEmail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const emails = await capturedEmails();
    const match = emails.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(
        `no captured email matched within ${timeoutMs}ms (captured: ${JSON.stringify(emails.map((e) => e.subject))})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Submit an inbound email through the provider webhook (FR-EMAIL-01). */
export async function postInboundEmail(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${APP_ORIGIN}/api/email/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-supportseal-inbound-secret": INBOUND_SECRET,
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/**
 * Post a SendGrid Inbound Parse style multipart/form-data body (the production
 * wire format) to the inbound webhook, authenticated by ?secret= like the
 * hostname's destination URL.
 */
export async function postInboundParse(
  fields: Record<string, string>,
  files: Array<{ name: string; filename: string; type: string; content: string }> = [],
  secret: string | null = INBOUND_SECRET,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const file of files) {
    form.append(file.name, new Blob([file.content], { type: file.type }), file.filename);
  }
  const query = secret === null ? "" : `?secret=${encodeURIComponent(secret)}`;
  const response = await fetch(`${APP_ORIGIN}/api/email/inbound${query}`, { method: "POST", body: form });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Unique-enough account values so every run starts from a clean slate. */
export function uniqueAccount() {
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return {
    name: `E2E Owner ${nonce}`,
    email: `owner-${nonce}@e2e.test`,
    password: "correct-horse-owner",
    workspace: `E2E Workspace ${nonce}`,
  };
}

export async function registerAccount(
  page: Page,
  account: ReturnType<typeof uniqueAccount>,
): Promise<void> {
  await page.goto("/register");
  await page.locator("#name").fill(account.name);
  await page.locator("#email").fill(account.email);
  await page.locator("#password").fill(account.password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/onboarding/u);
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/inbox/u);
}

export function widgetFrame(page: Page): FrameLocator {
  return page.frameLocator("#supportseal-widget-host iframe");
}

/** Diagnostics host page: canary secrets plus __triggerDiag() (DX-03/DX-04). */
export function diagHostPageFor(appOrigin: string): string {
  return `${SUPPORT_ORIGIN}/?diag=1&app=${encodeURIComponent(appOrigin)}`;
}

/**
 * Enable browser diagnostics for a Product through the settings UI
 * (Developer tab switch + confirm dialog).
 */
export async function enableDiagnostics(page: Page, productId: string): Promise<void> {
  await page.goto(`/settings/products/${productId}?tab=developer`);
  await page.getByRole("switch", { name: "Browser diagnostics" }).click();
  await page.getByRole("button", { name: "Enable diagnostics" }).click();
  await expect(page.getByText(/^Enabled by /u)).toBeVisible();
}

/** Disable through the UI (no dialog, saves immediately). */
export async function disableDiagnostics(page: Page, productId: string): Promise<void> {
  await page.goto(`/settings/products/${productId}?tab=developer`);
  await page.getByRole("switch", { name: "Browser diagnostics" }).click();
  await expect(page.getByRole("switch", { name: "Browser diagnostics" })).toHaveAttribute(
    "data-state",
    "unchecked",
  );
}

/**
 * Open the embedded widget. `status` is the status-line text to wait for
 * ("Online" or "Away") — it only appears once the session boot resolved, so
 * waiting for it also guards every later interaction against the pre-boot
 * race. Omit it only when the caller waits for its own signal.
 */
export async function openWidget(
  page: Page,
  key: string,
  options: { hostPage?: string; status?: string } = {},
): Promise<FrameLocator> {
  await page.goto(`${options.hostPage ?? HOST_PAGE}&key=${encodeURIComponent(key)}`);
  const host = page.locator("#supportseal-widget-host");
  await expect(host).toBeAttached();
  const launcher = host.locator("button").first();
  await expect(launcher).toBeVisible();
  await launcher.click();
  const frame = widgetFrame(page);
  if (options.status !== undefined) {
    await expect(frame.locator("#statusline")).toContainText(options.status);
  }
  return frame;
}

/**
 * Create a Product from settings and return its id, public widget key and
 * generated inbound address. Visits the Email tab so every creation also
 * smoke-checks the inbound surface (issue #45).
 */
export async function createProduct(
  page: Page,
  product: { name: string; colour?: string; domain?: string },
): Promise<{ id: string; key: string; inboundEmail: string }> {
  await page.goto("/settings/products");
  await page.locator("#name").fill(product.name);
  if (product.colour !== undefined) await page.locator("#primaryColor").fill(product.colour);
  if (product.domain !== undefined) await page.locator("#domains").fill(product.domain);
  await page.getByRole("button", { name: "Create Product" }).click();
  await expect(page).toHaveURL(/\/settings\/products\/[^/]+\/?(\?|$)/u);
  const id = page.url().match(/\/settings\/products\/([^/?]+)/u)?.[1] ?? "";
  expect(id).not.toBe("");

  await page.goto(`/settings/products/${id}?tab=widget`);
  const key = ((await page.getByText(/^pk_\S+$/u).textContent()) ?? "").trim();
  expect(key).toMatch(/^pk_/u);

  const inboundEmail = await readInboundEmail(page, id);
  return { id, key, inboundEmail };
}

/** The Product's generated inbound address as shown on its Email tab. */
export async function readInboundEmail(page: Page, productId: string): Promise<string> {
  await page.goto(`/settings/products/${productId}?tab=email`);
  const address = (
    (await page.getByText(/^product_[a-z0-9_-]+@[a-z0-9.-]+$/u).textContent()) ?? ""
  ).trim();
  expect(address).toMatch(/^product_[a-z0-9_-]+@[a-z0-9.-]+$/u);
  return address;
}

/**
 * Register an account and complete onboarding up to the install step for one
 * Product; returns that Product's public widget key.
 */
export async function onboardWorkspaceWithProduct(
  page: Page,
  account: ReturnType<typeof uniqueAccount>,
  product: { name: string; domain: string },
): Promise<string> {
  await registerAccount(page, account);
  await page.locator("#name").fill(account.workspace);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/onboarding\/product/u);

  await page.locator("#name").fill(product.name);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/onboarding\/domain/u);

  await page.locator("#domain").fill(product.domain);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: `Remove ${product.domain}` })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  // Optional Mail step (skippable, never blocks the wizard).
  await expect(page).toHaveURL(/\/onboarding\/mail/u);
  await page.getByRole("link", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/onboarding\/install/u);

  const snippet = (await page.locator("pre").first().textContent()) ?? "";
  const key = snippet.match(/data-key="(pk_[^"]+)"/u)?.[1] ?? "";
  expect(key).toMatch(/^pk_/u);
  return key;
}
