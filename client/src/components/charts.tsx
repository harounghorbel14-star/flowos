import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/*
 * Small SVG chart kit following the data-viz spec: thin marks, 4px rounded
 * data-ends anchored to a square baseline, 2px surface gaps, 2px lines, 8px
 * end-markers with a 2px surface ring, hairline recessive grid, one y-axis,
 * hover/focus tooltips that list every series, and a table view. All text
 * uses text tokens; series colors appear only on marks and keys.
 */

export interface Series {
  key: string;
  label: string;
  /** CSS color for the mark, e.g. "var(--series-1)". */
  color: string;
}

const MARGIN = { top: 16, right: 44, bottom: 28, left: 36 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Clean axis ticks: 0 and 3–5 round steps covering the max. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks[ticks.length - 1]! + step).toFixed(6)));
  return ticks;
}

const fmt = new Intl.NumberFormat();

/** Show every Nth x label so labels never collide; always keep the latest one. */
function labelStride(spacing: number, minGap = 56) {
  return Math.max(1, Math.ceil(minGap / Math.max(spacing, 1)));
}
const showLabel = (i: number, last: number, stride: number) => (last - i) % stride === 0;

function Tooltip({
  x,
  title,
  rows,
  width,
}: {
  x: number;
  title: string;
  rows: { label: string; value: string; color: string; line?: boolean }[];
  width: number;
}) {
  const left = Math.min(Math.max(x + 12, 0), width - 180);
  return (
    <div className="chart-tooltip" style={{ left }} role="status">
      <div className="chart-tooltip-title">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="chart-tooltip-row">
          <span className={r.line ? "key-line" : "key-rect"} style={{ background: r.color }} aria-hidden />
          <strong className="num">{r.value}</strong>
          <span className="muted">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ series, kind }: { series: Series[]; kind: "rect" | "line" }) {
  if (series.length < 2) return null;
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span key={s.key} className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
          <span
            className={kind === "line" ? "key-line" : "key-rect"}
            style={{ background: s.color }}
            aria-hidden
          />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function ChartTable({
  caption,
  categories,
  columns,
}: {
  caption: string;
  categories: string[];
  columns: { label: string; values: (number | null)[]; format?: (v: number) => string }[];
}) {
  return (
    <details className="chart-table">
      <summary>Show as table</summary>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="data">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th>Week</th>
              {columns.map((c) => (
                <th key={c.label}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat, i) => (
              <tr key={cat}>
                <td>{cat}</td>
                {columns.map((c) => {
                  const v = c.values[i];
                  return (
                    <td key={c.label} className="num">
                      {v === null || v === undefined ? "—" : c.format ? c.format(v) : fmt.format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Rounded-top column path: 4px radius at the data end, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return "";
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export function ColumnChart({
  categories,
  series,
  values,
  height = 220,
  ariaLabel,
}: {
  categories: string[];
  series: Series[];
  values: Record<string, number[]>;
  height?: number;
  ariaLabel: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...series.flatMap((s) => values[s.key] ?? []));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const band = plotW / categories.length;
  const barW = Math.min(24, (band * 0.7 - 2 * (series.length - 1)) / series.length);
  const groupW = barW * series.length + 2 * (series.length - 1);
  const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;
  const last = categories.length - 1;
  const stride = labelStride(band);

  return (
    <div ref={ref} className="chart" onPointerLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text
              x={MARGIN.left - 8}
              y={y(t)}
              className="chart-axis"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {fmt.format(t)}
            </text>
          </g>
        ))}
        {categories.map((cat, i) => {
          const gx = MARGIN.left + band * i + (band - groupW) / 2;
          return (
            <g
              key={cat}
              tabIndex={0}
              aria-label={`${cat}: ${series.map((s) => `${s.label} ${values[s.key]?.[i] ?? 0}`).join(", ")}`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className={hover === i ? "chart-group active" : "chart-group"}
            >
              <rect
                x={MARGIN.left + band * i}
                y={MARGIN.top}
                width={band}
                height={plotH}
                fill="transparent"
              />
              {series.map((s, j) => {
                const v = values[s.key]?.[i] ?? 0;
                const bx = gx + j * (barW + 2);
                return <path key={s.key} d={columnPath(bx, y(v), barW, y(0) - y(v))} fill={s.color} />;
              })}
              {/* Selective direct labels: values on the caps of the latest week only. */}
              {i === last
                ? series.map((s, j) => {
                    const v = values[s.key]?.[i] ?? 0;
                    return (
                      <text
                        key={s.key}
                        x={gx + j * (barW + 2) + barW / 2}
                        y={y(v) - 5}
                        textAnchor="middle"
                        className="chart-value"
                      >
                        {fmt.format(v)}
                      </text>
                    );
                  })
                : null}
              {showLabel(i, last, stride) ? (
                <text
                  x={MARGIN.left + band * i + band / 2}
                  y={height - 8}
                  textAnchor="middle"
                  className="chart-axis"
                >
                  {cat}
                </text>
              ) : null}
            </g>
          );
        })}
        <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} className="chart-baseline" />
      </svg>
      {hover !== null ? (
        <Tooltip
          width={width}
          x={MARGIN.left + band * hover + band / 2}
          title={categories[hover]!}
          rows={series.map((s) => ({
            label: s.label,
            value: fmt.format(values[s.key]?.[hover] ?? 0),
            color: s.color,
          }))}
        />
      ) : null}
    </div>
  );
}

export function LineChart({
  categories,
  series,
  values,
  height = 200,
  ariaLabel,
  format = (v) => fmt.format(v),
  emptyNote,
}: {
  categories: string[];
  series: Series[];
  values: Record<string, (number | null)[]>;
  height?: number;
  ariaLabel: string;
  format?: (v: number) => string;
  emptyNote?: ReactNode;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();
  const all = series.flatMap((s) => (values[s.key] ?? []).filter((v): v is number => v !== null));
  const max = Math.max(0, ...all);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const step = categories.length > 1 ? plotW / (categories.length - 1) : plotW;
  const x = (i: number) => MARGIN.left + i * step;
  const stride = labelStride(step);
  const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;

  const segments = (vals: (number | null)[]) => {
    // Gaps where there is no data — never interpolated.
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i)},${y(v)} `;
      pen = true;
    });
    return d.trim();
  };

  const pick = (clientX: number, el: SVGSVGElement) => {
    const px = clientX - el.getBoundingClientRect().left;
    setHover(Math.max(0, Math.min(categories.length - 1, Math.round((px - MARGIN.left) / step))));
  };

  return (
    <div ref={ref} className="chart" onPointerLeave={() => setHover(null)}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") setHover((h) => Math.min(categories.length - 1, (h ?? -1) + 1));
          if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? categories.length) - 1));
        }}
        onBlur={() => setHover(null)}
      >
        <clipPath id={clipId}>
          <rect x={0} y={0} width={width} height={height} />
        </clipPath>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text
              x={MARGIN.left - 8}
              y={y(t)}
              className="chart-axis"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {format(t)}
            </text>
          </g>
        ))}
        {categories.map((cat, i) =>
          showLabel(i, categories.length - 1, stride) ? (
            <text
              key={cat}
              x={x(i)}
              y={height - 8}
              textAnchor={i === categories.length - 1 ? "end" : "middle"}
              className="chart-axis"
            >
              {cat}
            </text>
          ) : null,
        )}
        {hover !== null ? (
          <line x1={x(hover)} x2={x(hover)} y1={MARGIN.top} y2={y(0)} className="chart-crosshair" />
        ) : null}
        {series.map((s) => {
          const vals = values[s.key] ?? [];
          const lastIdx = vals.map((v, i) => (v === null ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
          return (
            <g key={s.key} clipPath={`url(#${clipId})`}>
              <path
                d={segments(vals)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {/* Isolated points (no neighbours) still need a visible mark. */}
              {vals.map((v, i) =>
                v !== null && vals[i - 1] == null && vals[i + 1] == null && i !== lastIdx ? (
                  <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={s.color} />
                ) : null,
              )}
              {lastIdx >= 0 ? (
                <>
                  <circle
                    cx={x(lastIdx)}
                    cy={y(vals[lastIdx]!)}
                    r={4}
                    fill={s.color}
                    className="chart-endpoint"
                  />
                  <text
                    x={x(lastIdx) + 8}
                    y={y(vals[lastIdx]!)}
                    dominantBaseline="middle"
                    className="chart-value"
                  >
                    {format(vals[lastIdx]!)}
                  </text>
                </>
              ) : null}
              {hover !== null && vals[hover] !== null && vals[hover] !== undefined ? (
                <circle cx={x(hover)} cy={y(vals[hover]!)} r={4} fill={s.color} className="chart-endpoint" />
              ) : null}
            </g>
          );
        })}
        <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} className="chart-baseline" />
      </svg>
      {all.length === 0 && emptyNote ? <div className="chart-empty">{emptyNote}</div> : null}
      {hover !== null ? (
        <Tooltip
          width={width}
          x={x(hover)}
          title={categories[hover]!}
          rows={series.map((s) => {
            const v = values[s.key]?.[hover];
            return {
              label: s.label,
              value: v === null || v === undefined ? "No data" : format(v),
              color: s.color,
              line: true,
            };
          })}
        />
      ) : null}
    </div>
  );
}
