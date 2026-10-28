/**
 * Messages for the `error` query value better-auth appends when GitHub
 * sign-in, sign-up or linking fails (OAuth callback error codes plus the
 * codes thrown by the sign-up guard in src/lib/auth.ts).
 */
export type GitHubErrorContext = "login" | "register" | "link";

/** Existing email account found, but it can't be linked automatically. */
export const ACCOUNT_NOT_LINKED = "account_not_linked";

export function githubErrorMessage(code: string, context: GitHubErrorContext): string {
  switch (code) {
    case ACCOUNT_NOT_LINKED:
      return context === "login"
        ? "An account with this email already exists. Sign in with your password once to connect GitHub to it."
        : "An account with this email already exists. Sign in with your password to connect GitHub.";
    case "signup_disabled":
      return "No account uses that GitHub login yet. Create an account first.";
    case "registration_closed":
      return "Registration is closed on this installation. Ask your administrator for an invitation.";
    case "email_not_verified":
    case "unable_to_link_account":
      return "Your primary email on GitHub isn't verified. Verify it on GitHub and try again.";
    case "email_not_found":
      return "GitHub didn't share an email address. Add a verified email on GitHub and try again.";
    case "email_does_not_match":
      return "GitHub wasn't connected: your GitHub primary email is different from this account's email.";
    case "account_already_linked_to_different_user":
      return "That GitHub login is already connected to a different account.";
    case "access_denied":
      return "GitHub sign-in was cancelled.";
    default:
      return "GitHub sign-in didn't work. Try again.";
  }
}
