import { PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { MAX_REVIEW_JSON, MAX_REVIEW_PDF, PDF_REVIEW_INK, parsePdfReview } from '../src/nsh-ui/src/pdfReviewData.ts';

const reviewKey = PDFName.of('OpenBitFunReview');
const annotationKey = PDFName.of('OpenBitFunReviewId');
const asPdfText = text => PDFHexString.fromText(text);
const createdAt = stamp => asPdfText('D:' + stamp.replace(/[-:TZ.]/g, '').slice(0, 14) + 'Z');
const load = bytes => PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
const save = pdf => pdf.save({ updateFieldAppearances: false });

function removeOwnedAnnotations(pdf) {
  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    for (let index = annotations.size() - 1; index >= 0; index--) {
      const annotation = pdf.context.lookup(annotations.get(index));
      if (annotation instanceof PDFDict && annotation.has(annotationKey)) annotations.remove(index);
    }
  }
}

/** Use the same portable catalog entry and editable annotations as main. */
export async function exportReviewedPdf(bytes, review) {
  const json = JSON.stringify(review);
  if (json.length > MAX_REVIEW_JSON) throw new Error('review-too-large');
  const pdf = await load(bytes);
  if (pdf.isEncrypted) throw new Error('encrypted');
  const pages = pdf.getPages();
  if (review.annotations.some(annotation => annotation.page > pages.length)) throw new Error('missing-page');
  removeOwnedAnnotations(pdf);
  pdf.catalog.set(reviewKey, asPdfText(json));
  const { context } = pdf;
  for (const annotation of review.annotations) {
    const page = pages[annotation.page - 1];
    const comments = annotation.comments;
    const common = {
      Type: 'Annot', P: page.ref, Rect: annotation.rect, F: 4, C: PDF_REVIEW_INK[annotation.color],
      OpenBitFunReviewId: asPdfText(annotation.id), NM: asPdfText(annotation.id), T: asPdfText('OpenBitFun'),
      Contents: asPdfText(comments[0]?.body || annotation.quote || ''), CreationDate: createdAt(annotation.createdAt),
    };
    const [left, bottom, right, top] = annotation.rect;
    const subtype = annotation.kind === 'highlight'
      ? { Subtype: 'Highlight', CA: 0.4, QuadPoints: annotation.quads?.length ? annotation.quads :
        [left, top, right, top, left, bottom, right, bottom] }
      : annotation.kind === 'ink'
        ? { Subtype: 'Ink', InkList: annotation.strokes ?? [], BS: { W: 2, S: 'S' } }
        : { Subtype: 'Text', Name: 'Comment', Open: false };
    const dictionary = context.obj({ ...common, ...subtype });
    if (annotation.resolved) {
      dictionary.set(PDFName.of('StateModel'), asPdfText('Review'));
      dictionary.set(PDFName.of('State'), asPdfText('Accepted'));
    }
    const reference = context.register(dictionary);
    page.node.addAnnot(reference);
    for (const comment of comments.slice(1)) {
      page.node.addAnnot(context.register(context.obj({
        ...common, Subtype: 'Text', Name: 'Comment', IRT: reference, RT: 'R',
        NM: asPdfText(comment.id), Contents: asPdfText(comment.body), CreationDate: createdAt(comment.createdAt),
      })));
    }
  }
  const result = await save(pdf);
  if (result.length > MAX_REVIEW_PDF) throw new Error('pdf-too-large');
  return result;
}

/** Strip previous OpenBitFun appearances only from the editing copy, leaving other annotations intact. */
export async function inspectReviewedPdf(bytes) {
  const pdf = await load(bytes);
  if (pdf.isEncrypted) return { blocked: 'encrypted' };
  const embedded = pdf.catalog.get(reviewKey);
  if (embedded === undefined) return {};
  const json = pdf.context.lookup(embedded, PDFHexString).decodeText();
  if (json.length > MAX_REVIEW_JSON) throw new Error('review-too-large');
  const data = parsePdfReview(json);
  removeOwnedAnnotations(pdf);
  pdf.catalog.delete(reviewKey);
  return { data, bytes: await save(pdf) };
}
