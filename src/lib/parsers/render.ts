// Client for the standalone pdf-renderer service (poppler). Converts a PDF buffer
// into one base64 PNG data URL per page, suitable for the vision parser.
const RENDERER_URL = process.env.PDF_RENDERER_URL ?? "http://localhost:5001";

export interface RenderResult {
  images: string[];            // base64 PNG data URLs, one per rendered page
  truncated: boolean;          // true if the PDF had more pages than we rendered
  totalPages: number | null;   // real page count, when known
}

export async function renderPdfToImages(
  buffer: Buffer,
  opts?: { maxPages?: number; dpi?: number }
): Promise<RenderResult> {
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

  const data = (await res.json()) as { images: string[]; truncated?: boolean; totalPages?: number | null };
  return {
    images: (data.images ?? []).map((b64) => `data:image/png;base64,${b64}`),
    truncated: !!data.truncated,
    totalPages: data.totalPages ?? null,
  };
}

export interface BBoxWord {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface BBoxPage {
  width: number;
  height: number;
  words: BBoxWord[];
}

// Extract per-word bounding boxes from a (text-layer) PDF via poppler's pdftotext -bbox.
// Origin is top-left, y increasing downward — so yPercent = yCenter / page.height.
// Returns [] on any failure (caller degrades gracefully).
export async function extractPdfTextBoxes(
  buffer: Buffer,
  opts?: { maxPages?: number },
): Promise<BBoxPage[]> {
  const params = new URLSearchParams();
  if (opts?.maxPages) params.set("maxPages", String(opts.maxPages));

  try {
    const res = await fetch(`${RENDERER_URL}/textbox?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { pages?: BBoxPage[] };
    return data.pages ?? [];
  } catch {
    return [];
  }
}
