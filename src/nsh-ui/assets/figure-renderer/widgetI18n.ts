import { createContext, useContext } from 'react';
import { dateFormatterAtLocale } from '../../../shared/i18n/formatDate';
import { numberFormatterAtLocale } from '../../../shared/i18n/formatNumber';

export type WidgetMessage = 'shared:tools.search' | `visualize.${
  'asyncBoundary' | 'critical' | 'day' | 'direct' | 'draftUnavailable' | 'end' | 'estimatedPath' | 'followUp' | 'functions' |
  'month' | 'next' | 'now' | 'previous' | 'range' | 'runtimeFrames' | 'saveFailed' | 'sort' |
  'start' | 'total' | 'view' | 'week' | 'zoomIn' | 'zoomOut'}`;
export type WidgetMessages = Record<WidgetMessage, string>;

export function widgetI18n(messages: WidgetMessages, currentLanguage: string) {
  return {
    t: (key: WidgetMessage) => messages[key],
    currentLanguage,
    formatDate: dateFormatterAtLocale(currentLanguage),
    formatNumber: numberFormatterAtLocale(currentLanguage),
  };
}

export const WidgetI18n = createContext<ReturnType<typeof widgetI18n> | null>(null);

export function useWidgetI18n() {
  const i18n = useContext(WidgetI18n);
  if (!i18n) throw new Error('Missing figure widget locale');
  return i18n;
}
