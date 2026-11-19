// Saldo service worker: shows Web Push notifications and opens their link on click. No caching.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Same rule as lib/links.ts: browsers read "/\host" like "//host".
const internalPath = (link) =>
  typeof link === "string" && link.startsWith("/") && !link.startsWith("//") && !link.includes("\\") ? link : "/";

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Saldo", body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Saldo";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      lang: "de",
      data: { link: internalPath(data.link) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(internalPath(event.notification.data?.link), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ("navigate" in open) return open.navigate(url);
        return undefined;
      }
      return self.clients.openWindow(url);
    })(),
  );
});
