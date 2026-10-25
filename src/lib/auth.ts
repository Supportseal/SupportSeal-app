import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import {
  AGENT_SESSION_EXPIRES_IN_SECONDS,
  AGENT_SESSION_UPDATE_AGE_SECONDS,
} from "@/config/session-lifetimes";
import { brand } from "@/lib/brand";
import { appConfig } from "@/lib/config";
import { sendSystemEmail } from "@/lib/email/outbound";
import { resolvePrisma } from "@/lib/prisma";

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function createAuth() {
  return betterAuth({
    // The signing secret comes from BETTER_AUTH_SECRET (read automatically);
    // production refuses to boot without it — see getAuth().
    baseURL: appConfig.url,
    // Trust the deployment URL plus any same-origin request host, so the app
    // works on localhost, LAN hosts and production domains alike.
    trustedOrigins: (request) => {
      const origins = new Set<string>([appConfig.url]);
      const req = request as { headers?: Headers; url?: string } | undefined;
      const host =
        req?.headers?.get?.("host") ?? (req?.url ? safeHost(req.url) : undefined);
      if (host) {
        origins.add(`http://${host}`);
        origins.add(`https://${host}`);
      }
      return [...origins];
    },
    database: prismaAdapter(resolvePrisma(), { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // Password reset (#22, ADR-0002): the link better-auth generates points
      // at its own callback route, which redirects to /reset-password with
      // the token. Delivery goes through the provider-neutral system email
      // boundary (ADR-0004) — SendGrid API or SMTP; record-only when no
      // provider is configured.
      sendResetPassword: async ({ user, url }) => {
        const result = await sendSystemEmail({
          to: user.email,
          subject: `Reset your ${brand.name} password`,
          text: [
            `Hi ${user.name},`,
            ``,
            `We received a request to reset the password for your ${brand.name} account (${user.email}).`,
            ``,
            `Reset your password: ${url}`,
            ``,
            `This link expires in one hour and can only be used once.`,
            `If you did not request this, you can ignore this email — your password stays unchanged.`,
          ].join("\n"),
        });
        if (result.ok) {
          if (!result.delivered) {
            // better-auth's background runner swallows rejections and always
            // answers the request with success, so an undelivered reset email
            // can only be surfaced here. Dev logs the link itself (the only
            // way to exercise the flow without SMTP); production logs without
            // the bearer-token URL.
            if (process.env.NODE_ENV !== "production") {
              console.log(`[auth] password reset for ${user.email} (no SMTP, dev): ${url}`);
            } else {
              console.error(
                `password reset email to ${user.email} was not delivered (SMTP not configured) — token created but never sent`,
              );
            }
          }
        } else {
          console.error(`password reset email to ${user.email} failed: ${result.error}`);
        }
      },
      // A completed reset also sweeps every outstanding reset link for the
      // account (better-auth consumes only the submitted token).
      onPasswordReset: async ({ user }) => {
        await resolvePrisma()
          .verification.deleteMany({
            where: { identifier: { startsWith: "reset-password:" }, value: user.id },
          })
          .catch((error) => {
            console.error(`failed to sweep reset tokens for user ${user.id}:`, error);
          });
      },
      // A completed reset invalidates existing sessions (containment when the
      // reset follows an account compromise).
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: AGENT_SESSION_EXPIRES_IN_SECONDS,
      updateAge: AGENT_SESSION_UPDATE_AGE_SECONDS,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

let authInstance: Auth | undefined;

/**
 * Authentication instance (ADR-0002): better-auth with the Prisma adapter,
 * email/password credentials and database-backed sessions. Constructed
 * lazily because the Prisma client must resolve first (dev PGlite) and
 * `next build` loads route modules without a database.
 */
export async function getAuth(): Promise<Auth> {
  if (process.env.NODE_ENV === "production" && !process.env.BETTER_AUTH_SECRET?.trim()) {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }
  authInstance ??= createAuth();
  return authInstance;
}
