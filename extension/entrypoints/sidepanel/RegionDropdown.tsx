import { useEffect, useRef, useState } from 'react';
import { INDEED_REGION_GROUPS, INDEED_REGIONS, type IndeedRegion } from '../../lib/indeed-regions';

// Indeed region picker (06.10 call): 62 country domains are too many for inline checkboxes, so
// they live in a dropdown — grouped by part of the world, filterable by name/domain, with
// all/none shortcuts for the whole list and per group.
export function RegionDropdown({
  selectedIds,
  onChange,
  disabled,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on any click outside the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = new Set(selectedIds);
  const needle = filter.trim().toLowerCase();
  const matches = (r: IndeedRegion) => !needle || r.label.toLowerCase().includes(needle) || r.host.includes(needle);

  // Emits ids in INDEED_REGIONS order so a run's region order never depends on click order.
  const emit = (ids: Set<string>) => onChange(INDEED_REGIONS.filter((r) => ids.has(r.id)).map((r) => r.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    emit(next);
  };
  const setMany = (regions: IndeedRegion[], on: boolean) => {
    const next = new Set(selected);
    for (const r of regions) {
      if (on) next.add(r.id);
      else next.delete(r.id);
    }
    emit(next);
  };

  const summary =
    selectedIds.length === 0
      ? 'No regions selected'
      : selectedIds.length <= 4
        ? INDEED_REGIONS.filter((r) => selected.has(r.id)).map((r) => r.label).join(', ')
        : `${selectedIds.length} of ${INDEED_REGIONS.length} regions`;

  return (
    <div className="region-dropdown" ref={rootRef}>
      <button
        type="button"
        className="region-dropdown-toggle"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
      >
        <span>{summary}</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="region-dropdown-panel">
          <input
            className="region-dropdown-filter"
            placeholder="Filter countries…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          <div className="region-dropdown-actions">
            <button type="button" onClick={() => setMany(INDEED_REGIONS.filter(matches), true)}>
              Select all{needle ? ' shown' : ''}
            </button>
            <button type="button" onClick={() => setMany(INDEED_REGIONS.filter(matches), false)}>
              Clear{needle ? ' shown' : ' all'}
            </button>
          </div>
          <div className="region-dropdown-list">
            {INDEED_REGION_GROUPS.map((group) => {
              const regions = INDEED_REGIONS.filter((r) => r.group === group && matches(r));
              if (regions.length === 0) return null;
              const allOn = regions.every((r) => selected.has(r.id));
              return (
                <div key={group} className="region-group">
                  <label className="region-group-header">
                    <input type="checkbox" checked={allOn} onChange={() => setMany(regions, !allOn)} />
                    {group}
                  </label>
                  {regions.map((r) => (
                    <label key={r.id} className="region-check" title={r.host}>
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                      {r.label}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
