/**
 * Optional "Continue with GitHub" sign-in. Enabled only when both
 * GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set, so self-hosted
 * installations never need a GitHub OAuth App (FR-HOST-01). The OAuth App's
 * callback URL is `${NEXT_PUBLIC_APP_URL}/api/auth/callback/github`.
 */
export function githubOAuthCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isGitHubSignInEnabled(): boolean {
  return githubOAuthCredentials() !== null;
}

/** Error code sent back to the auth pages when OAuth sign-up is refused. */
export const GITHUB_REGISTRATION_CLOSED = "registration_closed";
export const GITHUB_EMAIL_NOT_VERIFIED = "email_not_verified";
