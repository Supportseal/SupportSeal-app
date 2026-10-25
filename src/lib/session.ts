import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth } from "@/lib/auth";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
};

/** Resolve the signed-in user from the request cookies, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  };
}

/** Require a signed-in user; redirects to /login when absent. */
export async function requireUser(nextPath = "/inbox"): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  return user;
}
