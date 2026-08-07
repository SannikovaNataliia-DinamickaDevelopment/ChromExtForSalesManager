// Storage stays UTC (decision log: "snapshot in the DB, flat fields in Sheets"); this is
// purely a display-time conversion for the Sheet and the side panel (extension has its own copy).
export function formatKyivDateTime(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// Date-only variant for fields that carry no meaningful time component (e.g. published_at,
// parsed from a "Posted M/D/YYYY" card string).
export function formatKyivDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Dashboard stats strip's "New today": the UTC instant range covering "today" as a Kyiv wall
// clock date (storage stays UTC — decision log — so a naive UTC-day comparison would be wrong
// for roughly the first/last few hours of the Kyiv day, depending on DST).
//
// Approach: format `now` in the Kyiv timezone to get today's Y/M/D there, then derive Kyiv's
// current UTC offset by comparing "now formatted in Kyiv, then reparsed as if it were UTC"
// against the real UTC instant of `now` — the difference is exactly Kyiv's offset, DST
// included, with no timezone-math library needed.
export function getKyivTodayUtcRange(now: Date = new Date()): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');

  const kyivWallAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = kyivWallAsUtcMs - now.getTime();

  const kyivMidnightTodayUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), 0, 0, 0) - offsetMs;
  return {
    start: new Date(kyivMidnightTodayUtcMs),
    end: new Date(kyivMidnightTodayUtcMs + 24 * 60 * 60 * 1000),
  };
}
