/**
 * Path prefix the web app is served under, read from the document's `<base href>`
 * (the server rewrites it when running with OPENCODE_BASE_PATH). Empty at the root.
 */
export function basePath() {
  if (typeof document === "undefined") return ""
  return new URL(document.baseURI).pathname.replace(/\/+$/, "")
}
