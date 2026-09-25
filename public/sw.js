/**
 * The service worker exists for one reason: on a phone, a notification can
 * only be shown through a service worker registration. It handles no network
 * requests at all. There is deliberately no 'fetch' listener and no cache, so
 * the page's Content Security Policy remains the only thing deciding where a
 * request may go, and scripts/check-fetch.mjs holds this file to the same rule
 * as the rest of the code.
 */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Tapping a notification brings the dashboard forward, or opens it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => 'focus' in c)
      if (open) return open.focus()
      return self.clients.openWindow('./')
    }),
  )
})
