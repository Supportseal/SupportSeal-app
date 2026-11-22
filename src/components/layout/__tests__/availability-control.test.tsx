import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AvailabilityControl } from "@/components/layout/availability-control";

const noop = () => undefined;

describe("AvailabilityControl", () => {
  it("renders Live, Auto and Away as radios in a labelled group for admins", () => {
    const html = renderToStaticMarkup(
      <AvailabilityControl availability="LIVE" isAdmin onChange={noop} />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Support availability"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toContain("Live");
    expect(html).toContain("Auto");
    expect(html).toContain("Away");
  });

  it("marks only the current option as checked", () => {
    const html = renderToStaticMarkup(
      <AvailabilityControl availability="AWAY" isAdmin onChange={noop} />,
    );
    const radios = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    const [live, auto, away] = radios;
    expect(live).toContain('aria-checked="false"');
    expect(auto).toContain('aria-checked="false"');
    expect(away).toContain('aria-checked="true"');
    expect(away).toContain('data-state="checked"');
  });

  it("is a read-only status without radios for non-admins", () => {
    const html = renderToStaticMarkup(
      <AvailabilityControl availability="AWAY" isAdmin={false} onChange={noop} />,
    );
    expect(html).not.toContain('role="radio');
    expect(html).toContain("Away");
    expect(html).toContain("Only admins can change availability");
  });

  it("shows what Auto resolves to right now", () => {
    const admin = renderToStaticMarkup(
      <AvailabilityControl availability="AUTO" effective="AWAY" isAdmin onChange={noop} />,
    );
    expect(admin).toContain("Away now");
    expect(admin).toContain('href="/settings/hours"');
    const agent = renderToStaticMarkup(
      <AvailabilityControl availability="AUTO" effective="LIVE" isAdmin={false} onChange={noop} />,
    );
    expect(agent).toContain("Live");
    expect(agent).toContain("(auto)");
    expect(agent).not.toContain('role="radio');
  });
});
