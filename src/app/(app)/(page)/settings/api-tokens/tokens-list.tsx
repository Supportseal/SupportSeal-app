import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { API_TOKEN_PREFIX, type ApiTokenSummary } from "@/lib/api-tokens";
import { revokeApiTokenAction } from "./actions";

type TokenState = "active" | "expired" | "revoked";

function tokenState(token: ApiTokenSummary): TokenState {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return "expired";
  return "active";
}

const stateColor: Record<TokenState, "success" | "secondary"> = {
  active: "success",
  expired: "secondary",
  revoked: "secondary",
};

const formatDate = (date: Date) => date.toISOString().slice(0, 10);

export function TokensList({ tokens }: { tokens: ApiTokenSummary[] }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {tokens.map((token) => {
        const state = tokenState(token);
        return (
          <li key={token.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="break-all font-medium text-heading">{token.name}</p>
                <Badge variant="light" color={stateColor[state]}>
                  {state}
                </Badge>
              </div>
              <p className="text-muted">
                <code className="font-mono">
                  {API_TOKEN_PREFIX}…{token.lastFour}
                </code>
              </p>
              <p className="text-xs text-muted">
                Created {formatDate(token.createdAt)} · Last used{" "}
                {token.lastUsedAt ? formatDate(token.lastUsedAt) : "never"} · Expires{" "}
                {token.expiresAt ? formatDate(token.expiresAt) : "never"}
                {token.revokedAt ? ` · Revoked ${formatDate(token.revokedAt)}` : ""}
              </p>
            </div>
            {state === "active" ? (
              <form action={revokeApiTokenAction} className="shrink-0">
                <input type="hidden" name="tokenId" value={token.id} />
                <Button type="submit" variant="text" color="danger" size="sm" aria-label={`Revoke ${token.name}`}>
                  Revoke
                </Button>
              </form>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
