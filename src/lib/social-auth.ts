/**
 * Optional "Continue with Google / GitHub" sign-in. Each provider is enabled
 * only when both its client ID and secret are set, so self-hosted
 * installations never need an OAuth app (FR-HOST-01). Each OAuth app's
 * callback URL is `${NEXT_PUBLIC_APP_URL}/api/auth/callback/<provider>`.
 */
export type SocialProvider = "google" | "github";

/** Display order on the auth pages. */
export const SOCIAL_PROVIDERS: readonly SocialProvider[] = ["google", "github"];

const ENV_PREFIX: Record<SocialProvider, string> = { google: "GOOGLE", github: "GITHUB" };

export function socialCredentials(
  provider: SocialProvider,
): { clientId: string; clientSecret: string } | null {
  const prefix = ENV_PREFIX[provider];
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function enabledSocialProviders(): SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((provider) => socialCredentials(provider) !== null);
}

export function parseSocialProvider(value: unknown): SocialProvider | null {
  return SOCIAL_PROVIDERS.find((provider) => provider === value) ?? null;
}

/** Error codes sent back to the auth pages when OAuth sign-up is refused. */
export const REGISTRATION_CLOSED = "registration_closed";
export const EMAIL_NOT_VERIFIED = "email_not_verified";
