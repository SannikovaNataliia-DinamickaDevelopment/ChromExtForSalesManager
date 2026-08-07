// Side panel light/dark toggle. chrome.storage.local (not localStorage) to match the rest of
// the extension's persistence — see auth.ts's token storage — and to survive the side panel
// page being torn down and rebuilt across opens, same as everything else backed by
// chrome.storage.local in this codebase.
const THEME_STORAGE_KEY = 'sm_theme';

export type Theme = 'light' | 'dark';

export function getStoredTheme(): Promise<Theme | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([THEME_STORAGE_KEY], (result) => {
      const value = result[THEME_STORAGE_KEY];
      resolve(value === 'light' || value === 'dark' ? value : null);
    });
  });
}

export function setStoredTheme(theme: Theme): void {
  chrome.storage.local.set({ [THEME_STORAGE_KEY]: theme });
}
