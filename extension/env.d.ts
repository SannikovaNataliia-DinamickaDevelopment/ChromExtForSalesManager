// Augments WXT's own auto-generated ImportMetaEnv (.wxt/types/globals.d.ts, regenerated on
// every `wxt prepare`/dev/build — never edit that file directly) with our one custom per-mode
// var. Declaration merging: TypeScript combines this interface with the generated one since
// both are ambient (no import/export in this file). See .env.development/.env.production for
// where WXT_BACKEND_URL's value actually comes from, and lib/backend.ts for the one place that
// reads it at runtime.
interface ImportMetaEnv {
  readonly WXT_BACKEND_URL: string;
}
