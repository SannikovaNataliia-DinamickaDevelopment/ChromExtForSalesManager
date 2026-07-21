type CallbackResult =
  | { ok: true; token: string; extId: string | null; email: string }
  | { ok: false; error: string; extId: string | null };

// The HTML parser scans for the literal "</script" regardless of JSON content, so
// JSON.stringify alone isn't enough — escape "<" to stop early script-tag closure (XSS).
function escapeForInlineScript(json: string): string {
  return json.replace(/</g, '\\u003c');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Rendered by GET /auth/callback. When opened via the extension (extId present) it
// relays the token/error back over externally_connectable messaging and self-closes;
// opened directly in a browser (manual testing) it just reports the outcome.
export function renderCallbackPage(result: CallbackResult): string {
  const data = escapeForInlineScript(JSON.stringify(result));
  const heading = result.ok ? 'Signed in' : 'Sign-in failed';
  const bodyText = result.ok ? `Signed in as ${escapeHtml(result.email)}.` : `Error: ${escapeHtml(result.error)}`;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${heading}</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem;">
  <h2>${heading}</h2>
  <p id="status">${bodyText}</p>
  <script>
    (function () {
      var result = ${data};
      var statusEl = document.getElementById('status');
      if (!result.extId) {
        if (result.ok) {
          statusEl.textContent += ' You can close this tab.';
        }
        return;
      }
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        statusEl.textContent = 'Could not reach the extension (chrome.runtime unavailable). Close this tab and try again.';
        return;
      }
      var message = result.ok
        ? { type: 'AUTH_TOKEN', token: result.token }
        : { type: 'AUTH_ERROR', error: result.error };
      chrome.runtime.sendMessage(result.extId, message, function () {
        statusEl.textContent = result.ok ? 'Signed in! Closing…' : 'Sign-in failed: ' + result.error;
        setTimeout(function () { window.close(); }, result.ok ? 800 : 4000);
      });
    })();
  </script>
</body>
</html>`;
}
