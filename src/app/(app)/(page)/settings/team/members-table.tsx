import { Badge } from "@/components/ui/badge";

type Member = {
  id: string;
  role: "ADMIN" | "AGENT";
  user: { id: string; name: string; email: string };
};

export function MembersTable({ members, currentUserId }: { members: Member[]; currentUserId: string }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {members.map((member) => (
        <li key={member.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="break-words font-medium text-heading">
              {member.user.name}
              {member.user.id === currentUserId ? (
                <span className="ml-2 text-xs font-normal text-muted">(you)</span>
              ) : null}
            </p>
            <p className="break-all text-body">{member.user.email}</p>
          </div>
          <Badge variant="light" color={member.role === "ADMIN" ? "primary" : "secondary"} className="shrink-0">
            {member.role === "ADMIN" ? "Admin" : "Agent"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
