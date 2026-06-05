/**
 * Strips credentials and query parameters from a URL so it is safe to log.
 * Removes both the userinfo component (`user:password@`, e.g. the password in
 * a `postgresql://` connection string) and the query string (signed tokens or
 * API keys). Returns scheme + host + path only.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    // Best-effort fallback for unparseable input: drop userinfo and query.
    return url.split("?")[0].replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

/**
 * Returns the public-facing origin (scheme + host) derived from forwarded
 * headers. Falls back to the request's own origin when no proxy headers exist.
 */
export function resolveExternalOrigin(request: Request): string {
  const forwardedHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const incomingUrl = new URL(request.url);
  const requestProto = incomingUrl.protocol.replace(/:$/, "");
  const forwardedProto =
    request.headers.get("x-forwarded-proto") ?? requestProto;
  return forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : `${incomingUrl.protocol}//${incomingUrl.host}`;
}

/**
 * Rewrites a localhost/127.0.0.1 URL to the externally-visible origin
 * derived from forwarded headers. Used by billing routes so that
 * redirect/checkout URLs resolve correctly behind tunnels or proxies.
 *
 * If the URL is already external or headers are missing, returns the
 * original URL unchanged. Relative URLs are resolved against `requestUrl`.
 */
export function resolveExternalUrl(url: string, request: Request): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      return url;
    }
    const forwardedHost =
      request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (!forwardedHost) return url;

    const requestProto = new URL(request.url).protocol.replace(/:$/, "");
    const proto =
      request.headers.get("x-forwarded-proto") ?? requestProto;
    return `${proto}://${forwardedHost}${parsed.pathname}${parsed.search}`;
  } catch {
    // url may be relative — resolve against the request origin
    return new URL(url, request.url).href;
  }
}
