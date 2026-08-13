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
