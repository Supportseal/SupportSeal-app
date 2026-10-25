import { Card, CardContent } from "@/components/ui/card";
import { listInvites, listMembers, requireWorkspace } from "@/lib/workspace";
import { InviteForm } from "./invite-form";
import { InvitesTable } from "./invites-table";
import { MembersTable } from "./members-table";

export const metadata = { title: "Team" };

export default async function TeamPage() {
  const ctx = await requireWorkspace("/settings/team");
  const [members, invites] = await Promise.all([
    listMembers(ctx.workspace.id),
    listInvites(ctx.workspace.id),
  ]);

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-medium text-heading">Team</h2>
        <p className="mt-1 text-muted">
          Admins manage the Workspace, Products and settings. Agents work the inbox.
        </p>
      </header>

      <section>
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-6">
            <h3 className="text-sm font-medium text-muted">Members</h3>
            <MembersTable members={members} currentUserId={ctx.user.id} />
          </CardContent>
        </Card>
      </section>

      {ctx.role === "ADMIN" ? (
        <section>
          <Card>
            <CardContent className="space-y-4 p-4 sm:p-6">
              <h3 className="text-sm font-medium text-muted">Invite a teammate</h3>
              <InviteForm />
              {invites.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-muted">Pending &amp; past invites</h3>
                  <InvitesTable invites={invites} />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
