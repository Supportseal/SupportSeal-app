import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { revokeInviteAction } from "./actions";

type Invite = {
  id: string;
  email: string;
  role: "ADMIN" | "AGENT";
  status: "pending" | "accepted" | "expired";
  createdAt: Date;
};

const statusVariant: Record<Invite["status"], { color: "primary" | "success" | "secondary" }> = {
  pending: { color: "primary" },
  accepted: { color: "success" },
  expired: { color: "secondary" },
};

export function InvitesTable({ invites }: { invites: Invite[] }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {invites.map((invite) => (
        <li key={invite.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <div className="min-w-0 space-y-1.5">
            <p className="break-all text-body">{invite.email}</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted">{invite.role === "ADMIN" ? "Admin" : "Agent"}</span>
              <Badge variant="light" color={statusVariant[invite.status].color}>
                {invite.status}
              </Badge>
            </div>
          </div>
          {invite.status === "pending" ? (
            <form action={revokeInviteAction} className="shrink-0">
              <input type="hidden" name="inviteId" value={invite.id} />
              <Button type="submit" variant="text" color="danger" size="sm">
                Revoke
              </Button>
            </form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
