import type { CSSProperties } from "react";

/**
 * The FLOWOS mark: four corner pieces (streams of work, each entering through its own gap)
 * locked around a diamond core (the decision point). Geometry on a 48-unit grid; the static
 * copies in client/public (favicon, app icons) use the same paths.
 */
export const MARK_PIECES = [
  "M6 18V15A9 9 0 0 1 15 6H22",
  "M30 6H33A9 9 0 0 1 42 15V22",
  "M42 30V33A9 9 0 0 1 33 42H26",
  "M18 42H15A9 9 0 0 1 6 33V26",
] as const;
/** Each piece's corner, as a unit direction: pieces converge along it and lean in on hover. */
const PIECE_DIR = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

type Tone = "auto" | "on-dark" | "mono";

export function LogoMark({
  size = 32,
  tone = "auto",
  state = "idle",
  reveal = false,
  glint = false,
  title,
  className,
  style,
}: {
  size?: number;
  /** "auto" follows the theme, "on-dark" is for dark brand surfaces, "mono" uses currentColor. */
  tone?: Tone;
  /** "working" only while something real is in progress (a request, a reply on its way). */
  state?: "idle" | "working";
  /** Play the convergence once on mount (timing from the --t custom property). */
  reveal?: boolean;
  /** Edge light that travels along the pieces (brand stage only). */
  glint?: boolean;
  /** Accessible name; without it the mark is decorative. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={["logo-mark", reveal && "lm-reveal", className].filter(Boolean).join(" ")}
      data-tone={tone}
      data-state={state}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      style={style}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: false })}
    >
      <g fill="none" stroke="currentColor" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round">
        {MARK_PIECES.map((d, i) => (
          <path
            key={i}
            className="lm-piece"
            d={d}
            style={{ "--i": i, "--dx": PIECE_DIR[i]![0], "--dy": PIECE_DIR[i]![1] } as CSSProperties}
          />
        ))}
        {glint
          ? MARK_PIECES.map((d, i) => (
              <path key={i} className="lm-glint" d={d} pathLength={1} style={{ "--i": i } as CSSProperties} />
            ))
          : null}
      </g>
      {/* The group animates; the rect keeps its own rotation. */}
      <g className="lm-core" fill="currentColor">
        <rect x="19" y="19" width="10" height="10" rx="2.2" transform="rotate(45 24 24)" />
      </g>
    </svg>
  );
}

/**
 * The FLOWOS wordmark, drawn (not typeset) so it renders identically without web fonts.
 * Monoline strokes with the mark's rounded corners; the O of OS carries the core.
 */
export function Wordmark({
  height = 14,
  title = "FLOWOS",
  className,
}: {
  height?: number;
  /** Pass null when visible text next to it already names the product. */
  title?: string | null;
  className?: string;
}) {
  return (
    <svg
      className={["wordmark", className].filter(Boolean).join(" ")}
      viewBox="0 0 134.4 24"
      height={height}
      width={(height * 134.4) / 24}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: false })}
    >
      <g
        className="wm-letters"
        fill="none"
        stroke="currentColor"
        strokeWidth={3.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1.7 22.3V1.7H14M1.7 11.6H11.6" />
        <path d="M21 1.7V22.3H32.3" />
        <rect x="39.3" y="1.7" width="17.6" height="20.6" rx="6.2" />
        <path d="M63.9 1.7L69.4 22.3L75.2 7.5L81 22.3L86.5 1.7" />
        <rect x="93.5" y="1.7" width="17.6" height="20.6" rx="6.2" />
        <path d="M132.7 1.7H123.1A5 5 0 0 0 118.1 6.7V7A5 5 0 0 0 123.1 12H127.7A5 5 0 0 1 132.7 17V17.3A5 5 0 0 1 127.7 22.3H118.1" />
      </g>
      <rect
        className="wm-core"
        fill="currentColor"
        x="99.6"
        y="9.3"
        width="5.4"
        height="5.4"
        rx="1.1"
        transform="rotate(45 102.3 12)"
      />
    </svg>
  );
}

/** Mark and wordmark side by side. The link or heading around it carries the name. */
export function Lockup({
  size = 26,
  tone = "auto",
  reveal = false,
}: {
  size?: number;
  tone?: Tone;
  reveal?: boolean;
}) {
  return (
    <span className="lockup">
      <LogoMark size={size} tone={tone} reveal={reveal} />
      <Wordmark height={Math.round(size * 0.46)} title={null} />
    </span>
  );
}

/**
 * Shown only while something is genuinely loading (the session check at startup). It fades in
 * after a short delay so fast loads never flash it; the label is announced either way.
 */
export function BrandLoader({ label }: { label: string }) {
  return (
    <div className="brand-loader" role="status" aria-busy="true">
      <LogoMark size={44} state="working" />
      <span className="eyebrow">{label}</span>
    </div>
  );
}
