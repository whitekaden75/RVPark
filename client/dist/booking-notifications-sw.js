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
  const requestedUrl = event.notification.data?.url || "/?admin=reservation";
  let destinationUrl;

  try {
    destinationUrl = new URL(requestedUrl, self.location.origin);
  } catch {
    destinationUrl = new URL("/?admin=reservation", self.location.origin);
  }

  // Notifications can outlive a deployment, and an old server may have
  // generated an absolute localhost URL. Keep the click inside the app that
  // received the notification instead of sending a deployed admin to localhost.
  if (
    destinationUrl.hostname === "localhost" ||
    destinationUrl.hostname === "127.0.0.1" ||
    destinationUrl.hostname === "::1"
  ) {
    destinationUrl = new URL(
      `${destinationUrl.pathname}${destinationUrl.search}${destinationUrl.hash}`,
      self.location.origin
    );
  }

  const destination = destinationUrl.href;

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
