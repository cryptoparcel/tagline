// Shared HTML escape helper. Use anywhere user-controlled data is
// interpolated into an HTML string (email templates, server-rendered HTML).
//
// Frontend has its own copy in public/tagline-app.js because that file
// can't import from /lib (server-only).
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
