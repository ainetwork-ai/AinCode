/**
 * Path prefix the web app is served under, read from the document's `<base href>`
 * (the server rewrites it when running with OPENCODE_BASE_PATH). Empty at the root.
 */
export function basePath() {
  if (typeof document === "undefined") return ""
  return new URL(document.baseURI).pathname.replace(/\/+$/, "")
}

/**
 * The app route for a router `location.pathname`. With a `<Router base>`, solid-router reports the full browser
 * path (`/code/new-session`), while route literals and `navigate("/…")` are base-relative (`/new-session`,
 * and navigate prepends the base again). Compare or re-navigate with this, never with the raw pathname.
 */
export function routePath(pathname: string, base = basePath()) {
  if (!base) return pathname
  if (pathname === base) return "/"
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length)
  return pathname
}
