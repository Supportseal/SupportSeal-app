function origin(raw: string | undefined, fallback: string): string {
  return (raw?.trim() || fallback).replace(/\/$/, "");
}

export const appConfig = {
  url: origin(process.env.NEXT_PUBLIC_APP_URL, "http://localhost:3000"),
  /**
   * Public site of the hosted service, which publishes its legal policies.
   * Only hosted-mode surfaces link to it.
   */
  marketingUrl: origin(process.env.NEXT_PUBLIC_MARKETING_URL, "https://supportseal.app"),
} as const;
