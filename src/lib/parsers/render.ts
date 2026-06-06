// Client for the standalone pdf-renderer service (poppler). Converts a PDF buffer
// into one base64 PNG data URL per page, suitable for the vision parser.
const RENDERER_URL = process.env.PDF_RENDERER_URL ?? "http://localhost:5001";

export async function renderPdfToImages(
  buffer: Buffer,
  opts?: { maxPages?: number; dpi?: number }
): Promise<string[]> {
  const params = new URLSearchParams();
  if (opts?.maxPages) params.set("maxPages", String(opts.maxPages));
  if (opts?.dpi) params.set("dpi", String(opts.dpi));

  const res = await fetch(`${RENDERER_URL}/render?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: new Uint8Array(buffer),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`PDF renderer ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as { images: string[] };
  return (data.images ?? []).map((b64) => `data:image/png;base64,${b64}`);
}
