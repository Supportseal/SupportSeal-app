"use client";

import { useActionState, useMemo, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { inputVariants } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_WEEKLY_HOURS,
  WEEKDAYS,
  formatTime,
  parseTime,
  type WeeklyHours,
} from "@/lib/business-hours";
import { cn } from "@/lib/cn";
import { saveBusinessHoursAction, type BusinessHoursFormState } from "./actions";

type DayRow = { on: boolean; start: string; end: string };

const initialState: BusinessHoursFormState = {};

function rowsFrom(hours: WeeklyHours | null): DayRow[] {
  const source = hours ?? DEFAULT_WEEKLY_HOURS;
  return source.map((day) =>
    day
      ? { on: true, start: formatTime(day.start), end: formatTime(day.end) }
      : { on: false, start: "09:00", end: "17:00" },
  );
}

function allTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

const noopSubscribe = () => () => undefined;
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The member's own weekly schedule: one row per weekday with an on/off box
 * and a start and end time, plus the time zone the times are in. A day whose
 * end is earlier than its start runs past midnight; equal times = all day.
 */
export function BusinessHoursForm({
  initialHours,
  initialTimeZone,
}: {
  initialHours: WeeklyHours | null;
  initialTimeZone: string | null;
}) {
  const [state, formAction, pending] = useActionState(saveBusinessHoursAction, initialState);
  const [enabled, setEnabled] = useState(initialHours !== null);
  const [rows, setRows] = useState<DayRow[]>(() => rowsFrom(initialHours));
  // First visit: start from the browser's own time zone. Read through
  // useSyncExternalStore so the server render ("UTC") and hydration agree.
  const browserZone = useSyncExternalStore(noopSubscribe, browserTimeZone, () => "UTC");
  const [chosenZone, setTimeZone] = useState<string | null>(initialTimeZone);
  const timeZone = chosenZone ?? browserZone;
  const zones = useMemo(() => {
    // Chrome leaves "UTC" out of supportedValuesOf; offer it always.
    const list = allTimeZones();
    const withUtc = list.includes("UTC") ? list : [...list, "UTC"];
    return withUtc.includes(timeZone) ? withUtc : [timeZone, ...withUtc];
  }, [timeZone]);

  const hours: WeeklyHours = rows.map((row) => {
    if (!row.on) return null;
    const start = parseTime(row.start);
    const end = parseTime(row.end);
    return start === null || end === null ? null : { start, end };
  });
  const missingTime = rows.some((row) => row.on && (parseTime(row.start) === null || parseTime(row.end) === null));

  function update(index: number, patch: Partial<DayRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="enabled" value={enabled ? "on" : "off"} />
      <input type="hidden" name="hours" value={JSON.stringify(hours)} />
      <div className="flex items-center gap-3">
        <Switch
          id="bh-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={pending}
          aria-describedby="bh-enabled-hint"
        />
        <Label htmlFor="bh-enabled" className="mb-0">
          Use business hours
        </Label>
      </div>
      <p id="bh-enabled-hint" className="text-sm text-muted">
        When this is off, you never count as available on Auto.
      </p>

      <fieldset disabled={!enabled || pending} className={cn("space-y-4", !enabled && "opacity-60")}>
        <div className="max-w-sm">
          <Label htmlFor="bh-timezone">Time zone</Label>
          <select
            id="bh-timezone"
            name="timeZone"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            className={cn(inputVariants({ size: "md" }))}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2" role="group" aria-label="Weekly hours">
          {rows.map((row, index) => {
            const day = WEEKDAYS[index];
            const note =
              !row.on || !row.start || !row.end
                ? null
                : row.end === row.start
                  ? "all day"
                  : row.end < row.start
                    ? "ends next day"
                    : null;
            return (
              <div key={day} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="flex w-32 items-center gap-2">
                  <Checkbox
                    id={`bh-day-${index}`}
                    checked={row.on}
                    onCheckedChange={(checked) => update(index, { on: checked === true })}
                  />
                  <Label htmlFor={`bh-day-${index}`} className="mb-0">
                    {day}
                  </Label>
                </div>
                {row.on ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      aria-label={`${day} start`}
                      value={row.start}
                      required
                      onChange={(event) => update(index, { start: event.target.value })}
                      className={cn(inputVariants({ size: "sm" }), "w-36")}
                    />
                    <span className="text-muted" aria-hidden>
                      –
                    </span>
                    <input
                      type="time"
                      aria-label={`${day} end`}
                      value={row.end}
                      required
                      onChange={(event) => update(index, { end: event.target.value })}
                      className={cn(inputVariants({ size: "sm" }), "w-36")}
                    />
                    {note ? <span className="text-xs text-muted">{note}</span> : null}
                  </div>
                ) : (
                  <span className="text-sm text-muted">Off</span>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      {state.error ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.saved && !pending ? (
        <p className="text-sm text-success" role="status">
          Business hours saved.
        </p>
      ) : null}
      <Button type="submit" disabled={pending || (enabled && missingTime)}>
        {pending ? "Saving…" : "Save business hours"}
      </Button>
    </form>
  );
}
