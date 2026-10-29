import { PRIVATE_NO_STORE } from "@/lib/api-errors";
import { v1Route } from "@/lib/api/v1-route";

export const dynamic = "force-dynamic";

/** Token introspection: which Workspace the token acts in, and what it may do. Any valid token may call it. */
export const GET = v1Route({ scope: "any" }, async ({ scope, db }) => {
  const [workspace, token] = await Promise.all([
    db.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId }, select: { id: true, name: true } }),
    db.apiToken.findUniqueOrThrow({
      where: { id: scope.tokenId },
      select: { id: true, name: true, scopes: true, expiresAt: true },
    }),
  ]);
  return Response.json(
    { workspace, token: { ...token, expiresAt: token.expiresAt?.toISOString() ?? null } },
    { headers: PRIVATE_NO_STORE },
  );
});
