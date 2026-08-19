import { useEffect, useRef, useState } from 'react';
import {
  addMonths,
  buildDateRangePresets,
  dateToYmdStr,
  formatUsDate,
  todayKyiv,
  WEEKDAY_LABELS,
  ymdStrToDate,
  type DateRange,
} from './date-range';

export type { DateRange } from './date-range';

interface Props {
  value: DateRange | null;
  onChange: (range: DateRange) => void;
  disabled?: boolean;
}

// Compact single-month React port of the dashboard's Jira-style range picker (see date-range.ts
// for why this is a port, not a shared import). Single month, not the dashboard's side-by-side
// two-month grid — the side panel is a narrow, user-resizable column, not a full page, so two
// calendars wouldn't comfortably fit; same interaction pattern otherwise (collapsed field with
// shift arrows, presets, click-click range pick with a live hover preview).
export default function DateRangePicker({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState<Date | null>(null);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const anchor = value ? ymdStrToDate(value.end) : todayKyiv();
    return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setPendingStart(null);
        setHoverDate(null);
      }
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setPendingStart(null);
        setHoverDate(null);
      }
    };
    document.addEventListener('mousedown', onOutsideClick);
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('mousedown', onOutsideClick);
      document.removeEventListener('keydown', onKeydown);
    };
  }, [open]);

  const applyRange = (a: Date, b: Date) => {
    const [start, end] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
    onChange({ start: dateToYmdStr(start), end: dateToYmdStr(end) });
    setPendingStart(null);
    setHoverDate(null);
    setOpen(false);
  };

  // Shifts the whole applied range backward/forward by its own inclusive day-span — same
  // "shift by the range's own width" convention as the dashboard picker's prev/next arrows.
  const shiftRange = (dir: 1 | -1) => {
    if (!value) return;
    const start = ymdStrToDate(value.start);
    const end = ymdStrToDate(value.end);
    const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    const deltaMs = dir * spanDays * 86400000;
    onChange({ start: dateToYmdStr(new Date(start.getTime() + deltaMs)), end: dateToYmdStr(new Date(end.getTime() + deltaMs)) });
  };

  const onDayClick = (date: Date) => {
    if (!pendingStart) {
      setPendingStart(date);
      setHoverDate(null);
      return;
    }
    applyRange(pendingStart, date);
  };

  const todayYmd = dateToYmdStr(todayKyiv());
  const committedStart = value ? ymdStrToDate(value.start) : null;
  const committedEnd = value ? ymdStrToDate(value.end) : null;
  const previewStart = pendingStart ?? committedStart;
  const previewEndRaw = pendingStart ? hoverDate ?? pendingStart : committedEnd;
  const previewEnd = previewStart && previewEndRaw && previewEndRaw.getTime() < previewStart.getTime() ? previewStart : previewEndRaw;
  const previewLo = previewStart && previewEnd && previewStart.getTime() <= previewEnd.getTime() ? previewStart : previewEnd;
  const previewHi = previewStart && previewEnd && previewStart.getTime() <= previewEnd.getTime() ? previewEnd : previewStart;

  const firstOfMonth = new Date(Date.UTC(viewMonth.getUTCFullYear(), viewMonth.getUTCMonth(), 1));
  const leadingBlank = (firstOfMonth.getUTCDay() + 6) % 7; // Monday-start offset
  const daysInMonth = new Date(Date.UTC(viewMonth.getUTCFullYear(), viewMonth.getUTCMonth() + 1, 0)).getUTCDate();

  const dayCells: JSX.Element[] = [];
  for (let i = 0; i < leadingBlank; i++) {
    dayCells.push(<span key={`blank-${i}`} className="date-range-day outside" />);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const cellDate = new Date(Date.UTC(viewMonth.getUTCFullYear(), viewMonth.getUTCMonth(), d));
    const ymd = dateToYmdStr(cellDate);
    const classes = ['date-range-day'];
    if (ymd === todayYmd) classes.push('today');
    if (previewLo && previewHi) {
      if (ymd === dateToYmdStr(previewLo)) classes.push('range-start');
      if (ymd === dateToYmdStr(previewHi)) classes.push('range-end');
      if (cellDate.getTime() > previewLo.getTime() && cellDate.getTime() < previewHi.getTime()) classes.push('in-range');
    }
    dayCells.push(
      <button
        key={ymd}
        type="button"
        className={classes.join(' ')}
        onClick={() => onDayClick(cellDate)}
        onMouseEnter={() => pendingStart && setHoverDate(cellDate)}
      >
        {d}
      </button>,
    );
  }

  return (
    <div className="date-range-picker" ref={containerRef}>
      <div className="date-range-field-row">
        <button type="button" className="date-range-nav" onClick={() => shiftRange(-1)} disabled={!value || disabled} aria-label="Shift range earlier">
          ‹
        </button>
        <button
          type="button"
          className="date-range-field"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled}
        >
          {value ? `${formatUsDate(value.start)}  →  ${formatUsDate(value.end)}` : 'Select date range'}
        </button>
        <button type="button" className="date-range-nav" onClick={() => shiftRange(1)} disabled={!value || disabled} aria-label="Shift range later">
          ›
        </button>
      </div>

      {open && (
        <div className="date-range-popover">
          <div className="date-range-presets">
            {buildDateRangePresets(todayKyiv()).map((p) => (
              <button key={p.label} type="button" className="date-range-preset-btn" onClick={() => applyRange(p.start, p.end)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="date-range-calendar" onMouseLeave={() => pendingStart && setHoverDate(null)}>
            <div className="date-range-month-header">
              <button type="button" className="date-range-month-nav" onClick={() => setViewMonth(addMonths(viewMonth, -1))} aria-label="Previous month">
                ‹
              </button>
              <span>
                {viewMonth.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} {viewMonth.getUTCFullYear()}
              </span>
              <button type="button" className="date-range-month-nav" onClick={() => setViewMonth(addMonths(viewMonth, 1))} aria-label="Next month">
                ›
              </button>
            </div>
            <div className="date-range-weekdays">
              {WEEKDAY_LABELS.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div className="date-range-days">{dayCells}</div>
          </div>
        </div>
      )}
    </div>
  );
}
