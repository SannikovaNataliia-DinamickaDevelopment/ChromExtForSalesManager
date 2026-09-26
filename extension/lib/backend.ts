// Dev vs prod backend (08.09 follow-up — proper dev/prod extension environments). Sourced from
// WXT's own per-mode env mechanism (.env.development / .env.production, WXT_BACKEND_URL — see
// those files' own comments, and env.d.ts for the ImportMetaEnv augmentation this needs).
// import.meta.env.MODE selects which file WXT loaded at build time: "development" for
// `npm run dev`/`wxt`, "production" for `wxt build`/`wxt zip` (WXT's own default mode-per-command
// mapping, confirmed against the installed wxt package's ConfigEnv.mode doc comment).
export const BACKEND_URL = import.meta.env.WXT_BACKEND_URL;
export const SUPPORTED_HOSTS = [
  'www.techjobs.ca',
  'www.itjobs.ca',
  'wellfound.com',
  'www.devitjobs.nl',
  'devitjobs.nl',
  // DI-2966: enables both the generic "Parse current list page" button and the tabSupported
  // hint for Indeed — App.tsx's handleParse has its own explicit branch to skip
  // FetchDeepening/Gemini for source_site 'indeed' (see that file), same as it already does for
  // 'wellfound'. Same Indeed hostname list as entrypoints/content.ts's PARSERS/matches and
  // wxt.config.ts's host_permissions (kept in sync manually — see content.ts's comment on why
  // this isn't a wildcard, and why the list isn't exhaustive across Indeed's many country
  // subdomains). ua.indeed.com added 23.09 follow-up — Nataliia's actual test site was missing
  // entirely, which is why the side panel offered no Indeed parsing at all despite the feature
  // already existing.
  'www.indeed.com',
  'indeed.com',
  'ca.indeed.com',
  'ua.indeed.com',
];

export function isSupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return SUPPORTED_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
