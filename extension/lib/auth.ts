import { BACKEND_URL } from './backend';

const TOKEN_KEY = 'backend_token';

export interface CurrentUser {
  id: string;
  email: string;
  display_name: string;
}

export async function getToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  return stored[TOKEN_KEY] ?? null;
}

async function setToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}

// Opens the backend's Google OIDC flow in a normal tab; the callback page relays the
// token back here via externally_connectable messaging (CLAUDE.md: "Login always goes
// through the backend (OIDC); the extension only ever holds the backend token").
export async function login(): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let tabId: number | undefined;

    // The backend's /auth/callback page sends this via externally_connectable
    // (manifest allows http://localhost:3000/*), not a same-extension message.
    const listener = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
      if (!sender.url?.startsWith(BACKEND_URL)) return;
      if (message?.type !== 'AUTH_TOKEN' && message?.type !== 'AUTH_ERROR') return;
      settled = true;
      chrome.runtime.onMessageExternal.removeListener(listener);
      sendResponse({ received: true });
      if (message.type === 'AUTH_TOKEN') {
        setToken(message.token).then(() => resolve({ ok: true }));
      } else {
        resolve({ ok: false, error: message.error ?? 'Sign-in failed.' });
      }
    };
    chrome.runtime.onMessageExternal.addListener(listener);

    chrome.tabs.create({ url: `${BACKEND_URL}/auth/login?ext_id=${chrome.runtime.id}` }, (tab) => {
      tabId = tab?.id;
      if (tabId === undefined) return;
      // Catch the user closing the tab without completing sign-in.
      const onRemoved = (closedTabId: number) => {
        if (closedTabId !== tabId || settled) return;
        chrome.tabs.onRemoved.removeListener(onRemoved);
        chrome.runtime.onMessageExternal.removeListener(listener);
        resolve({ ok: false, error: 'Sign-in tab was closed before finishing.' });
      };
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  });
}

export async function logout(): Promise<void> {
  const token = await getToken();
  if (token) {
    await fetch(`${BACKEND_URL}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  await clearToken();
}

export async function fetchMe(): Promise<CurrentUser | null> {
  const token = await getToken();
  if (!token) return null;
  const res = await fetch(`${BACKEND_URL}/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    await clearToken();
    return null;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  }
  return res.json();
}
