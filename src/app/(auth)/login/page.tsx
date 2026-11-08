import { Suspense } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import { appConfig } from "@/lib/config";
import { getSessionUser } from "@/lib/session";
import { enabledSocialProviders, parseSocialProvider } from "@/lib/social-auth";
import { serviceOriginFrom } from "@/lib/widget";
import { socialErrorMessage } from "../social-errors";
import { LoginForm } from "./login-form";
import { safeNextPath } from "./next-path";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; social_link?: string; provider?: string }>;
}) {
  // An authenticated visitor has nothing to do here: go to the dashboard
  // (or the same-origin destination the proxy preserved in `next`, under
  // the same validation rules as the post-sign-in redirect).
  const user = await getSessionUser();
  if (user) {
    const { next, error, social_link: socialLink, provider } = await searchParams;
    const origin = serviceOriginFrom(await headers(), new URL(appConfig.url).origin);
    const destination = safeNextPath(next, origin);
    // Password sign-in succeeded but connecting the provider afterwards
    // failed: say so once instead of silently dropping the visitor on the
    // dashboard.
    if (socialLink === "failed") {
      return (
        <Card>
          <CardContent className="p-8" data-social-link-failed="">
            <h4 className="text-[1.375rem] font-medium text-heading">You&apos;re signed in</h4>
            <p className="mt-2 text-sm text-danger">{socialErrorMessage(error ?? "", "link", parseSocialProvider(provider) ?? "github")}</p>
            <p className="mt-6 text-[0.9375rem]">
              <Link href={destination} className="text-primary">
                Continue
              </Link>
            </p>
          </CardContent>
        </Card>
      );
    }
    redirect(destination);
  }

  return (
    <Suspense>
      <LoginForm providers={enabledSocialProviders()} />
    </Suspense>
  );
}
