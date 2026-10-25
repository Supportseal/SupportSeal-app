import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getAuth } from "@/lib/auth";
import { setTransportForTest } from "@/lib/email/outbound";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

let db: TestDb;

const originHeaders = () => new Headers({ origin: "http://localhost:3000" });

const EMAIL = "reset-me@example.com";
const OLD_PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "staple-battery-mule-9";

type CapturedMail = { to: string; subject: string; text: string };
let sent: CapturedMail[] = [];

const captureTransport = {
  sendMail(options: { to: string; subject: string; text: string }) {
    sent.push({ to: options.to, subject: options.subject, text: options.text });
    return Promise.resolve({ messageId: "<reset-1@managed>", response: "ok" });
  },
} as never;

function resetEmail(): CapturedMail {
  const mail = sent.find((m) => m.to === EMAIL);
  if (!mail) throw new Error("reset email was not sent");
  return mail;
}

function tokenFromUrl(mail: CapturedMail): string {
  const match = mail.text.match(/\/reset-password\/([A-Za-z0-9_-]+)\?/u);
  if (!match) throw new Error(`no reset token in email body: ${mail.text}`);
  return match[1]!;
}

/** The signed cookie from the sign-in response (the raw token is not a cookie). */
async function signInCookie(auth: Awaited<ReturnType<typeof getAuth>>): Promise<string> {
  const response = (await auth.api.signInEmail({
    body: { email: EMAIL, password: OLD_PASSWORD },
    headers: originHeaders(),
    asResponse: true,
  })) as unknown as Response;
  const setCookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("better-auth.session_token"));
  if (!setCookie) throw new Error("sign-in did not set a session cookie");
  return setCookie.split(";")[0]!;
}

beforeAll(async () => {
  db = await startTestDb();
  setTransportForTest(captureTransport);
  const auth = await getAuth();
  await auth.api.signUpEmail({
    body: { name: "Reset Me", email: EMAIL, password: OLD_PASSWORD },
    headers: originHeaders(),
  });
});

afterAll(async () => {
  setTransportForTest(null);
  await stopTestDb(db);
});

describe("password reset (better-auth forgetPassword/resetPassword, #22)", () => {
  it("emails a single-use reset link via the system email path", async () => {
    const auth = await getAuth();
    const res = await auth.api.requestPasswordReset({
      body: { email: EMAIL, redirectTo: "http://localhost:3000/reset-password" },
      headers: originHeaders(),
    });
    expect(res.status).toBe(true);

    const mail = resetEmail();
    expect(mail.subject).toContain("password");
    expect(mail.text).toContain("http://localhost:3000/api/auth/reset-password/");
    // The link itself is the better-auth callback that forwards to our page.
    expect(mail.text).toContain("callbackURL=http%3A%2F%2Flocalhost%3A3000%2Freset-password");

    const token = tokenFromUrl(mail);
    const verification = await db.prisma.verification.findFirst({
      where: { identifier: `reset-password:${token}` },
    });
    expect(verification?.value).toBeTruthy();
    // Library default expiry: one hour.
    const ttlSeconds = (verification!.expiresAt.getTime() - Date.now()) / 1000;
    expect(ttlSeconds).toBeGreaterThan(59 * 60);
    expect(ttlSeconds).toBeLessThanOrEqual(60 * 60 + 60);
  });

  it("does not reveal whether an email has an account", async () => {
    const auth = await getAuth();
    const res = await auth.api.requestPasswordReset({
      body: { email: "nobody@example.com", redirectTo: "http://localhost:3000/reset-password" },
      headers: originHeaders(),
    });
    expect(res.status).toBe(true);
    expect(sent.filter((m) => m.to === "nobody@example.com")).toHaveLength(0);
  });

  it("resets the password with a valid token and revokes sessions", async () => {
    const auth = await getAuth();
    sent = [];
    await auth.api.requestPasswordReset({
      body: { email: EMAIL, redirectTo: "http://localhost:3000/reset-password" },
      headers: originHeaders(),
    });
    const token = tokenFromUrl(resetEmail());

    // A live, resolvable session from before the reset must not survive it.
    const cookie = await signInCookie(auth);
    const sessionHeaders = new Headers({ cookie });
    const liveSession = await auth.api.getSession({ headers: sessionHeaders });
    expect(liveSession?.user.email).toBe(EMAIL);

    const res = await auth.api.resetPassword({
      body: { newPassword: NEW_PASSWORD, token },
      headers: originHeaders(),
    });
    expect(res.status).toBe(true);

    const oldSession = await auth.api.getSession({ headers: sessionHeaders });
    expect(oldSession).toBeNull();

    const withNew = await auth.api.signInEmail({
      body: { email: EMAIL, password: NEW_PASSWORD },
      headers: originHeaders(),
    });
    expect(withNew.token).toBeTruthy();

    await expect(
      auth.api.signInEmail({
        body: { email: EMAIL, password: OLD_PASSWORD },
        headers: originHeaders(),
      }),
    ).rejects.toThrowError();

    const account = await db.prisma.account.findFirst({
      where: { user: { email: EMAIL }, providerId: "credential" },
    });
    expect(account?.password).not.toContain(NEW_PASSWORD);
  });

  it("sweeps outstanding reset links when one is used", async () => {
    const auth = await getAuth();
    sent = [];
    await auth.api.requestPasswordReset({
      body: { email: EMAIL, redirectTo: "http://localhost:3000/reset-password" },
      headers: originHeaders(),
    });
    await auth.api.requestPasswordReset({
      body: { email: EMAIL, redirectTo: "http://localhost:3000/reset-password" },
      headers: originHeaders(),
    });
    const mails = sent.filter((m) => m.to === EMAIL);
    expect(mails).toHaveLength(2);
    const [first, second] = mails.map(tokenFromUrl);

    await auth.api.resetPassword({
      body: { newPassword: "third-valid-horse-3", token: first! },
      headers: originHeaders(),
    });
    // The unused link from the same hour is gone too.
    await expect(
      auth.api.resetPassword({
        body: { newPassword: "fourth-valid-horse-4", token: second! },
        headers: originHeaders(),
      }),
    ).rejects.toThrowError();
    const outstanding = await db.prisma.verification.count({
      where: { identifier: { startsWith: "reset-password:" } },
    });
    expect(outstanding).toBe(0);
  });

  it("rejects a reused token and a too-short password", async () => {
    const auth = await getAuth();
    sent = [];
    await auth.api.requestPasswordReset({
      body: { email: EMAIL, redirectTo: "http://localhost:3000/reset-password" },
      headers: originHeaders(),
    });
    const token = tokenFromUrl(resetEmail());

    await auth.api.resetPassword({
      body: { newPassword: "another-valid-horse-1", token },
      headers: originHeaders(),
    });
    await expect(
      auth.api.resetPassword({
        body: { newPassword: "another-valid-horse-2", token },
        headers: originHeaders(),
      }),
    ).rejects.toThrowError();

    await expect(
      auth.api.resetPassword({
        body: { newPassword: "short", token: "never-issued" },
        headers: originHeaders(),
      }),
    ).rejects.toThrowError();
  });
});
