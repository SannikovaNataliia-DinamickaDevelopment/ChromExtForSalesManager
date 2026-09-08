// Dev vs prod backend (08.09 follow-up — proper dev/prod extension environments). Sourced from
// WXT's own per-mode env mechanism (.env.development / .env.production, WXT_BACKEND_URL — see
// those files' own comments, and env.d.ts for the ImportMetaEnv augmentation this needs).
// import.meta.env.MODE selects which file WXT loaded at build time: "development" for
// `npm run dev`/`wxt`, "production" for `wxt build`/`wxt zip` (WXT's own default mode-per-command
// mapping, confirmed against the installed wxt package's ConfigEnv.mode doc comment).
export const BACKEND_URL = import.meta.env.WXT_BACKEND_URL;
export const SUPPORTED_HOSTS = ['www.techjobs.ca', 'www.itjobs.ca', 'wellfound.com', 'www.devitjobs.nl', 'devitjobs.nl'];

export function isSupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return SUPPORTED_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
