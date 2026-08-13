import { formatKyivDate } from './format-time';

// Per-search-context "how far did we get" bookmark for Wellfound list pagination
// (wellfound-pagination.ts). chrome.storage.local, same persistence choice as the rest of the
// extension's non-token state (see theme.ts) — survives the side panel being torn down and
// rebuilt across opens.
//
// Keyed by the list's base URL with the `page` query param stripped: different role/filter
// searches on Wellfound (e.g. /role/r/software-engineer vs. /role/r/product-designer, or the
// same role with different filters) are different search contexts and must never share or
// clobber each other's progress.
const STORAGE_KEY = 'sm_wellfound_pagination_bookmarks';

export interface WellfoundPaginationBookmark {
  lastPage: number;
  // Full UTC timestamp of the last successful write (set() below always writes "now") — reused
  // as the expiration signal (see isBookmarkFresh) rather than adding a second, redundant date
  // field: storage stays UTC, Kyiv-day comparison happens at read time, same convention as
  // published_at/scraped_at elsewhere in this project.
  updatedAt: string;
}

type BookmarkMap = Record<string, WellfoundPaginationBookmark>;

// Not exported: callers go through getBookmark/setBookmark below, which always operate on an
// already-stripped key, so there's only ever one way to compute it.
export function stripPageParam(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('page');
  return parsed.toString();
}

function readMap(): Promise<BookmarkMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const value = result[STORAGE_KEY];
      resolve(value && typeof value === 'object' ? (value as BookmarkMap) : {});
    });
  });
}

function writeMap(map: BookmarkMap): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: map }, () => resolve());
  });
}

// baseUrl must already have its `page` param stripped (stripPageParam) — this function doesn't
// normalize it again so callers can't accidentally look up a slightly different key shape than
// what they stored under.
export async function getBookmark(baseUrl: string): Promise<WellfoundPaginationBookmark | null> {
  const map = await readMap();
  return map[baseUrl] ?? null;
}

// Always overwrites (never merges/increments) — both "Continue" and "Parse from here" in
// wellfound-pagination.ts compute the new lastPage themselves and call this once at the end of
// a run; "Parse from here" relies on this being a full overwrite to act as its override/safety
// valve even when that means moving the bookmark backward.
export async function setBookmark(baseUrl: string, lastPage: number): Promise<void> {
  const map = await readMap();
  map[baseUrl] = { lastPage, updatedAt: new Date().toISOString() };
  await writeMap(map);
}

// Wellfound's list isn't static — new postings shift what appears on any given page number
// over time, so resuming from a bookmark made on a previous day doesn't reliably continue
// where the manager left off. Calendar-day comparison (Kyiv time), not a rolling time window:
// a bookmark from 11pm yesterday is expired the moment it's past midnight Kyiv, while one from
// 1am today is still fresh even though less time has elapsed. `now` is a parameter (defaulting
// to the real current time) purely so callers/tests can pin it without faking the system clock.
export function isBookmarkFresh(bookmark: WellfoundPaginationBookmark, now: Date = new Date()): boolean {
  return formatKyivDate(bookmark.updatedAt) === formatKyivDate(now.toISOString());
}
