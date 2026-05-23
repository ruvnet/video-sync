import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";

/**
 * Derive a safe redirect origin for the OAuth callback.
 *
 * We never blindly trust x-forwarded-host from untrusted clients — doing so
 * would allow an attacker to craft a redirect_uri that points to an arbitrary
 * host and steal the OAuth code (open-redirect / code-theft).
 *
 * Priority:
 *  1. NEXTAUTH_URL env var set by the operator at deploy time (most reliable).
 *  2. x-forwarded-host, but ONLY if it matches the host that Next.js itself
 *     knows about (req.nextUrl.host) — i.e. the header was set by a trusted
 *     reverse-proxy sitting in front of the app, not by a random client.
 *  3. req.nextUrl.origin as the final fallback.
 */
function deriveCallbackOrigin(req: NextRequest): string {
  // 1. Operator-configured canonical URL
  if (process.env.NEXTAUTH_URL) {
    try {
      return new URL(process.env.NEXTAUTH_URL).origin;
    } catch { /* fall through */ }
  }

  // 2. x-forwarded-host only when it matches what Next.js already resolved
  const forwardedHost = req.headers.get("x-forwarded-host");
  if (forwardedHost && forwardedHost === req.nextUrl.host) {
    const proto = req.headers.get("x-forwarded-proto") || "https";
    return `${proto}://${forwardedHost}`;
  }

  // 3. Safe fallback — use Next.js's own origin
  return req.nextUrl.origin;
}

async function handler(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const clientId = searchParams.get("clientId");

  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const origin = deriveCallbackOrigin(req);
  const redirectUri = `${origin}/youtube-callback`;
  const scope = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "select_account consent");

  return NextResponse.redirect(authUrl.toString());
}

export const GET = withRequestLogging("api:youtube/auth", handler);
