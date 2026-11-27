import type { VisualTable } from './document';
import { useWidgetI18n } from './widgetI18n';

export function VisualStackTrace({
  columns,
  rows,
  selected,
  select,
}: VisualTable & {
  selected: number;
  select: (row: number) => void;
}) {
  const { formatNumber } = useWidgetI18n();
  const [name, file, line, source] = rows[selected];
  const formatLine = (value: unknown) => formatNumber(Number(value), { useGrouping: false });
  return (
    <>
      <ol className="visual-answer__frames" aria-label={columns[0]}>
        {rows.map(([fn, path, lineNumber], index) => (
          <li key={index}>
            <button type="button" aria-pressed={index === selected} onClick={() => select(index)}>
              {String(fn)} · {String(path)}:{formatLine(lineNumber)}
            </button>
          </li>
        ))}
      </ol>
      <div aria-live="polite">
        <strong>{String(name)}</strong>{' '}
        <code>{String(file)}:{formatLine(line)}</code>
        {typeof source === 'string' && <pre><code>{source}</code></pre>}
      </div>
    </>
  );
}
