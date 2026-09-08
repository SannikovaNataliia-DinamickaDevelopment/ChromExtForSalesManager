import { defineConfig } from 'wxt';

// Stable manifest "key" -> stable Chrome extension ID (08.09 follow-up — proper dev/prod
// extension environments, so Nataliia's dev install and Mariia's prod install never collide and
// each keeps the SAME id across every reload/rebuild, unlike "Load unpacked" without a key,
// which reassigns a new id every time). Each is the base64 DER SubjectPublicKeyInfo of its own
// 2048-bit RSA keypair (extension/keys/{dev,prod}-key.pem, gitignored via the repo's existing
// *.pem rule — never commit the private key; only this public half goes in the manifest).
// Generated via `openssl genrsa 2048 | openssl rsa -pubout -outform DER | openssl base64 -A`,
// Chrome's own documented method (developer.chrome.com/docs/extensions/reference/manifest/key).
// Resulting extension ids (SHA256 of the DER, first 16 bytes, hex->a-p mapped — Chrome's own
// algorithm): dev = cddnmpgbpcpmoajbcgapcedmkmapcknb, prod = nhpiccgebokanacbobpehmodaiafhhco.
const DEV_MANIFEST_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8j7AgscvWglV+J7urKiRiMNFsCRhtJmbqbx+zgnZdBip6Y/7yDztgAEIFXbz6cWrr171qfjpIUxbDsIiHuKjZxpiRFKerf9HqNbbe+hbvE8mz1xO32s21jvyw9ExWRzm1HXGTu2HCwdbjWRTqt7CKkX+C67YKZrJOqcl/kywpRCNx5OSPRr7qJs9TSDWs3g/moERzAC07eWQksESVzJ873UQ70Qamoy+ASY6KC7LfYXN0PjndcBCY7aN0FsMnxEav+vdvhpQowAGPOA3p9Q0fJq6t3TRQ9j7S89dz/gvfG8MSezubm/6XuEy4J5Dk4KtGIbFybHVB+tJzyI+CULAWwIDAQAB';
const PROD_MANIFEST_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuxv56yKnVp7ermbXXU+YGaUO5ff65voGE4JIaS64IjmZo1oQLUEAtYrClv5awZNLyk7r8AvQeXC+86yTh10W08NZNyBUUSoqpeMgyNuXmGOGBeP/JKbRbiCZ+vbHIZlmpdu34VaVEa059sbfOy1ZEdCQGaio9XJVavOtvNNxnRjkQXWyIwOY7H8fGsXRrx5Sy7pW67R0uYplzAMnZQWrfKFllkAHHGeBuQcTGzFW4iYJnz+N+vsKCnhb2kdtZSj/5arrH1yn1Rsr5vrTAz2YD1D8iQuGkb/+Qe4ni2BioBextXwnuYNmJHPG6YAx/6bANZm+fQv/4FsUI8LDhmJ2cwIDAQAB';

// FR-4/host_permissions: the extension only ever talks to its own backend (dev: localhost,
// prod: a real deployed instance — see .env.production's own comment) and the supported job
// sites (CLAUDE.md "Deployment: LOCAL").
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'react',
    },
  }),
  // A function of the build env (08.09 follow-up), not a plain object — confirmed against the
  // installed wxt@0.19.29 package (types.d.ts's UserManifestFn/ConfigEnv) that `manifest` itself
  // supports this function form, same as `vite` above already did. `env.mode` is "development"
  // by default for `wxt`/`npm run dev` (root: `npm run dev:extension`), "production" by default
  // for `wxt build`/`wxt zip` — WXT's own default mode-per-command mapping, not something this
  // file decides. WXT_BACKEND_URL comes from process.env, populated by WXT's own loadEnv()
  // (wxt/dist/core/utils/env.mjs) from .env.<mode> BEFORE this function is actually invoked —
  // see .env.development/.env.production for the values themselves and lib/backend.ts for the
  // runtime-code counterpart (import.meta.env.WXT_BACKEND_URL, the Vite-bundled equivalent of
  // this same source-of-truth value).
  manifest: (env) => {
    const isProd = env.mode === 'production';
    const backendUrl = process.env.WXT_BACKEND_URL;
    if (!backendUrl) {
      throw new Error('WXT_BACKEND_URL is not set — check .env.development/.env.production.');
    }

    return {
      // Dev build gets a visually distinct name (08.09 follow-up) so it's never confused with
      // the prod install if the two are ever loaded side by side on one machine.
      name: isProd ? 'Sales Manager Lead Collector' : 'Sales Manager Lead Collector (Dev)',
      description: 'Batch-parses job listings and saves leads to the backend.',
      key: isProd ? PROD_MANIFEST_KEY : DEV_MANIFEST_KEY,
      // Only "sidePanel" is actually exercised by the code. Reading/navigating tabs (FR-4
      // button gating, multipage.ts's ?page=N walk, wellfound-deepen.ts's dedicated tab) works
      // off host_permissions below for the matched hosts, no "tabs"/"activeTab" grant needed;
      // there's no chrome.scripting.executeScript call since the content script auto-injects
      // via the matches below.
      // "storage" holds the backend session token (chrome.storage.local) per CLAUDE.md
      // NFR-9: chrome.storage is cache/token only, the backend stays the source of truth.
      permissions: ['sidePanel', 'storage'],
      host_permissions: [
        `${backendUrl}/*`,
        'https://www.techjobs.ca/*',
        'https://www.itjobs.ca/*',
        'https://wellfound.com/*',
        'https://www.devitjobs.nl/*',
        'https://devitjobs.nl/*',
      ],
      // Scoped to the backend's own origin ONLY (scheme+host+port — externally_connectable
      // match patterns don't consider path, so this covers every page served from there, not
      // "any site"). Two callers today, both on that one origin:
      // 1. /auth/callback (phase 5) hands the session token back via chrome.runtime.sendMessage,
      //    without chrome.identity or a Google-specific client.
      // 2. /dashboard's "Enrich" button (chrome.runtime.onMessageExternal in background.ts)
      //    triggers a single-lead deepen without opening the side panel.
      // dev/prod each point at their own backend (see backendUrl above) — never both at once,
      // per this task's own "single-origin per build" design; the backend's own
      // EXTENSION_ORIGIN/CORS handling is untouched by this.
      externally_connectable: {
        matches: [`${backendUrl}/*`],
      },
    };
  },
});
