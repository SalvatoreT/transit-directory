const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SESSION_COOKIE = "__cf_turnstile_session";
const SESSION_TTL_SECONDS = 86400; // 24 hours

export function getSessionId(request: Request): string | null {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`),
  );
  return match ? match[1] : null;
}

export function generateSessionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 40; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

export function sessionCookieHeader(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export async function verifyToken(
  token: string,
  secretKey: string,
  ip: string,
): Promise<boolean> {
  const body = new URLSearchParams({
    secret: secretKey,
    response: token,
    remoteip: ip,
  });

  const res = await fetch(VERIFY_URL, {
    method: "POST",
    body,
  });

  const json = (await res.json()) as { success: boolean };
  return json.success === true;
}

export function renderChallengePage(
  siteKey: string,
  redirectUrl: string,
): string {
  // Escape values for safe embedding in HTML
  const escapedRedirect = redirectUrl
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verifying you are human</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
      color: #333;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 { font-size: 1.25rem; font-weight: 500; margin-bottom: 1.5rem; }
    form { display: inline-block; }
    .cf-turnstile { margin: 0 auto; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Verifying you are human</h1>
    <form method="POST" action="/__turnstile-verify">
      <input type="hidden" name="redirect" value="${escapedRedirect}">
      <div class="cf-turnstile" data-sitekey="${siteKey}" data-callback="onSuccess"></div>
    </form>
    <script>
      function onSuccess(token) {
        document.querySelector('form').submit();
      }
    </script>
  </div>
</body>
</html>`;
}
