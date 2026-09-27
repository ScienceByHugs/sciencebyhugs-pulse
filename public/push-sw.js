self.addEventListener('push', function (event) {
  var payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch (_) {
    payload = { body: event.data ? event.data.text() : '' }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'PULSE', {
      body: payload.body || 'You have a PULSE reminder.',
      tag: payload.tag || 'pulse',
      icon: './brand/sbh-monogram.svg',
      badge: './brand/sbh-monogram.svg',
      data: { url: payload.url || './' }
    })
  )
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var target = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : './'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      if (clients.length) {
        var client = clients[0]
        if (client.navigate) client.navigate(target)
        return client.focus()
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined
    })
  )
})
