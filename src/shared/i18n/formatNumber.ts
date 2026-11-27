/** Number formatting for isolated UI documents that receive the surface locale. */
export function numberFormatterAtLocale(locale: string): (value: number, options?: Intl.NumberFormatOptions) => string {
  const fallback = new Intl.NumberFormat(locale);
  const formatters = new Map<string, Intl.NumberFormat>();
  return (value, options) => {
    if (!options) return fallback.format(value);
    const key = JSON.stringify(options);
    let formatter = formatters.get(key);
    if (!formatter) {
      try {
        formatter = new Intl.NumberFormat(locale, options);
      } catch {
        formatter = fallback;
      }
      formatters.set(key, formatter);
    }
    return formatter.format(value);
  };
}
