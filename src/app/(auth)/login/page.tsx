import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { appConfig } from "@/lib/config";
import { getSessionUser } from "@/lib/session";
import { serviceOriginFrom } from "@/lib/widget";
import { LoginForm } from "./login-form";
import { safeNextPath } from "./next-path";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // An authenticated visitor has nothing to do here: go to the dashboard
  // (or the same-origin destination the proxy preserved in `next`, under
  // the same validation rules as the post-sign-in redirect).
  const user = await getSessionUser();
  if (user) {
    const { next } = await searchParams;
    const origin = serviceOriginFrom(await headers(), new URL(appConfig.url).origin);
    redirect(safeNextPath(next, origin));
  }

  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
