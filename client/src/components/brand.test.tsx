import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandLoader, LogoMark, MARK_PIECES, Wordmark } from "./brand";

const publicDir = path.resolve(import.meta.dirname, "../../public");

describe("logo rendering", () => {
  it("renders the four pieces and the core, decorative unless named", () => {
    const decorative = renderToStaticMarkup(<LogoMark />);
    expect(decorative.match(/class="lm-piece"/g)).toHaveLength(4);
    expect(decorative).toContain('class="lm-core"');
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain("role=");

    const named = renderToStaticMarkup(<LogoMark title="FLOWOS" />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="FLOWOS"');
    expect(named).not.toContain("aria-hidden");
  });

  it("supports every tone and state as data attributes", () => {
    for (const tone of ["auto", "on-dark", "mono"] as const) {
      expect(renderToStaticMarkup(<LogoMark tone={tone} />)).toContain(`data-tone="${tone}"`);
    }
    expect(renderToStaticMarkup(<LogoMark state="working" />)).toContain('data-state="working"');
    expect(renderToStaticMarkup(<LogoMark reveal />)).toContain("lm-reveal");
    expect(renderToStaticMarkup(<LogoMark />)).not.toContain("lm-glint");
    expect(renderToStaticMarkup(<LogoMark glint />).match(/class="lm-glint"/g)).toHaveLength(4);
  });

  it("draws the wordmark as paths, named FLOWOS unless told it is decorative", () => {
    const named = renderToStaticMarkup(<Wordmark />);
    expect(named).toContain('aria-label="FLOWOS"');
    expect(named).not.toMatch(/<text/);
    expect(renderToStaticMarkup(<Wordmark title={null} />)).toContain('aria-hidden="true"');
  });

  it("announces the loader label", () => {
    const html = renderToStaticMarkup(<BrandLoader label="Loading FLOWOS…" />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading FLOWOS…");
  });

  it("needs nothing from the network", () => {
    const html = renderToStaticMarkup(
      <>
        <LogoMark glint />
        <Wordmark />
      </>,
    );
    expect(html).not.toMatch(/https?:|url\(|<image|<use/);
  });

  it("keeps the favicon and app icons in step with the mark", () => {
    const favicon = fs.readFileSync(path.join(publicDir, "favicon.svg"), "utf8");
    for (const d of MARK_PIECES) expect(favicon).toContain(`d="${d}"`);
    expect(favicon).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, "site.webmanifest"), "utf8")) as {
      icons: { src: string }[];
    };
    for (const icon of manifest.icons) expect(fs.existsSync(path.join(publicDir, icon.src))).toBe(true);
    for (const png of ["apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
      const head = fs.readFileSync(path.join(publicDir, png)).subarray(0, 8);
      expect(head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    }
  });
});
