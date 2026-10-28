"use client";

import { useRouter } from "next/navigation";
import { resetSupportWidget } from "@/components/support/support-widget-script";
import { authClient } from "@/lib/auth-client";

export function SignOutLink() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="text-sm text-muted hover:text-heading"
      onClick={() => {
        resetSupportWidget();
        void authClient.signOut().then(() => router.push("/login"));
      }}
    >
      Sign out
    </button>
  );
}
