import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuth } from "@/lib/auth";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

/**
 * Google sign-in through better-auth's real OAuth routes, with only Google's
 * token endpoint faked. The sign-up guards and linking rules are shared with
 * GitHub (see auth-github.test.ts); these cases prove Google is wired into
 * them, not a side door around them.
 */

const ORIGIN = "http://localhost:3000";
let db: TestDb;

type GoogleUser = { sub: string; name: string; email: string; verified: boolean };
let googleUser: GoogleUser;
const realFetch = globalThis.fetch;

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** The id token Google's token endpoint returns (signature not checked on this path). */
function idToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.google.com",
    aud: "test-google-id",
    sub: googleUser.sub,
    email: googleUser.email,
    email_verified: googleUser.verified,
    name: googleUser.name,
    picture: "https://lh3.example/u.png",
    iat: now,
    exp: now + 3600,
  };
  return `${base64url({ alg: "RS256", kid: "test", typ: "JWT" })}.${base64url(claims)}.sig`;
}

function fakeGoogle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    const body = {
      access_token: "ya29.test",
      token_type: "Bearer",
      expires_in: 3599,
      scope: "openid email profile",
      id_token: idToken(),
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
  }
  return realFetch(input, init);
}

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function googleRoundTrip(options: {
  requestSignUp?: boolean;
}): Promise<{ location: string; cookies: string; authorize: URL }> {
  const auth = await getAuth();
  const start = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/inbox",
        newUserCallbackURL: "/onboarding",
        errorCallbackURL: "/login?provider=google",
        ...(options.requestSignUp ? { requestSignUp: true } : {}),
      }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  const state = authorize.searchParams.get("state")!;
  const callback = await auth.handler(
    new Request(`${ORIGIN}/api/auth/callback/google?code=abc&state=${state}`, {
      headers: { cookie: cookiesFrom(start) },
    }),
  );
  expect(callback.status).toBe(302);
  return { location: callback.headers.get("location")!, cookies: cookiesFrom(callback), authorize };
}

beforeAll(async () => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-secret");
  db = await startTestDb();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await stopTestDb(db);
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(fakeGoogle));
  vi.stubEnv("HOSTED_MODE", "1");
  await db.prisma.workspace.deleteMany();
  await db.prisma.session.deleteMany();
  await db.prisma.account.deleteMany();
  await db.prisma.user.deleteMany();
  googleUser = { sub: "1098765", name: "Gee Mail", email: "gee@gmail.com", verified: true };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google sign-in", () => {
  it("asks Google with the right callback and an account picker", async () => {
    const { authorize } = await googleRoundTrip({});
    expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
    expect(authorize.searchParams.get("prompt")).toBe("select_account");
    expect(authorize.searchParams.get("scope")?.split(" ").sort()).toEqual(["email", "openid", "profile"]);
  });

  it("signs up from the register flow, then signs in", async () => {
    const { location, cookies } = await googleRoundTrip({ requestSignUp: true });
    expect(location).toBe("/onboarding");
    expect(cookies).toContain("better-auth.session_token=");
    const user = await db.prisma.user.findUniqueOrThrow({
      where: { email: "gee@gmail.com" },
      include: { accounts: true },
    });
    expect(user.name).toBe("Gee Mail");
    expect(user.emailVerified).toBe(true);
    expect(user.accounts.map((a) => [a.providerId, a.accountId])).toEqual([["google", "1098765"]]);

    const again = await googleRoundTrip({});
    expect(again.location).toBe("/inbox");
  });

  it("never creates an account from the sign-in button", async () => {
    const { location } = await googleRoundTrip({});
    expect(location).toBe("/login?provider=google&error=signup_disabled");
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("refuses sign-up when Google reports the email unverified", async () => {
    googleUser.verified = false;
    const { location } = await googleRoundTrip({ requestSignUp: true });
    expect(location).toMatch(/^\/login\?provider=google&error=email_not_verified(&|$)/u);
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("keeps self-hosted registration closed once the Workspace exists", async () => {
    vi.stubEnv("HOSTED_MODE", "");
    await db.prisma.workspace.create({ data: { name: "Only" } });
    const { location } = await googleRoundTrip({ requestSignUp: true });
    expect(location).toMatch(/^\/login\?provider=google&error=registration_closed(&|$)/u);
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("does not take over an existing unverified email account", async () => {
    const auth = await getAuth();
    await auth.api.signUpEmail({
      body: { name: "Gee", email: "gee@gmail.com", password: "correct-horse-1" },
      headers: new Headers({ origin: ORIGIN }),
    });
    const attempt = await googleRoundTrip({ requestSignUp: true });
    expect(attempt.location).toBe("/login?provider=google&error=account_not_linked");
    expect(attempt.cookies).not.toContain("better-auth.session_token=");
    expect(await db.prisma.account.count({ where: { providerId: "google" } })).toBe(0);

    const signIn = await googleRoundTrip({});
    expect(signIn.location).toBe("/login?provider=google&error=account_not_linked");
    expect(signIn.cookies).not.toContain("better-auth.session_token=");
    expect(await db.prisma.account.count({ where: { providerId: "google" } })).toBe(0);
  });
});
