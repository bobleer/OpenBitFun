import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { VisualTable } from './document';
import { VisualCalendar } from './VisualCalendar';
import { VisualStackTrace } from './VisualStackTrace';
import { WidgetView } from './WidgetView';
import { WidgetI18n, widgetI18n, type WidgetMessages } from './widgetI18n';
import type { Widget } from './widgets';

declare const FIGURE_WIDGET_STYLE: string;

class WidgetErrorBoundary extends Component<{ message: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    return this.state.failed ? <p role="alert">{this.props.message}</p> : this.props.children;
  }
}

function figureRoot(root: HTMLElement, messages: WidgetMessages, unavailable: string) {
  if (!document.getElementById('openbitfun-figure-widget-style')) {
    const style = document.createElement('style');
    style.id = 'openbitfun-figure-widget-style';
    style.textContent = FIGURE_WIDGET_STYLE;
    document.head.append(style);
  }
  root.classList.add('figure-widget');
  const mounted = createRoot(root);
  const locale = widgetI18n(messages, document.documentElement.lang);
  return {
    render: (children: ReactNode) => mounted.render(
      <WidgetErrorBoundary message={unavailable}>
        <WidgetI18n.Provider value={locale}>{children}</WidgetI18n.Provider>
      </WidgetErrorBoundary>,
    ),
    dispose: () => mounted.unmount(),
  };
}

export function mountWidget(root: HTMLElement, props: {
  data: Widget;
  title: string;
  showCaption: boolean;
  messages: WidgetMessages;
  unavailable: string;
  initial: Record<string, string>;
  save: (state: Record<string, string>) => boolean;
  follow?: (message: string) => boolean;
}) {
  const { data, title, showCaption, messages, unavailable, initial, save, follow } = props;
  figureRoot(root, messages, unavailable).render(
    <WidgetView data={data} title={title} showCaption={showCaption} initial={initial} save={save} follow={follow} />,
  );
}

export function mountLegacyView(root: HTMLElement, props: {
  kind: 'calendar' | 'stack-trace';
  table: VisualTable;
  messages: WidgetMessages;
  unavailable: string;
  selected: number;
  select: (row: number) => void;
}) {
  const { kind, table, messages, unavailable, selected, select } = props;
  const { render, dispose } = figureRoot(root, messages, unavailable);
  if (kind === 'calendar') {
    render(<div className="visual-answer"><VisualCalendar {...table} /></div>);
    return { dispose };
  }
  const setSelected = (row: number) => render(
    <div className="visual-answer">
      <VisualStackTrace {...table} selected={row} select={select} />
    </div>,
  );
  setSelected(selected);
  return { dispose, setSelected };
}
