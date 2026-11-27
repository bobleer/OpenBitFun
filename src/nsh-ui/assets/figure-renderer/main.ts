import { init, use, type ECharts } from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart, FunnelChart, BoxplotChart, HeatmapChart, SankeyChart, CustomChart } from 'echarts/charts';
import { AriaComponent, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TitleComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { numberFormatterAtLocale } from '../../../shared/i18n/formatNumber';
import { chartInspection } from './chartInspection';
import { chartOptions } from './chartOptions';
import { withOverlays } from './chartOverlays';
import { filterVisualTable, parseBoundChart, parseVisualDocument, type BoundChart, type VisualDocument, type VisualSpec, type VisualTable } from './document';
import { decodeFigureReaderState, MAX_FIGURE_READER_BYTES, type FigureChartState, type FigureReaderEvent, type FigureReaderState } from './readerState';
import { mountLegacyView, mountWidget } from './mountWidget';
import type { WidgetMessages } from './widgetI18n';

use([BarChart, LineChart, PieChart, ScatterChart, FunnelChart, BoxplotChart, HeatmapChart, SankeyChart, CustomChart,
  AriaComponent, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent,
  TitleComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);

export interface FigureLabels {
  previewTitle?: string;
  all: string;
  data: string;
  empty: string;
  unavailable: string;
  more: string;
  start: string;
  end: string;
  selection: string;
  followUp: string;
  draftUnavailable: string;
  saveFailed: string;
  widget: WidgetMessages;
}

type ChartView = Pick<BoundChart, 'title' | 'spec'> & Partial<Pick<BoundChart, 'description' | 'summary' | 'height' | 'showHeader'>> & {
  table: VisualTable;
  reader: FigureChartState;
};

interface FigureReader {
  nonce: string;
  state: FigureReaderState | null;
  followUp: boolean;
}

function notifyHost(nonce: string, event: FigureReaderEvent): boolean {
  const bridge = (window as Window & { nsh?: { postMessage: (message: string) => void } }).nsh;
  if (!bridge) return false;
  const message = JSON.stringify({ figureReader: nonce, ...event });
  if (new TextEncoder().encode(message).length > MAX_FIGURE_READER_BYTES) return false;
  try {
    bridge.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function filterControl(field: string, groups: readonly string[], all: string, selected: string | null, change: (value: string | null) => void) {
  const select = node('select');
  [all, ...groups].forEach((label, index) => select.add(new Option(label, String(index))));
  select.value = String(selected === null ? 0 : groups.indexOf(selected) + 1);
  select.addEventListener('change', () => change(groups[Number(select.value) - 1] ?? null));
  const label = node('label', field);
  label.className = 'viz-filter';
  label.append(select);
  return label;
}

function renderDeclaration(root: HTMLElement, source: string, labels: FigureLabels, reader: FigureReader) {
  const declaration = parseVisualDocument(source);
  if (declaration.kind === 'widget') {
    mountWidget(root, {
      data: declaration.widget, title: declaration.title, messages: labels.widget, unavailable: labels.unavailable,
      showCaption: declaration.title !== labels.previewTitle?.trim(),
      initial: reader.state?.widget ?? {},
      save: widget => notifyHost(reader.nonce, { type: 'state', state: { group: null, charts: [], widget } }),
      follow: reader.followUp ? message => notifyHost(reader.nonce, { type: 'followUp', message }) : undefined,
    });
    return;
  }
  if (declaration.kind !== 'visual' && declaration.kind !== 'charts') throw new Error('Unsupported figure declaration');
  const parsed: Extract<VisualDocument, { kind: 'visual' | 'charts' }> = declaration;

  const formatNumber = numberFormatterAtLocale(document.documentElement.lang);
  const display = (value: string | number | null) => typeof value === 'number'
    ? formatNumber(value, { maximumSignificantDigits: 12 })
    : value ?? '—';
  const styles = getComputedStyle(root);
  const token = (key: string) => styles.getPropertyValue(key).trim();
  const colors = ['primary', 'viz-success', 'viz-warning', 'viz-info', 'viz-danger', 'muted-foreground'].map(key => token(`--${key}`));
  const charts: { chart: ECharts; observer: ResizeObserver }[] = [];
  const legacyViews: (() => void)[] = [];
  const contents = node('div');
  contents.className = 'viz-content';
  const saveStatus = node('p');
  saveStatus.className = 'viz-notice';
  saveStatus.setAttribute('role', 'status');
  if (parsed.title !== labels.previewTitle?.trim()) root.append(node('h1', parsed.title));
  root.append(contents, saveStatus);

  const filterField = parsed.kind === 'visual' ? parsed.spec.filterColumn : parsed.filter?.field;
  let groups: string[] = [];
  if (filterField) {
    if (parsed.kind === 'visual') {
      const column = parsed.spec.columns.indexOf(filterField);
      groups = [...new Set(parsed.spec.rows.map(row => String(row[column])))];
    } else {
      groups = parsed.filter?.groups ?? [];
    }
  }
  const restoredGroup = reader.state?.group;
  let group = restoredGroup != null && groups.includes(restoredGroup) ? restoredGroup : null;
  const restoredCharts = new Map(reader.state?.charts);
  const chartStates = new Map<string, FigureChartState>();
  for (const id of parsed.kind === 'visual' ? [''] : parsed.charts.map(chart => chart.id)) {
    chartStates.set(id, restoredCharts.get(id) ?? { hidden: [] });
  }
  function save() {
    saveStatus.textContent = notifyHost(reader.nonce, { type: 'state', state: { group, charts: [...chartStates] } })
      ? '' : labels.saveFailed;
  }

  function renderTable({ rows, columns }: VisualTable) {
    const table = node('table');
    const heading = table.createTHead().insertRow();
    columns.forEach(name => {
      const cell = node('th', name);
      cell.scope = 'col';
      heading.append(cell);
    });
    const body = table.createTBody();
    for (const row of rows) {
      const cells = body.insertRow();
      for (const value of row) cells.insertCell().textContent = display(value);
    }
    const scroll = node('div');
    scroll.className = 'viz-table';
    scroll.append(table);
    return scroll;
  }

  function renderSimulation(section: HTMLElement, table: VisualTable, selected: number, choose: (row: number) => void) {
    const label = node('label');
    const range = node('input');
    range.type = 'range';
    range.min = '0';
    range.max = String(table.rows.length - 1);
    range.value = String(selected);
    const parameter = node('span');
    const results = node('dl');
    results.setAttribute('aria-live', 'polite');
    function update() {
      const [input, ...values] = table.rows[Number(range.value)];
      parameter.textContent = `${table.columns[0]} · ${display(input)}`;
      range.setAttribute('aria-valuetext', display(input));
      results.replaceChildren(...values.flatMap((value, index) => [
        node('dt', table.columns[index + 1]), node('dd', display(value)),
      ]));
    }
    range.addEventListener('input', () => { update(); choose(Number(range.value)); });
    label.append(parameter, range);
    section.append(label, results);
    update();
  }

  function chartLegend(spec: VisualSpec, table: VisualTable): string[] {
    if (spec.options?.showLegend === false) return [];
    if (spec.kind === 'pie' && spec.options?.showLegend) return table.rows.map(row => String(row[0]));
    if (spec.kind === 'scatter' && table.columns.length === 3) return [...new Set(table.rows.map(row => String(row[2])))];
    if (['line', 'bar', 'area'].includes(spec.kind) && !spec.options?.uncertainty &&
        (table.columns.length > 2 || spec.options?.showLegend)) return table.columns.slice(1);
    return [];
  }

  function renderChart(
    section: HTMLElement,
    { spec, table, title, height, reader: selection }: ChartView,
    restoredRow: VisualTable['rows'][number] | undefined,
    choose: (row: VisualTable['rows'][number]) => void,
  ) {
    const hidden = new Set(selection.hidden);
    const plot = node('div');
    plot.className = 'viz-plot';
    plot.style.height = `${height ?? (spec.kind === 'sparkline' ? 80 : 300)}px`;
    plot.tabIndex = 0;
    plot.setAttribute('role', 'img');
    const output = node('output');
    output.setAttribute('aria-live', 'polite');
    const legend = node('div');
    legend.className = 'viz-controls';
    section.append(legend, plot, output);

    const chart = init(plot, document.documentElement.dataset.scheme === 'dark' ? 'dark' : undefined, { renderer: 'svg' });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(plot);
    charts.push({ chart, observer });
    let cursor = -1;
    let inspected: ReturnType<typeof chartInspection>;
    function inspect(index: number) {
      cursor = index;
      output.textContent = inspected[index]?.text ?? '';
    }
    function choosePoint(index: number) {
      inspect(index);
      const point = inspected[index];
      if (point && 'row' in point && typeof point.row === 'number') choose(table.rows[point.row]);
    }
    function draw() {
      inspected = chartInspection(spec, table, [...hidden], formatNumber);
      const localized = spec.kind === 'waterfall'
        ? { ...spec, options: { beginningLabel: labels.start, endingLabel: labels.end, ...spec.options } }
        : spec;
      const options = chartOptions(localized, table, colors, token('--foreground'), token('--border'), hidden, formatNumber);
      if (options.legend && !Array.isArray(options.legend)) options.legend = {
        ...(options.legend as object), show: false, selected: Object.fromEntries([...hidden].map(name => [name, false])),
      };
      if (!['sankey', 'flame-chart', 'box-plot', 'waterfall', 'ranking', 'request-waterfall'].includes(spec.kind)) {
        options.tooltip = { ...(options.tooltip as object), formatter: (point: { dataIndex: number; data?: { rowIndex?: number } }) =>
          inspected[point.data?.rowIndex ?? point.dataIndex]?.text ?? '' };
      }
      chart.setOption({ ...withOverlays(options, spec, table), backgroundColor: 'transparent' }, true);
      plot.setAttribute('aria-label', title);
    }
    for (const name of chartLegend(spec, table)) {
      const button = node('button', name);
      button.type = 'button';
      const update = () => button.setAttribute('aria-pressed', String(!hidden.has(name)));
      button.addEventListener('click', () => {
        if (hidden.has(name)) hidden.delete(name);
        else hidden.add(name);
        selection.hidden = [...hidden];
        update();
        draw();
        inspect(cursor);
        save();
      });
      update();
      legend.append(button);
    }
    chart.on('click', event => {
      if (event.componentType !== 'series' || spec.kind === 'flame-chart') return;
      if (spec.kind === 'sankey' && (table.columns.length > 3 || spec.options?.staged || event.dataType !== 'edge')) return;
      let index = (event.data as { rowIndex?: number } | undefined)?.rowIndex ?? event.dataIndex;
      if (spec.kind === 'waterfall' && (spec.options?.beginning !== undefined || spec.options?.ending !== undefined)) index--;
      if (index >= 0 && index < inspected.length) choosePoint(index);
    });
    plot.addEventListener('keydown', event => {
      const next = event.key === 'Escape' ? -1
        : event.key === 'Home' ? 0
        : event.key === 'End' ? inspected.length - 1
        : ['ArrowRight', 'ArrowDown'].includes(event.key) ? Math.min(inspected.length - 1, cursor + 1)
        : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? Math.max(0, cursor < 0 ? 0 : cursor - 1)
        : null;
      if (next === null) return;
      event.preventDefault();
      choosePoint(next);
      if (next < 0) chart.dispatchAction({ type: 'hideTip' });
    });
    draw();
    if (restoredRow) inspect(inspected!.findIndex(point => 'row' in point && typeof point.row === 'number' && table.rows[point.row] === restoredRow));
  }

  function renderView(view: ChartView) {
    const section = node('section');
    contents.append(section);
    if (view.showHeader && view.title) section.append(node('h2', view.title));
    if (view.description) section.append(node('p', view.description));
    const { table, spec, reader: selection } = view;
    const selectedRow = () => Math.min(selection.row ?? 0, table.rows.length - 1);
    const prompt = reader.followUp ? spec.followUp : undefined;
    const rowSelect = prompt && spec.kind !== 'simulation' ? node('select') : undefined;
    let legacy: ReturnType<typeof mountLegacyView> | undefined;
    function selectRow(index: number) {
      if (index < 0 || index >= table.rows.length) return;
      selection.row = index;
      if (rowSelect) rowSelect.value = String(index);
      legacy?.setSelected?.(index);
      save();
    }
    const restoredRow = selection.row === undefined ? undefined : table.rows[selectedRow()];
    const selectPoint = (row: VisualTable['rows'][number]) => selectRow(table.rows.indexOf(row));
    if (!table.rows.length) section.append(node('p', labels.empty));
    else if (spec.kind === 'table') section.append(renderTable(table));
    else if (spec.kind === 'calendar' || spec.kind === 'stack-trace') {
      const container = node('div');
      section.append(container);
      legacy = mountLegacyView(container, {
        kind: spec.kind, table, messages: labels.widget, unavailable: labels.unavailable,
        selected: selectedRow(), select: selectRow,
      });
      legacyViews.push(legacy.dispose);
    }
    else if (spec.kind === 'simulation') renderSimulation(section, table, selectedRow(), selectRow);
    else if (spec.kind === 'ranking') {
      const pageSize = spec.options?.pageSize ?? 10;
      let count = Math.min(selection.limit ?? pageSize, table.rows.length);
      const plot = node('div');
      const more = node('button', labels.more);
      more.type = 'button';
      section.append(plot, more);
      const rows = spec.options?.sortOrder === 'original' ? table.rows : [...table.rows]
        .sort((a, b) => (Number(b[1]) - Number(a[1])) * (spec.options?.sortOrder === 'ascending' ? -1 : 1));
      function drawRanking() {
        const previous = charts.findIndex(({ chart }) => plot.contains(chart.getDom()));
        if (previous >= 0) {
          const [{ chart, observer }] = charts.splice(previous, 1);
          observer.disconnect();
          chart.dispose();
        }
        plot.replaceChildren();
        renderChart(plot, { ...view, table: { ...table, rows: rows.slice(0, count) } }, restoredRow, selectPoint);
        more.hidden = count >= rows.length;
      }
      more.addEventListener('click', () => {
        count = Math.min(count + pageSize, table.rows.length);
        selection.limit = count;
        drawRanking();
        save();
      });
      drawRanking();
    } else renderChart(section, view, restoredRow, selectPoint);
    if (view.summary) section.append(node('p', view.summary));
    if (table.rows.length && !['table', 'calendar', 'stack-trace'].includes(spec.kind)) {
      const details = node('details');
      details.append(node('summary', labels.data));
      details.addEventListener('toggle', () => {
        if (details.open && details.children.length === 1) details.append(renderTable(table));
      });
      section.append(details);
    }
    if (prompt && table.rows.length) {
      const toolbar = node('div');
      toolbar.className = 'viz-controls';
      if (rowSelect) {
        const label = node('label', labels.selection);
        label.className = 'viz-filter';
        table.rows.forEach((row, i) => rowSelect.add(new Option(display(row[0]), String(i))));
        rowSelect.value = String(selectedRow());
        rowSelect.addEventListener('change', () => selectRow(Number(rowSelect.value)));
        label.append(rowSelect);
        toolbar.append(label);
      }
      const ask = node('button', labels.followUp);
      ask.type = 'button';
      const status = node('span');
      status.setAttribute('role', 'status');
      ask.addEventListener('click', () => {
        const row = table.rows[selectedRow()];
        const message = [prompt, view.title,
          ...(filterField && group !== null ? [`${filterField} = ${group}`] : []),
          ...row.map((value, column) => `${table.columns[column]} = ${display(value)}`),
        ].join('\n');
        if (!notifyHost(reader.nonce, { type: 'followUp', message })) status.textContent = labels.draftUnavailable;
      });
      toolbar.append(ask, status);
      section.append(toolbar);
    }
  }

  function render() {
    for (const dispose of legacyViews.splice(0)) dispose();
    for (const { chart, observer } of charts.splice(0)) {
      observer.disconnect();
      chart.dispose();
    }
    contents.replaceChildren();
    if (parsed.kind === 'visual') {
      renderView({ title: parsed.title, spec: parsed.spec, table: filterVisualTable(parsed.spec, group), reader: chartStates.get('')! });
    } else {
      const filter = parsed.filter;
      const selected = group;
      const views = selected !== null && filter
        ? filter.configs.map(config => parseBoundChart(config, { field: filter.field, value: selected }))
        : parsed.charts;
      for (const view of views) {
        renderView({ ...view, table: view.spec, reader: chartStates.get(view.id)! });
      }
    }
  }

  if (filterField) {
    root.insertBefore(filterControl(filterField, groups, labels.all, group, next => {
      group = next;
      for (const state of chartStates.values()) delete state.row;
      render();
      save();
    }), contents);
  }
  render();
}

const root = document.getElementById('openbitfun-figure-data');
if (root) {
  const labels = JSON.parse(root.dataset.labels ?? '{}') as FigureLabels;
  try {
    const source = new TextDecoder().decode(Uint8Array.from(atob(root.dataset.source ?? ''), char => char.charCodeAt(0)));
    const config = JSON.parse(root.dataset.reader ?? '{}') as Partial<FigureReader>;
    delete root.dataset.source;
    delete root.dataset.reader;
    renderDeclaration(root, source, labels, {
      nonce: config.nonce ?? '', state: decodeFigureReaderState(config.state), followUp: config.followUp === true,
    });
  } catch {
    const alert = node('p', labels.unavailable);
    alert.setAttribute('role', 'alert');
    root.replaceChildren(alert);
  }
}
