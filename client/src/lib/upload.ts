import { getActiveOrgId } from "./trpc";

export interface UploadMeta {
  title: string;
  fileName: string;
  description?: string | null;
  category: string;
  visibility: string;
  employeeId?: string | null;
  expiresOn?: string | null;
}

/** Upload raw bytes to the document endpoint. Metadata travels as a URI-encoded JSON header. */
export async function uploadDocument(file: File, meta: UploadMeta): Promise<{ id: string }> {
  const orgId = getActiveOrgId();
  if (!orgId) throw new Error("No organization selected.");
  const res = await fetch("/api/documents/upload", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-flowos-client": "web",
      "x-flowos-org": orgId,
      "x-flowos-meta": encodeURIComponent(JSON.stringify(meta)),
    },
    body: file,
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status}).`);
  return { id: body.id! };
}

export function downloadUrl(documentId: string): string {
  return `/api/documents/${documentId}/download?org=${encodeURIComponent(getActiveOrgId() ?? "")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
