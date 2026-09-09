/**
 * The Content Security Policy is the primary control that keeps the GitHub
 * token in localStorage from ever reaching a third party. It is defined here so
 * that the build, the dev server and the verification script all read the same
 * source of truth.
 *
 * GitHub Pages cannot set response headers, so the policy ships as a
 * <meta http-equiv> tag injected at the very top of <head>. Directives that are
 * ignored in meta form (frame-ancestors, sandbox, report-uri) are deliberately
 * absent rather than present-and-useless.
 */

/** The only network destination the application is permitted to talk to. */
export const API_ORIGIN = 'https://api.github.com'

/**
 * Production policy. Contains no 'unsafe-inline', no 'unsafe-eval' and no host
 * other than the GitHub API. Every asset is same-origin.
 */
export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `connect-src ${API_ORIGIN}`,
  "img-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ')

/**
 * Development policy. Vite injects stylesheets as inline <style> elements and
 * drives hot reload over a websocket, so dev needs two relaxations that the
 * production policy never contains. script-src stays 'self' and connect-src
 * still admits no external host beyond the GitHub API.
 */
export const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `connect-src ${API_ORIGIN} 'self' ws://localhost:* ws://127.0.0.1:*`,
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')
