import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getAuth } from "@/lib/auth";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

let db: TestDb;

const originHeaders = () => new Headers({ origin: "http://localhost:3000" });

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

describe("better-auth email/password (ADR-0002 validation)", () => {
  it("signs up, signs in and resolves a database-backed session", async () => {
    const auth = await getAuth();

    const signUp = await auth.api.signUpEmail({
      body: {
        name: "Demo Founder",
        email: "founder@example.com",
        password: "correct-horse-battery",
      },
      headers: originHeaders(),
    });
    expect(signUp.token).toBeTruthy();
    const user = await db.prisma.user.findUnique({ where: { email: "founder@example.com" } });
    expect(user?.name).toBe("Demo Founder");

    const account = await db.prisma.account.findFirst({ where: { userId: user!.id } });
    expect(account?.providerId).toBe("credential");
    expect(account?.password).toBeTruthy();

    const signIn = await auth.api.signInEmail({
      body: { email: "founder@example.com", password: "correct-horse-battery" },
      headers: originHeaders(),
    });
    expect(signIn.token).toBeTruthy();

    const session = await db.prisma.session.findFirst({ where: { userId: user!.id } });
    expect(session).not.toBeNull();

    const resolved = await auth.api.getSession({ headers: new Headers() });
    expect(resolved).toBeNull();

    const badPassword = await auth.api
      .signInEmail({
        body: { email: "founder@example.com", password: "wrong-password" },
        headers: originHeaders(),
      })
      .then(() => "unexpected-success")
      .catch(() => "rejected");
    expect(badPassword).toBe("rejected");
  });

  it("stores hashes, not plaintext passwords", async () => {
    const auth = await getAuth();
    await auth.api.signUpEmail({
      body: { name: "Hash Check", email: "hash@example.com", password: "plaintext-secret" },
      headers: originHeaders(),
    });
    const account = await db.prisma.account.findFirst({
      where: { user: { email: "hash@example.com" } },
    });
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain("plaintext-secret");
  });
});
