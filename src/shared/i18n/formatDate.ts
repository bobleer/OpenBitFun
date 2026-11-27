/** Formats a civil date for an isolated document using the controller's locale. */
export function dateFormatterAtLocale(locale: string) {
  return (date: Date, options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(locale, options).format(date);
}
