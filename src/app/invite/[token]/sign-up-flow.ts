/**
 * Pure flow and error mapping for the embedded invite sign-up form
 * (issue #180 review fixups). Kept free of client and server imports so
 * the strand-and-retry behaviour is unit-testable in vitest's node
 * environment without mocking the auth client or server actions.
 */

/**
 * better-auth 1.7.7 rejects a duplicate email with this code
 * (BASE_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL, thrown by the
 * sign-up/email route). The old kebab-case "user-already-exists" check
 * never matched anything.
 */
export const EMAIL_TAKEN_CODE = "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL";

/** Code returned by the self-hosted sign-up gate (api/auth/[...all]/route.ts). */
export const REGISTRATION_CLOSED_CODE = "user-creation-disabled";

/**
 * Body for better-auth signUp.email. The invite token rides along as an
 * extra field (issue #184): the self-hosted sign-up gate keys on it, not
 * on the email — better-auth ignores unknown sign-up fields.
 */
export function inviteSignUpPayload(input: {
  name: string;
  email: string;
  password: string;
  token: string;
}): { name: string; email: string; password: string; inviteToken: string } {
  return { name: input.name, email: input.email, password: input.password, inviteToken: input.token };
}

export function inviteSignUpErrorMessage(code: string | undefined): string {
  if (code === EMAIL_TAKEN_CODE) {
    return "An account with that email already exists. Sign in below instead.";
  }
  if (code === REGISTRATION_CLOSED_CODE) {
    return "This invitation is no longer valid. Ask a Workspace admin for a fresh invite.";
  }
  return "Could not create the account. Check the details and try again.";
}

export type InviteSignUpDeps = {
  /** Create the account for the invited address (better-auth signUp.email). */
  signUpEmail: () => Promise<{ error?: { code?: string } | null }>;
  /** Accept the invite as the now-signed-in user (server action). */
  acceptInvite: () => Promise<{ error?: string } | null>;
  /**
   * Fired the moment signUp.email resolves without error, before accept
   * runs. The form records the account here so that an accept that
   * THROWS (network drop, 500) still leaves accountCreated set — a
   * retry must re-run accept only, never sign-up.
   */
  onAccountCreated?: () => void;
};

export type InviteSignUpOutcome =
  | { kind: "accepted" }
  | { kind: "sign-up-failed"; message: string }
  | { kind: "accept-failed"; message: string };

/**
 * One submit attempt. When the account already exists from a previous
 * attempt (`accountCreated`), sign-up is skipped entirely: a failed
 * accept must never re-run sign-up, because the second attempt would
 * hit USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL and strand the user.
 */
export async function runInviteSignUp(
  accountCreated: boolean,
  deps: InviteSignUpDeps,
): Promise<InviteSignUpOutcome> {
  if (!accountCreated) {
    const result = await deps.signUpEmail();
    if (result.error) {
      return { kind: "sign-up-failed", message: inviteSignUpErrorMessage(result.error.code) };
    }
    deps.onAccountCreated?.();
  }
  const accepted = await deps.acceptInvite();
  if (accepted?.error) {
    return { kind: "accept-failed", message: accepted.error };
  }
  return { kind: "accepted" };
}
