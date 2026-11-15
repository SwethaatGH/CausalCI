import type { ReactNode } from "react";
import type { TooltipProps } from "recharts";
import { resolveColor } from "../lib/utils";

/** Categorical palette: greys of distinct lightness, so categories never borrow the status colours. */
export const CATEGORICAL = ["var(--color-ink)", "var(--color-ink-3)", "var(--color-line-2)", "var(--color-ink-2)"];
/** Magnitude series are drawn in ink; red, yellow and green are reserved for status. */
export const SERIES = "var(--color-ink)";
export const GRID = "var(--color-line)";
export const AXIS = { stroke: "var(--color-line-2)", tick: { fill: "var(--color-ink-3)", fontSize: 11 }, tickLine: false, axisLine: false } as const;

/** Concrete chart colours for the current light/dark mode (resolved at render). */
export function chartColors() {
  return { series: resolveColor(SERIES), grid: resolveColor(GRID), panel: resolveColor("var(--color-panel)") };
}

export function ChartTooltip({ active, payload, label, format }: TooltipProps<number, string> & { format?: (label: string | number) => ReactNode }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-ink">{format ? format(label as string) : label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2 text-ink-2">
          <span className="h-2 w-2 rounded-sm" style={{ background: (p.color as string) ?? SERIES }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-3 font-mono text-ink">{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Accessible data table alternative for a chart. */
export function ChartTable({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-2 text-xs text-ink-2">
      <summary className="cursor-pointer select-none text-ink-3 hover:text-ink-2">View as table</summary>
      <div className="mt-2 max-h-48 overflow-auto rounded-md border border-line">
        <table className="w-full">
          <thead className="bg-panel-2 text-left text-ink-2">
            <tr>{columns.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {r.map((c, j) => <td key={j} className="px-2 py-1 font-mono">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
