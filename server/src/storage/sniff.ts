/**
 * Identify a file from its bytes. Only an allow-list of inert formats is
 * accepted; anything a browser could execute (HTML, SVG, scripts) or any
 * binary we cannot identify is rejected regardless of its name or the
 * client-declared type.
 */
export interface Sniffed {
  mimeType: string;
  extension: string;
}

const starts = (buf: Buffer, sig: number[]) => sig.every((b, i) => buf[i] === b);

function isPlainText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, 64 * 1024));
  if (text.includes("�")) return false;
  // Refuse markup that could be rendered as a page if ever served inline.
  return !/^\s*<(?:!doctype|html|svg|script|\?xml)/i.test(text);
}

export function sniff(buf: Buffer, fileName: string): Sniffed | null {
  if (buf.length === 0) return null;
  if (starts(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mimeType: "application/pdf", extension: "pdf" };
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mimeType: "image/png", extension: "png" };
  if (starts(buf, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", extension: "jpg" };
  if (starts(buf, [0x50, 0x4b, 0x03, 0x04])) {
    // ZIP container: accept only Office Open XML documents by extension.
    const ext = fileName.toLowerCase().split(".").pop();
    if (ext === "docx")
      return {
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        extension: "docx",
      };
    if (ext === "xlsx")
      return {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: "xlsx",
      };
    if (ext === "pptx")
      return {
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        extension: "pptx",
      };
    return null;
  }
  if (isPlainText(buf)) {
    const ext = fileName.toLowerCase().split(".").pop();
    if (ext === "csv") return { mimeType: "text/csv", extension: "csv" };
    if (ext === "md") return { mimeType: "text/markdown", extension: "md" };
    return { mimeType: "text/plain", extension: "txt" };
  }
  return null;
}

/** A safe display/download name: no paths, no control characters, bounded length. */
export function safeFileName(name: string, extension: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    // Stripping control characters is the point of this pattern.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "")
    .replace(/\.[^.]*$/, "")
    .trim()
    .slice(0, 120);
  return `${base || "document"}.${extension}`;
}
