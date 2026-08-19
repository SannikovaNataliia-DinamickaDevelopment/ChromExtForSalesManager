import { formatKyivDate } from '../../lib/format-time';

// Kyiv-day date arithmetic + presets for DateRangePicker.tsx — a React port of the dashboard's
// Jira-style range picker (backend/src/dashboard/dashboard-page.ts's createDateRangeFilter /
// buildDateRangePresets), ported rather than shared directly: the dashboard is server-rendered
// vanilla JS with no build step, the side panel is a bundled React app — no boundary between
// them to share code through. Same Kyiv-day convention, same preset set, same UTC-midnight date
// substrate (dateToYmdStr/ymdStrToDate below), just idiomatic TS instead of the original's
// vanilla DOM manipulation.

export interface DateRange {
  start: string; // YYYY-MM-DD, Kyiv-day, inclusive
  end: string; // YYYY-MM-DD, Kyiv-day, inclusive
}

export function ymdStrToDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function dateToYmdStr(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function formatUsDate(ymdStr: string): string {
  const [y, m, d] = ymdStr.split('-');
  return `${m}/${d}/${y}`;
}

export function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 86400000);
}

// Monday-start week, matching the dashboard's picker and this project's other Ukraine-facing UI.
function startOfWeek(date: Date): Date {
  const dow = date.getUTCDay();
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

export function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function startOfQuarter(date: Date): Date {
  const q = Math.floor(date.getUTCMonth() / 3);
  return new Date(Date.UTC(date.getUTCFullYear(), q * 3, 1));
}

function endOfQuarter(date: Date): Date {
  const q = Math.floor(date.getUTCMonth() / 3);
  return new Date(Date.UTC(date.getUTCFullYear(), q * 3 + 3, 0));
}

export function addMonths(date: Date, n: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
}

export function todayKyiv(): Date {
  return ymdStrToDate(formatKyivDate(new Date().toISOString()));
}

export interface DateRangePreset {
  label: string;
  start: Date;
  end: Date;
}

// Same 9 presets, same semantics, as the dashboard's buildDateRangePresets — "Previous 3
// months"/"Previous quarter" are the calendar months/quarter immediately preceding the current
// one, not a rolling "last N days".
export function buildDateRangePresets(today: Date): DateRangePreset[] {
  const weekStart = startOfWeek(today);
  const monthStart = startOfMonth(today);
  const quarterStart = startOfQuarter(today);
  const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const prevWeekStart = addDays(weekStart, -7);
  const prevMonthStart = addMonths(monthStart, -1);
  const prev3MonthsStart = addMonths(monthStart, -3);
  const prevQuarterStart = addMonths(quarterStart, -3);
  return [
    { label: 'Today', start: today, end: today },
    { label: 'Current week', start: weekStart, end: addDays(weekStart, 6) },
    { label: 'Current month', start: monthStart, end: endOfMonth(today) },
    { label: 'Current quarter', start: quarterStart, end: endOfQuarter(today) },
    { label: 'Current year', start: yearStart, end: new Date(Date.UTC(today.getUTCFullYear(), 11, 31)) },
    { label: 'Previous week', start: prevWeekStart, end: addDays(prevWeekStart, 6) },
    { label: 'Previous month', start: prevMonthStart, end: endOfMonth(prevMonthStart) },
    { label: 'Previous 3 months', start: prev3MonthsStart, end: endOfMonth(prevMonthStart) },
    { label: 'Previous quarter', start: prevQuarterStart, end: endOfMonth(addMonths(quarterStart, -1)) },
  ];
}

export const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
