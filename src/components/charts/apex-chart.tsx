"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { ApexOptions } from "apexcharts";
import { buildChartOptions, useChartColors } from "@/lib/chart-theme";

const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

type ChartType = "line" | "area" | "bar" | "radialBar" | "donut" | "pie";

export function ApexChart({
  type,
  series,
  options,
  height = 280,
  width = "100%",
}: {
  type: ChartType;
  series: ApexOptions["series"];
  options?: ApexOptions;
  height?: number | string;
  width?: number | string;
}) {
  const colors = useChartColors();
  const merged = useMemo(
    () => buildChartOptions(colors, { ...options, chart: { ...options?.chart, type } }),
    [colors, options, type],
  );

  return (
    <ReactApexChart
      type={type}
      series={series}
      options={merged}
      height={height}
      width={width}
    />
  );
}
