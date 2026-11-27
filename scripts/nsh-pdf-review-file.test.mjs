import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { exportReviewedPdf, inspectReviewedPdf } from './nsh-pdf-review-file.js';

const createdAt = '2026-01-02T00:00:00.000Z';
const review = {
  version: 1, fingerprint: 'same-build', futureField: { from: 'main' },
  annotations: [
    { id: 'note', kind: 'note', rect: [20, 20, 40, 40], page: 1, color: 'yellow', createdAt,
      comments: [{ id: 'one', body: '正文批注', createdAt }, { id: 'two', body: '远端回复', createdAt }] },
    { id: 'mark', kind: 'highlight', rect: [40, 60, 90, 80], page: 1, color: 'green', createdAt,
      quads: [40, 80, 90, 80, 40, 60, 90, 60], comments: [] },
    { id: 'ink', kind: 'ink', rect: [100, 60, 130, 90], page: 1, color: 'blue', createdAt,
      strokes: [[100, 60, 115, 90, 130, 60]], comments: [] },
  ],
};

function annotations(pdf) {
  const raw = pdf.getPage(0).node.Annots();
  return Array.from({ length: raw.size() }, (_, index) => [raw.get(index), pdf.context.lookup(raw.get(index))]);
}

test('review PDF carries portable fields, Unicode threads and standard annotations through reopening', async () => {
  const original = await PDFDocument.create();
  const page = original.addPage();
  const field = original.getForm().createTextField('project');
  field.setText('Existing value');
  field.addToPage(page, { x: 40, y: 200, width: 180, height: 25 });
  page.node.addAnnot(original.context.register(original.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [100, 20, 120, 40],
    Contents: PDFHexString.fromText('External comment'),
  })));
  const originalBytes = await original.save();

  const output = await exportReviewedPdf(originalBytes, review);
  const pdf = await PDFDocument.load(output);
  const entries = annotations(pdf);
  const type = annotation => annotation.get(PDFName.of('Subtype'))?.toString();
  assert.deepEqual(entries.map(([, annotation]) => type(annotation)),
    ['/Widget', '/Text', '/Text', '/Text', '/Highlight', '/Ink']);
  const [noteRef, note] = entries[2];
  const [, reply] = entries[3];
  assert.equal(note.get(PDFName.of('Contents')).decodeText(), '正文批注');
  assert.equal(reply.get(PDFName.of('Contents')).decodeText(), '远端回复');
  assert.equal(reply.get(PDFName.of('IRT')).toString(), noteRef.toString());

  const reopened = await inspectReviewedPdf(output);
  assert.deepEqual(reopened.data, review);
  const revised = { ...reopened.data, annotations: reopened.data.annotations.slice(1) };
  const revisedBytes = await exportReviewedPdf(reopened.bytes, revised);
  const result = await PDFDocument.load(revisedBytes);
  const remaining = annotations(result);
  assert.deepEqual(remaining.map(([, annotation]) => type(annotation)), ['/Widget', '/Text', '/Highlight', '/Ink']);
  assert.equal(result.getForm().getTextField('project').getText(), 'Existing value');
  assert.equal(remaining[1][1].get(PDFName.of('Contents')).decodeText(), 'External comment');
  assert.deepEqual((await inspectReviewedPdf(revisedBytes)).data, revised);
  assert.deepEqual(await inspectReviewedPdf(originalBytes), {});
});

test('review PDF refuses missing annotation pages and leaves unsupported embedded JSON intact', async () => {
  const original = await PDFDocument.create();
  original.addPage();
  const bytes = await original.save();
  await assert.rejects(exportReviewedPdf(bytes, {
    ...review, annotations: [{ ...review.annotations[0], page: 2 }],
  }), /missing-page/);
  original.catalog.set(PDFName.of('OpenBitFunReview'), PDFHexString.fromText('{"version":2}'));
  await assert.rejects(inspectReviewedPdf(await original.save()), /Unsupported PDF review format/);
});
