import { useState } from 'react';
import type { VisualTable } from './document';
import { useWidgetI18n } from './widgetI18n';

const views = ['day', 'week', 'month'] as const;
type View = (typeof views)[number];

function plusDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function VisualCalendar({ rows }: VisualTable) {
  const { t, formatDate } = useWidgetI18n();
  const [view, setView] = useState<View>('day');
  const [anchor, setAnchor] = useState(() => new Date(String(rows[0][0]).slice(0, 10) + 'T00:00'));
  const start = new Date(anchor);
  if (view === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (view === 'month') start.setDate(1);
  const days = view === 'day' ? 1 : view === 'week' ? 7
    : new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const navigate = (step: number) => setAnchor(
    view === 'month'
      ? new Date(start.getFullYear(), start.getMonth() + step, 1)
      : plusDays(start, step * days),
  );
  const labels = { day: t('visualize.day'), week: t('visualize.week'), month: t('visualize.month') };
  return (
    <>
      <div className="visual-answer__controls">
        <button type="button" aria-label={t('visualize.previous')} onClick={() => navigate(-1)}>
          ‹
        </button>
        <label>
          {t('visualize.view')}{' '}
          <select value={view} onChange={(event) => setView(event.target.value as View)}>
            {views.map(key => <option key={key} value={key}>{labels[key]}</option>)}
          </select>
        </label>
        <button type="button" aria-label={t('visualize.next')} onClick={() => navigate(1)}>
          ›
        </button>
      </div>
      <div className="visual-answer__days" aria-live="polite">
        {Array.from({ length: days }, (_, index) => {
          const date = plusDays(start, index);
          const next = plusDays(date, 1);
          return (
            <section key={date.getTime()}>
              <strong>{formatDate(date, { month: 'short', day: 'numeric', weekday: 'short' })}</strong>
              {rows
                .filter(([from, to]) => new Date(String(from)) < next && new Date(String(to)) > date)
                .map(([from, to, name], eventIndex) => (
                  <p key={eventIndex}>
                    {String(name)} · {String(from).slice(11)}–{String(to).slice(11)}
                  </p>
                ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
