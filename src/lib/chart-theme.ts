"use client";

import { useMemo } from "react";
import { useTheme } from "next-themes";
import type { ApexOptions } from "apexcharts";
import { readThemeColors, type ThemeColors } from "@/lib/theme";

export function useChartColors() {
  const { resolvedTheme } = useTheme();
  return useMemo(
    () => readThemeColors(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedTheme],
  );
}

export function buildChartOptions(colors: ThemeColors, extra: ApexOptions = {}): ApexOptions {
  const theme = typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";

  return {
    chart: {
      fontFamily: "Public Sans, sans-serif",
      foreColor: colors.muted,
      toolbar: { show: false },
      zoom: { enabled: false },
      background: "transparent",
      ...extra.chart,
    },
    colors: extra.colors ?? [colors.primary, colors.success, colors.warning, colors.info, colors.danger],
    grid: {
      borderColor: colors.border,
      strokeDashArray: 6,
      xaxis: { lines: { show: false } },
      padding: { top: -10 },
      ...extra.grid,
    },
    dataLabels: extra.dataLabels ?? { enabled: false },
    stroke: { curve: "smooth", width: 2, ...extra.stroke },
    tooltip: { theme, ...extra.tooltip },
    legend: { labels: { colors: colors.body }, ...extra.legend },
    xaxis: {
      axisBorder: { show: false },
      axisTicks: { show: false },
      labels: { style: { colors: colors.muted, fontSize: "13px" } },
      ...extra.xaxis,
    },
    yaxis: extra.yaxis ?? {
      labels: { style: { colors: colors.muted, fontSize: "13px" } },
    },
    ...(extra.fill ? { fill: extra.fill } : {}),
    ...(extra.plotOptions ? { plotOptions: extra.plotOptions } : {}),
    ...(extra.labels ? { labels: extra.labels } : {}),
    ...(extra.states ? { states: extra.states } : {}),
  };
}
