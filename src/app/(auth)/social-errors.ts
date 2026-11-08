import type { SocialProvider } from "@/lib/social-auth";

export const SOCIAL_PROVIDER_NAMES: Record<SocialProvider, string> = {
  google: "Google",
  github: "GitHub",
};

/**
 * Messages for the `error` query value better-auth appends when Google or
 * GitHub sign-in, sign-up or linking fails (OAuth callback error codes plus
 * the codes thrown by the sign-up guard in src/lib/auth.ts). The auth pages
 * add `provider=<id>` to their error callback URLs so the message can name
 * the provider; links from before that default to GitHub.
 */
export type SocialErrorContext = "login" | "register" | "link";

/** Existing email account found, but it can't be linked automatically. */
export const ACCOUNT_NOT_LINKED = "account_not_linked";

export function socialErrorMessage(
  code: string,
  context: SocialErrorContext,
  provider: SocialProvider,
): string {
  const name = SOCIAL_PROVIDER_NAMES[provider];
  switch (code) {
    case ACCOUNT_NOT_LINKED:
      return context === "login"
        ? `An account with this email already exists. Sign in with your password once to connect ${name} to it.`
        : `An account with this email already exists. Sign in with your password to connect ${name}.`;
    case "signup_disabled":
      return `No account uses that ${name} login yet. Create an account first.`;
    case "registration_closed":
      return "Registration is closed on this installation. Ask your administrator for an invitation.";
    case "email_not_verified":
    case "unable_to_link_account":
      return `Your email address on ${name} isn't verified. Verify it with ${name} and try again.`;
    case "email_not_found":
      return `${name} didn't share an email address. Add a verified email with ${name} and try again.`;
    case "email_does_not_match":
      return `${name} wasn't connected: the email on your ${name} login is different from this account's email.`;
    case "account_already_linked_to_different_user":
      return `That ${name} login is already connected to a different account.`;
    case "access_denied":
      return `${name} sign-in was cancelled.`;
    default:
      return `${name} sign-in didn't work. Try again.`;
  }
}
