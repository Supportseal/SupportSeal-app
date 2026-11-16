import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuth, signupMethod } from "@/lib/auth";
import { maskEmail, sendPushover } from "@/lib/pushover";
import { createWorkspace } from "@/lib/workspace";
import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
let db: TestDb;
let fetchMock: ReturnType<typeof vi.fn>;

/** Form fields of every Pushover request the code under test sent. */
function pushes(): Array<Record<string, string>> {
  return fetchMock.mock.calls
    .filter(([url]) => url === PUSHOVER_URL)
    .map(([, init]) => Object.fromEntries(new URLSearchParams(String((init as RequestInit).body))));
}

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("PUSHOVER_API_TOKEN", "app-token");
  vi.stubEnv("PUSHOVER_USER_KEY", "user-key");
  vi.stubEnv("HOSTED_MODE", "1");
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.session.deleteMany();
  await db.prisma.account.deleteMany();
  await db.prisma.user.deleteMany();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("jane.doe@acme.io")).toBe("j*******@acme.io");
    expect(maskEmail("jo@acme.io")).toBe("j*@acme.io");
    expect(maskEmail("j@acme.io")).toBe("j*@acme.io");
    expect(maskEmail("not-an-email")).toBe("****");
  });
});

describe("sendPushover", () => {
  it("sends nothing when Pushover is not configured", async () => {
    vi.stubEnv("PUSHOVER_API_TOKEN", "");
    expect(await sendPushover({ title: "t", message: "m" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the token, user key and message", async () => {
    expect(await sendPushover({ title: "Hello", message: "World", sound: "magic" })).toBe(true);
    expect(pushes()).toEqual([
      { token: "app-token", user: "user-key", title: "Hello", message: "World", sound: "magic" },
    ]);
  });

  it("logs a rejected send instead of hiding it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("bad token", { status: 400 }));
    expect(await sendPushover({ title: "Hello", message: "World" })).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("HTTP 400"));
  });

  it("logs a network failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await sendPushover({ title: "Hello", message: "World" })).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("failed"), expect.any(Error));
  });
});

describe("signupMethod", () => {
  it("names the sign-up route that created the account", () => {
    expect(signupMethod({ path: "/sign-up/email" })).toBe("email");
    expect(signupMethod({ path: "/callback/:id", params: { id: "github" } })).toBe("github");
    expect(signupMethod({ path: "/callback/google" })).toBe("google");
    expect(signupMethod({ path: "/callback/:id", params: { id: "other" } })).toBeNull();
    expect(signupMethod({ path: "/admin/create-user" })).toBeNull();
    expect(signupMethod(null)).toBeNull();
  });
});

describe("signup notifications", () => {
  it("announces an email sign-up with a masked address", async () => {
    const auth = await getAuth();
    await auth.api.signUpEmail({
      body: { name: "Jane", email: "jane.doe@acme.io", password: "correct-horse-battery" },
      headers: new Headers({ origin: "http://localhost:3000" }),
    });
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    const [push] = pushes();
    expect(push.title).toBe("New account on SupportSeal");
    expect(push.message).toContain("Email: j*******@acme.io");
    expect(push.message).toContain("Signed up with: Email and password");
    expect(push.message).not.toContain("jane.doe");
  });

  it("announces a new hosted Workspace on the Free plan", async () => {
    const user = await createTestUser(db.prisma, { email: "founder@acme.io" });
    const result = await createWorkspace({ userId: user.id, name: "Acme Support" });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    const [push] = pushes();
    expect(push.title).toBe("New Free Workspace on SupportSeal");
    expect(push.message).toContain("Workspace: Acme Support");
    expect(push.message).toContain("Owner: f******@acme.io");
  });

  it("stays silent when Pushover is not configured", async () => {
    vi.stubEnv("PUSHOVER_USER_KEY", "");
    const user = await createTestUser(db.prisma, { email: "founder@acme.io" });
    expect((await createWorkspace({ userId: user.id, name: "Acme Support" })).ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still creates the Workspace when Pushover is down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error("offline"));
    const user = await createTestUser(db.prisma, { email: "founder@acme.io" });
    expect((await createWorkspace({ userId: user.id, name: "Acme Support" })).ok).toBe(true);
    expect(await db.prisma.workspace.count()).toBe(1);
  });
});
