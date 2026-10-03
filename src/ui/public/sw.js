/*
 * The service worker exists for one reason: iOS will not deliver a web push to
 * a page, only to an installed app. Adding the cockpit to the Home Screen makes
 * this the thing that wakes up.
 */
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = {} }
  event.waitUntil(
    self.registration.showNotification(d.title || 'Fantasy Companion', {
      body: d.body || '',
      // The alert id, so a fact restated replaces its own notification rather
      // than stacking a second copy of itself.
      tag: d.tag || 'ff',
      data: { url: d.url || '/home' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      /*
       * Sent with the message, because the worker cannot see what an alert is
       * worth. A starter who will not play stays on screen until it is dealt
       * with; everything else fades on its own, which is most of them.
       */
      requireInteraction: d.requireInteraction === true,
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/home'
  // Focus the app if it is already open rather than opening a second copy.
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) return w.focus()
      }
      return clients.openWindow(url)
    }),
  )
})
