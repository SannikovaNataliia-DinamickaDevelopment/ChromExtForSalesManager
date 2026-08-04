import { defineConfig } from 'wxt';

// FR-4/host_permissions: the extension only ever talks to the local backend
// and the one supported job site (CLAUDE.md "Deployment: LOCAL").
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'react',
    },
  }),
  manifest: {
    name: 'Sales Manager Lead Collector',
    description: 'Batch-parses job listings and saves leads to the local backend.',
    // Only "sidePanel" is actually exercised by the code. Reading/navigating tabs (FR-4
    // button gating, multipage.ts's ?page=N walk, wellfound-deepen.ts's dedicated tab) works
    // off host_permissions below for the matched hosts, no "tabs"/"activeTab" grant needed;
    // there's no chrome.scripting.executeScript call since the content script auto-injects
    // via the matches below.
    // "storage" holds the backend session token (chrome.storage.local) per CLAUDE.md
    // NFR-9: chrome.storage is cache/token only, the backend stays the source of truth.
    permissions: ['sidePanel', 'storage'],
    host_permissions: [
      'http://localhost:3000/*',
      'https://www.techjobs.ca/*',
      'https://www.itjobs.ca/*',
      'https://wellfound.com/*',
      'https://www.devitjobs.nl/*',
      'https://devitjobs.nl/*',
    ],
    // Scoped to the local backend's origin ONLY (scheme+host+port — externally_connectable
    // match patterns don't consider path, so this covers every page served from there, not
    // "any site"). Two callers today, both on that one origin:
    // 1. /auth/callback (phase 5) hands the session token back via chrome.runtime.sendMessage,
    //    without chrome.identity or a Google-specific client.
    // 2. /dashboard's "Enrich" button (chrome.runtime.onMessageExternal in background.ts)
    //    triggers a single-lead deepen without opening the side panel.
    // Prod would need its own real origin added here when this ever ships past localhost.
    externally_connectable: {
      matches: ['http://localhost:3000/*'],
    },
  },
});
