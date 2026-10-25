/**
 * Syntactically valid Postgres URL for Prisma CLI and `next build` when
 * `DATABASE_URL` is unset (CI, installs without a real database).
 */
export const LOCAL_FALLBACK_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/supportseal?sslmode=verify-full";

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = env.DATABASE_URL?.trim();
  return trimmed ? trimmed : LOCAL_FALLBACK_DATABASE_URL;
}
