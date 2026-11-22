import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  isWithinBusinessHours,
  parseWeeklyHours,
  summarizeWeeklyHours,
} from "@/lib/business-hours";
import { prisma } from "@/lib/prisma";
import { getAvailability, getBusinessHours, requireWorkspace } from "@/lib/workspace";
import { BusinessHoursForm } from "./business-hours-form";

export const metadata = { title: "Business hours" };

export default async function BusinessHoursPage() {
  const ctx = await requireWorkspace("/settings/hours");
  const [mine, availability, members] = await Promise.all([
    getBusinessHours({ workspaceId: ctx.workspace.id, userId: ctx.user.id }),
    getAvailability(ctx.workspace.id),
    prisma.membership.findMany({
      where: { workspaceId: ctx.workspace.id },
      select: {
        id: true,
        userId: true,
        businessHours: true,
        businessHoursTimeZone: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const now = new Date();
  const team = members.map((m) => {
    const hours = parseWeeklyHours(m.businessHours);
    const timeZone = hours ? m.businessHoursTimeZone : null;
    return {
      id: m.id,
      name: m.user.name || m.user.email,
      you: m.userId === ctx.user.id,
      summary: hours ? summarizeWeeklyHours(hours) : null,
      timeZone,
      inHours: Boolean(hours && timeZone && isWithinBusinessHours(hours, timeZone, now)),
    };
  });

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-medium text-heading">Business hours</h2>
        <p className="mt-1 text-muted">
          With availability on <strong className="font-medium text-heading">Auto</strong>, every
          Product&apos;s chat shows Live while at least one teammate is inside their hours, and Away
          otherwise. Each person sets their own hours in their own time zone.
        </p>
        <p className="mt-2 text-sm text-body" data-testid="availability-mode">
          {availability.mode === "AUTO" ? (
            <>
              Availability is on Auto: chat is{" "}
              <strong className="font-medium text-heading">
                {availability.effective === "LIVE" ? "Live" : "Away"}
              </strong>{" "}
              right now.
            </>
          ) : (
            <>
              Availability is set to{" "}
              <strong className="font-medium text-heading">
                {availability.mode === "LIVE" ? "Live" : "Away"}
              </strong>{" "}
              by hand, so business hours are not used.{" "}
              {ctx.role === "ADMIN"
                ? "Choose Auto in the header to follow them."
                : "An admin can choose Auto to follow them."}
            </>
          )}
        </p>
      </header>

      <section>
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-6">
            <h3 className="text-sm font-medium text-muted">Your hours</h3>
            <BusinessHoursForm initialHours={mine.hours} initialTimeZone={mine.timeZone} />
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-6">
            <h3 className="text-sm font-medium text-muted">Team</h3>
            <ul className="divide-y divide-border" aria-label="Team business hours">
              {team.map((member) => (
                <li key={member.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                  <span className="min-w-0 flex-1 truncate font-medium text-heading">
                    {member.name}
                    {member.you ? <span className="font-normal text-muted"> (you)</span> : null}
                  </span>
                  <span className="w-full text-sm text-body sm:w-auto">
                    {member.summary ? (
                      <>
                        {member.summary}
                        <span className="text-muted"> · {member.timeZone}</span>
                      </>
                    ) : (
                      <span className="text-muted">No hours set</span>
                    )}
                  </span>
                  {member.summary ? (
                    <Badge variant="light" color={member.inHours ? "success" : "secondary"}>
                      {member.inHours ? "In hours now" : "Outside hours"}
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted">
              Teammates without hours never make chat Live on Auto. Invite people on the{" "}
              <Link href="/settings/team" className="text-primary hover:underline">
                Team
              </Link>{" "}
              tab.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
