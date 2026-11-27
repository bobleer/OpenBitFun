/** Compatible with main's v1 review sidecars. Geometry is in PDF user space. */
export type PdfReviewTool = "select" | "highlight" | "note" | "ink";
export type PdfReviewColor = "yellow" | "green" | "blue" | "pink";
export type PdfRect = [number, number, number, number];
export const MAX_REVIEW_JSON = 2 * 1024 * 1024;
export const MAX_REVIEW_PDF = 32 * 1024 * 1024;
export const PDF_REVIEW_CHUNK = 64 * 1024;

export interface PdfReviewComment {
  id: string;
  body: string;
  createdAt: string;
}

export interface PdfReviewAnnotation {
  id: string;
  kind: Exclude<PdfReviewTool, "select">;
  page: number;
  rect: PdfRect;
  color: PdfReviewColor;
  quote?: string;
  quads?: number[];
  strokes?: number[][];
  comments: PdfReviewComment[];
  resolved?: boolean;
  createdAt: string;
  [key: string]: unknown;
}

export interface PdfReviewData {
  version: 1;
  fingerprint: string;
  annotations: PdfReviewAnnotation[];
  [key: string]: unknown;
}

export const PDF_REVIEW_INK: Record<PdfReviewColor, [number, number, number]> = {
  yellow: [1, 0.82, 0.16], green: [0.27, 0.7, 0.36], blue: [0.22, 0.52, 0.95], pink: [0.91, 0.34, 0.55],
};

export const emptyPdfReview = (): PdfReviewData => ({ version: 1, fingerprint: "", annotations: [] });
export const pdfReviewSidecar = (path: string) => path + ".openbitfun-review.json";
export const annotatedPdfPath = (path: string) => path.replace(/\.(tex|pdf)$/i, "").replace(/\.annotated$/i, "") + ".annotated.pdf";

function coordinates(value: unknown, group: number, minimum: number): value is number[] {
  return Array.isArray(value) && value.length >= minimum && value.length % group === 0 && value.every(Number.isFinite);
}

export function isPdfReviewAnnotation(item: unknown): item is PdfReviewAnnotation {
  const annotation = item as Partial<PdfReviewAnnotation> | null;
  return Boolean(annotation && typeof annotation.id === "string" &&
    (annotation.kind === "highlight" || annotation.kind === "note" || annotation.kind === "ink") &&
    Number.isSafeInteger(annotation.page) && annotation.page! >= 1 &&
    coordinates(annotation.rect, 4, 4) && annotation.rect.length === 4 &&
    typeof annotation.color === "string" && Object.hasOwn(PDF_REVIEW_INK, annotation.color) &&
    typeof annotation.createdAt === "string" &&
    (annotation.quote === undefined || typeof annotation.quote === "string") &&
    (annotation.quads === undefined || coordinates(annotation.quads, 8, 0)) &&
    (annotation.strokes === undefined || (Array.isArray(annotation.strokes) &&
      annotation.strokes.every(stroke => coordinates(stroke, 2, 4)))) &&
    Array.isArray(annotation.comments) && annotation.comments.every(comment => comment &&
      typeof comment.id === "string" && typeof comment.body === "string" && typeof comment.createdAt === "string"));
}

export function parsePdfReview(text: string): PdfReviewData {
  const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  const review = data as Partial<PdfReviewData> | null;
  if (review?.version !== 1 || typeof review.fingerprint !== "string" || !Array.isArray(review.annotations)) {
    throw new Error("Unsupported PDF review format");
  }
  const ids = new Set<string>();
  for (const annotation of review.annotations) {
    if (!isPdfReviewAnnotation(annotation) || ids.has(annotation.id)) throw new Error("Invalid PDF review annotation");
    ids.add(annotation.id);
  }
  return review as PdfReviewData;
}
