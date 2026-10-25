import { describe, expect, it, vi } from "vitest";

import {
  EMAIL_TAKEN_CODE,
  REGISTRATION_CLOSED_CODE,
  inviteSignUpErrorMessage,
  inviteSignUpPayload,
  runInviteSignUp,
} from "../sign-up-flow";

/**
 * Issue #180 review fixups: the form's error mapping and its
 * retry-after-failed-accept behaviour. Extracted into sign-up-flow.ts so
 * they are testable in vitest's node environment without a DOM.
 *
 * Issue #184 adds inviteSignUpPayload: the invite token must ride along
 * with the better-auth sign-up call, because the self-hosted gate keys on
 * the token, not the email.
 */
describe("inviteSignUpErrorMessage", () => {
  it("maps better-auth 1.7.7's duplicate-email code to the sign-in hint", () => {
    // Regression: the form used to check the kebab-case "user-already-exists",
    // which the sign-up/email route never returns (it throws
    // BASE_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL), so the
    // friendly branch was dead.
    expect(inviteSignUpErrorMessage(EMAIL_TAKEN_CODE)).toBe(
      "An account with that email already exists. Sign in below instead.",
    );
  });

  it("maps the self-hosted registration gate to the invalid-invite message", () => {
    expect(inviteSignUpErrorMessage(REGISTRATION_CLOSED_CODE)).toBe(
      "This invitation is no longer valid. Ask a Workspace admin for a fresh invite.",
    );
  });

  it("falls back to a generic message for unknown or missing codes", () => {
    expect(inviteSignUpErrorMessage("PASSWORD_TOO_SHORT")).toBe(
      "Could not create the account. Check the details and try again.",
    );
    expect(inviteSignUpErrorMessage(undefined)).toBe(
      "Could not create the account. Check the details and try again.",
    );
  });
});

describe("inviteSignUpPayload (issue #184)", () => {
  it("sends the invite token alongside the sign-up credentials", () => {
    // The self-hosted gate admits the request on a pending token; without
    // it even the invited address gets user-creation-disabled.
    expect(
      inviteSignUpPayload({
        name: "Teammate",
        email: "teammate@example.com",
        password: "correct-horse-battery",
        token: "invite-token",
      }),
    ).toEqual({
      name: "Teammate",
      email: "teammate@example.com",
      password: "correct-horse-battery",
      inviteToken: "invite-token",
    });
  });
});

describe("runInviteSignUp", () => {
  it("reports a sign-up failure without touching the invite", async () => {
    const signUpEmail = vi.fn().mockResolvedValue({
      error: { code: EMAIL_TAKEN_CODE, message: "User already exists. Use another email." },
    });
    const acceptInvite = vi.fn();

    const outcome = await runInviteSignUp(false, { signUpEmail, acceptInvite });

    expect(outcome).toEqual({
      kind: "sign-up-failed",
      message: "An account with that email already exists. Sign in below instead.",
    });
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it("reports an accept failure after a successful sign-up", async () => {
    const signUpEmail = vi.fn().mockResolvedValue({ error: null });
    const acceptInvite = vi.fn().mockResolvedValue({ error: "This workspace is full." });

    const outcome = await runInviteSignUp(false, { signUpEmail, acceptInvite });

    expect(outcome).toEqual({ kind: "accept-failed", message: "This workspace is full." });
    expect(signUpEmail).toHaveBeenCalledTimes(1);
  });

  it("never re-runs sign-up once the account exists (retry retries accept only)", async () => {
    // P2-2: sign-up already created the account and session; a retry must
    // not call signUp.email again or the duplicate-email error would
    // strand the user.
    const signUpEmail = vi.fn();
    const acceptInvite = vi.fn().mockResolvedValue({ error: null });

    const outcome = await runInviteSignUp(true, { signUpEmail, acceptInvite });

    expect(outcome).toEqual({ kind: "accepted" });
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(acceptInvite).toHaveBeenCalledTimes(1);
  });

  it("a thrown accept still records the account, so retry skips sign-up", async () => {
    // P2 (PR #181 final pass): when acceptInvite rejects (network drop,
    // 500) the promise rejects, but onAccountCreated must already have
    // fired — otherwise the form's accountCreated stays false and the
    // retry re-runs signUp.email against the existing account.
    let accountCreated = false;
    const signUpEmail = vi.fn().mockResolvedValue({ error: null });
    const acceptInvite = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network drop"))
      .mockResolvedValueOnce({ error: null });

    await expect(
      runInviteSignUp(accountCreated, {
        signUpEmail,
        acceptInvite,
        onAccountCreated: () => (accountCreated = true),
      }),
    ).rejects.toThrow("Network drop");
    expect(accountCreated).toBe(true);

    await expect(
      runInviteSignUp(accountCreated, {
        signUpEmail,
        acceptInvite,
        onAccountCreated: () => (accountCreated = true),
      }),
    ).resolves.toEqual({ kind: "accepted" });
    expect(signUpEmail).toHaveBeenCalledTimes(1);
  });

  it("does not fire onAccountCreated when sign-up itself fails", async () => {
    const signUpEmail = vi.fn().mockResolvedValue({
      error: { code: EMAIL_TAKEN_CODE, message: "User already exists." },
    });
    const acceptInvite = vi.fn();
    const onAccountCreated = vi.fn();

    await runInviteSignUp(false, { signUpEmail, acceptInvite, onAccountCreated });

    expect(onAccountCreated).not.toHaveBeenCalled();
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it("succeeds end to end on the first attempt", async () => {
    const signUpEmail = vi.fn().mockResolvedValue({ error: null });
    const acceptInvite = vi.fn().mockResolvedValue(undefined);

    await expect(runInviteSignUp(false, { signUpEmail, acceptInvite })).resolves.toEqual({
      kind: "accepted",
    });
  });
});
