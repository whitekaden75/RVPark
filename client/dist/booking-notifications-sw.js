self.addEventListener("push", (event) => {
  let notification = {};

  try {
    notification = event.data?.json() || {};
  } catch {
    notification = { body: event.data?.text() || "A new online booking was received." };
  }

  event.waitUntil(
    self.registration.showNotification(notification.title || "New online booking", {
      body: notification.body || "A new online booking was received.",
      icon: "/notification-icon.svg",
      badge: "/notification-badge.svg",
      tag: notification.tag || "online-booking",
      data: {
        url: notification.url || "/?admin=reservation"
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "/?admin=reservation", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existingClient = clients.find((client) => client.url.startsWith(self.location.origin));

      if (existingClient) {
        return existingClient.navigate(destination).then(() => existingClient.focus());
      }

      return self.clients.openWindow(destination);
    })
  );
});
