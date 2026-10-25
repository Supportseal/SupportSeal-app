"use client";

import { useMemo } from "react";
import { cn } from "@/lib/cn";

const colorTrack = {
  primary: "bg-primary",
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
} as const;

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  color = "primary",
  className,
}: {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  color?: keyof typeof colorTrack;
  className?: string;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={value}
      onChange={(event) => onValueChange(Number(event.target.value))}
      className={cn("vx-slider w-full", className)}
       style={{ accentColor: `var(--vx-${color})`, "--vx-slider-color": `var(--vx-${color})` } as React.CSSProperties}
    />
  );
}

export function RangeSlider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  color = "primary",
  className,
}: {
  value: [number, number];
  onValueChange: (value: [number, number]) => void;
  min?: number;
  max?: number;
  step?: number;
  color?: keyof typeof colorTrack;
  className?: string;
}) {
  const [start, end] = value;
  const left = ((start - min) / (max - min)) * 100;
  const right = ((end - min) / (max - min)) * 100;

  const pips = useMemo(() => {
    const marks: number[] = [];
    for (let i = min; i <= max; i += Math.max(step, (max - min) / 10)) marks.push(Math.round(i));
    return marks;
  }, [min, max, step]);

  return (
    <div className={cn("relative h-8", className)}>
      <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-hover" />
      <div
        className={cn("absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full", colorTrack[color])}
        style={{ left: `${left}%`, width: `${right - left}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={start}
        onChange={(event) => {
          const next = Number(event.target.value);
          onValueChange([Math.min(next, end), end]);
        }}
        className="vx-range-thumb absolute inset-0 z-10 w-full appearance-none bg-transparent"
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={end}
        onChange={(event) => {
          const next = Number(event.target.value);
          onValueChange([start, Math.max(next, start)]);
        }}
        className="vx-range-thumb absolute inset-0 z-20 w-full appearance-none bg-transparent"
      />
      <div className="sr-only">{pips.join(" ")}</div>
    </div>
  );
}

export function VerticalSlider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  color = "primary",
  className,
}: {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  color?: keyof typeof colorTrack;
  className?: string;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={(event) => onValueChange(Number(event.target.value))}
      className={cn("vx-slider h-40 w-8 cursor-pointer [writing-mode:vertical-lr] rotate-180", className)}
       style={{ accentColor: `var(--vx-${color})`, "--vx-slider-color": `var(--vx-${color})` } as React.CSSProperties}
    />
  );
}
