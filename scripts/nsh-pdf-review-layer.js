import { PDF_REVIEW_INK } from '../src/nsh-ui/src/pdfReviewData.ts';

function svg(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function bounds(points) {
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function polygon(viewport, corners) {
  const points = [];
  for (let index = 0; index < corners.length; index += 2) {
    points.push(viewport.convertToViewportPoint(corners[index], corners[index + 1]).join(','));
  }
  return points.join(' ');
}

const rectCorners = ([x1, y1, x2, y2]) => [x1, y1, x2, y1, x2, y2, x1, y2];

function inkColor(color) {
  return 'rgb(' + PDF_REVIEW_INK[color].map(value => Math.round(value * 255)).join(' ') + ')';
}

export function createPdfReviewLayer(stack, pages, report) {
  let tool = 'select';
  let canCopy = false;
  let color = 'yellow';
  let selected;
  let annotations = new Map();
  let gesture;

  function draw(record) {
    const { overlay, viewport, node } = record;
    if (!overlay || !viewport) return;
    overlay.replaceChildren();
    for (const annotation of annotations.get(Number(node.dataset.page)) ?? []) {
      const color = inkColor(annotation.color);
      const group = svg('g', { 'data-review-id': annotation.id });
      if (annotation.kind === 'ink' && annotation.strokes?.length) {
        for (const points of annotation.strokes) {
          group.append(svg('polyline', { points: polygon(viewport, points), fill: 'none', stroke: color,
            'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        }
      } else if (annotation.kind === 'highlight' && annotation.quads?.length) {
        for (let index = 0; index < annotation.quads.length; index += 8) {
          const [x1, y1, x2, y2, x3, y3, x4, y4] = annotation.quads.slice(index, index + 8);
          group.append(svg('polygon', { points: polygon(viewport, [x1, y1, x2, y2, x4, y4, x3, y3]),
            fill: color, opacity: 0.4 }));
        }
      } else {
        group.append(svg('polygon', { points: polygon(viewport, rectCorners(annotation.rect)), fill: color,
          opacity: annotation.kind === 'highlight' ? 0.4 : 0.9, stroke: 'CanvasText', 'stroke-opacity': 0.45 }));
      }
      if (tool === 'select') group.querySelectorAll('*').forEach(shape => { shape.style.pointerEvents = 'visiblePainted'; });
      if (annotation.id === selected) {
        group.append(svg('polygon', { points: polygon(viewport, rectCorners(annotation.rect)), fill: 'none',
          stroke: 'AccentColor', 'stroke-dasharray': '3 2', 'vector-effect': 'non-scaling-stroke' }));
      }
      overlay.append(group);
    }
    if (gesture?.record === record) overlay.append(gesture.line);
  }

  function update(input, copyAllowed) {
    if (!['select', 'highlight', 'note', 'ink'].includes(input.tool)) return;
    const previousTool = tool;
    canCopy = copyAllowed;
    tool = input.tool;
    if (Object.hasOwn(PDF_REVIEW_INK, input.color)) color = input.color;
    selected = input.selected;
    if (previousTool === 'ink' && tool !== 'ink') gesture = undefined;
    stack.dataset.reviewTool = tool;
    annotations = new Map();
    for (const annotation of input.annotations ?? []) {
      if (!Object.hasOwn(PDF_REVIEW_INK, annotation.color)) continue;
      let page = annotations.get(annotation.page);
      if (!page) annotations.set(annotation.page, page = []);
      page.push(annotation);
    }
    for (const page of pages) draw(page);
  }

  function attach(record, viewport) {
    record.viewport = viewport;
    record.overlay = svg('svg', { class: 'pdf-review-overlay', 'aria-hidden': 'true' });
    record.node.append(record.overlay);
    draw(record);
  }

  function detach(record) {
    if (gesture?.record === record) gesture = undefined;
    record.viewport = null;
    record.overlay = null;
  }

  function hit(event) {
    const node = event.target.closest?.('.pdf-page');
    const page = Number(node?.dataset.page);
    const record = pages[page - 1];
    return record?.viewport ? { record, node, page } : null;
  }

  function point(record, event) {
    const rect = record.node.getBoundingClientRect();
    return record.viewport.convertToPdfPoint(
      Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    );
  }

  stack.addEventListener('click', event => {
    const position = hit(event);
    if (!position) return;
    if (tool === 'select') {
      const id = event.target.closest?.('[data-review-id]')?.dataset.reviewId;
      if (id) report('review-select', { id });
    } else if (tool === 'note') {
      const [x, y] = point(position.record, event);
      report('review-add', { kind: 'note', page: position.page, rect: [x - 8, y - 8, x + 8, y + 8] });
    }
  });

  function addHighlight() {
    if (tool !== 'highlight' || !canCopy) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const first = range.startContainer.parentElement?.closest('.pdf-page');
    const last = range.endContainer.parentElement?.closest('.pdf-page');
    if (!first || first !== last) return;
    const page = Number(first.dataset.page);
    const viewport = pages[page - 1]?.viewport;
    if (!viewport) return;
    const area = first.getBoundingClientRect();
    const quads = [];
    for (const rect of Array.from(range.getClientRects()).slice(0, 256)) {
      const left = Math.max(0, rect.left - area.left);
      const top = Math.max(0, rect.top - area.top);
      const right = Math.min(area.width, rect.right - area.left);
      const bottom = Math.min(area.height, rect.bottom - area.top);
      if (right - left < 1 || bottom - top < 1) continue;
      quads.push(...viewport.convertToPdfPoint(left, top), ...viewport.convertToPdfPoint(right, top),
        ...viewport.convertToPdfPoint(left, bottom), ...viewport.convertToPdfPoint(right, bottom));
    }
    if (!quads.length) return;
    report('review-add', { kind: 'highlight', page, rect: bounds(quads), quads, quote: selection.toString().slice(0, 4000) });
    selection.removeAllRanges();
  }

  stack.addEventListener('pointerdown', event => {
    if (tool !== 'ink' || event.button !== 0) return;
    const position = hit(event);
    if (!position) return;
    const { record, page } = position;
    const line = svg('polyline', { fill: 'none', stroke: inkColor(color), 'stroke-width': 2 });
    record.overlay.append(line);
    gesture = { id: event.pointerId, record, page, points: point(record, event), line };
    stack.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  stack.addEventListener('pointermove', event => {
    if (gesture?.id !== event.pointerId || gesture.points.length >= 2048) return;
    gesture.points.push(...point(gesture.record, event));
    gesture.line.setAttribute('points', polygon(gesture.record.viewport, gesture.points));
  });

  stack.addEventListener('pointerup', event => {
    if (gesture?.id === event.pointerId) {
      const { points, page, line } = gesture;
      gesture = undefined;
      line.remove();
      if (points.length >= 4) report('review-add', { kind: 'ink', page, rect: bounds(points), strokes: [points] });
    } else if (tool === 'highlight') {
      setTimeout(addHighlight, 0);
    }
  });
  stack.addEventListener('pointercancel', event => {
    if (gesture?.id !== event.pointerId) return;
    gesture.line.remove();
    gesture = undefined;
  });

  return { attach, detach, update };
}
