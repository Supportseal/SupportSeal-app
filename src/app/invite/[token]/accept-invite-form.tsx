"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { acceptInviteAction } from "./actions";

export function AcceptInviteForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button
        className="w-full"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await acceptInviteAction(token);
            if (result?.error) setError(result.error);
          })
        }
      >
        {pending ? "Accepting…" : "Accept invite"}
      </Button>
    </div>
  );
}
