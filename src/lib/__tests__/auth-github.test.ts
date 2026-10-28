import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuth } from "@/lib/auth";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

/**
 * GitHub sign-in end to end through better-auth's real OAuth routes, with
 * only GitHub's HTTP endpoints faked: start the flow, come back to the
 * callback, and check where the visitor lands and what was written.
 */

const ORIGIN = "http://localhost:3000";
let db: TestDb;

type GitHubUser = { id: number; login: string; name: string; email: string; verified: boolean };
let githubUser: GitHubUser;
const realFetch = globalThis.fetch;

function fakeGitHub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
  if (url.startsWith("https://github.com/login/oauth/access_token")) {
    return json({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" });
  }
  if (url === "https://api.github.com/user") {
    const { id, login, name } = githubUser;
    return json({ id, login, name, email: null, avatar_url: "https://avatars.example/u.png" });
  }
  if (url === "https://api.github.com/user/emails") {
    return json([{ email: githubUser.email, primary: true, verified: githubUser.verified }]);
  }
  return realFetch(input, init);
}

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** Runs a full GitHub round trip; returns the callback's redirect target. */
async function githubRoundTrip(options: {
  path?: "/sign-in/social" | "/link-social";
  requestSignUp?: boolean;
  sessionCookie?: string;
}): Promise<{ location: string; cookies: string }> {
  const auth = await getAuth();
  const start = await auth.handler(
    new Request(`${ORIGIN}/api/auth${options.path ?? "/sign-in/social"}`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...(options.sessionCookie ? { cookie: options.sessionCookie } : {}),
      },
      body: JSON.stringify({
        provider: "github",
        callbackURL: "/inbox",
        newUserCallbackURL: "/onboarding",
        errorCallbackURL: "/login",
        ...(options.requestSignUp ? { requestSignUp: true } : {}),
      }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/github`);
  const state = authorize.searchParams.get("state")!;
  const cookie = [options.sessionCookie, cookiesFrom(start)].filter(Boolean).join("; ");
  const callback = await auth.handler(
    new Request(`${ORIGIN}/api/auth/callback/github?code=abc&state=${state}`, {
      headers: { cookie },
    }),
  );
  expect(callback.status).toBe(302);
  return { location: callback.headers.get("location")!, cookies: cookiesFrom(callback) };
}

async function passwordSignIn(email: string, password: string): Promise<string> {
  const auth = await getAuth();
  const response = (await auth.api.signInEmail({
    body: { email, password },
    headers: new Headers({ origin: ORIGIN }),
    asResponse: true,
  })) as unknown as Response;
  return cookiesFrom(response);
}

beforeAll(async () => {
  vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
  db = await startTestDb();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await stopTestDb(db);
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(fakeGitHub));
  vi.stubEnv("HOSTED_MODE", "1");
  await db.prisma.workspace.deleteMany();
  await db.prisma.session.deleteMany();
  await db.prisma.account.deleteMany();
  await db.prisma.user.deleteMany();
  githubUser = { id: 4242, login: "octo", name: "Octo Dev", email: "octo@example.com", verified: true };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub sign-in", () => {
  it("signs up from the register flow and lands on onboarding", async () => {
    const { location, cookies } = await githubRoundTrip({ requestSignUp: true });
    expect(location).toBe("/onboarding");
    expect(cookies).toContain("better-auth.session_token=");
    const user = await db.prisma.user.findUniqueOrThrow({
      where: { email: "octo@example.com" },
      include: { accounts: true },
    });
    expect(user.name).toBe("Octo Dev");
    expect(user.emailVerified).toBe(true);
    expect(user.accounts.map((a) => [a.providerId, a.accountId])).toEqual([["github", "4242"]]);

    // Next time, "Sign in with GitHub" goes straight to the destination.
    const again = await githubRoundTrip({});
    expect(again.location).toBe("/inbox");
  });

  it("never creates an account from the sign-in button", async () => {
    const { location } = await githubRoundTrip({});
    expect(location).toBe("/login?error=signup_disabled");
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("refuses sign-up when the GitHub email is unverified", async () => {
    githubUser.verified = false;
    const { location } = await githubRoundTrip({ requestSignUp: true });
    expect(location).toMatch(/^\/login\?error=email_not_verified(&|$)/u);
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("keeps self-hosted registration closed once the Workspace exists", async () => {
    vi.stubEnv("HOSTED_MODE", "");
    await db.prisma.workspace.create({ data: { name: "Only" } });
    const { location } = await githubRoundTrip({ requestSignUp: true });
    expect(location).toMatch(/^\/login\?error=registration_closed(&|$)/u);
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("allows GitHub sign-up on a fresh self-hosted install", async () => {
    vi.stubEnv("HOSTED_MODE", "");
    const { location } = await githubRoundTrip({ requestSignUp: true });
    expect(location).toBe("/onboarding");
  });

  it("does not take over an unverified email account; password sign-in then links it", async () => {
    const auth = await getAuth();
    await auth.api.signUpEmail({
      body: { name: "Octo", email: "octo@example.com", password: "correct-horse-1" },
      headers: new Headers({ origin: ORIGIN }),
    });

    const attempt = await githubRoundTrip({ requestSignUp: true });
    expect(attempt.location).toBe("/login?error=account_not_linked");
    expect(attempt.cookies).not.toContain("better-auth.session_token=");
    expect(await db.prisma.account.count({ where: { providerId: "github" } })).toBe(0);

    // The login page's "Sign in and connect GitHub": password first, then link.
    const session = await passwordSignIn("octo@example.com", "correct-horse-1");
    const link = await githubRoundTrip({ path: "/link-social", sessionCookie: session });
    expect(link.location).toBe("/inbox");
    expect(await db.prisma.account.count({ where: { providerId: "github" } })).toBe(1);

    // From now on GitHub signs in to the same account.
    const after = await githubRoundTrip({});
    expect(after.location).toBe("/inbox");
    expect(await db.prisma.user.count()).toBe(1);
  });

  it("refuses to link a GitHub login whose email differs from the account", async () => {
    const auth = await getAuth();
    await auth.api.signUpEmail({
      body: { name: "Other", email: "other@example.com", password: "correct-horse-1" },
      headers: new Headers({ origin: ORIGIN }),
    });
    const session = await passwordSignIn("other@example.com", "correct-horse-1");
    const link = await githubRoundTrip({ path: "/link-social", sessionCookie: session });
    expect(link.location).toBe("/login?error=email_does_not_match");
    expect(await db.prisma.account.count({ where: { providerId: "github" } })).toBe(0);
  });
});
