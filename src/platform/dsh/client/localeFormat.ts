/**
 * Host-locale formatting for the clocks this panel prints.
 *
 * The audit table used `new Date(ts).toLocaleTimeString()` — the **browser's** default locale,
 * not the one the host is running in. In dsh those two can disagree: the host locale follows
 * the app's own setting while the renderer keeps the OS default, so a user who switched dsh to
 * English on a Chinese macOS got `上午10:03:21` in an otherwise English panel.
 *
 * The fix is not to hardcode a format but to ask the host once and reuse the answer, which is
 * what `setFormatLocale` is for. It is a module-level value rather than a React context because
 * the only consumer is a pure formatter called inside a `.map`; threading a provider through
 * three views would buy the same behaviour with more moving parts.
 *
 * `hour12: false` is deliberate even for `en`: this column is a *timestamp next to a decision*,
 * where `10:03:21` and `10:03:21 PM` carry the same information and the 24-hour form is two
 * characters narrower. It is also the only form that stays aligned row to row.
 */
let hostLocale: string | undefined;

/** Record the host locale. An empty or missing value means "keep the runtime default". */
export function setFormatLocale(locale: string | undefined | null): void {
  hostLocale = typeof locale === 'string' && locale.trim() !== '' ? locale : undefined;
}

/** The locale currently in effect — exposed for tests, which need to see the plumbing work. */
export function currentFormatLocale(): string | undefined {
  return hostLocale;
}

/** `HH:MM:SS` in the host locale, or `-` for a timestamp that will not parse. */
export function formatClock(value: number | string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  try {
    return new Intl.DateTimeFormat(hostLocale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  } catch {
    // A malformed locale tag throws a RangeError. Falling back is better than blanking the
    // column: the row's decision still has to be readable next to something.
    return date.toLocaleTimeString();
  }
}
