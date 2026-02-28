/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkOnly, NetworkFirst } from 'workbox-strategies';

declare let self: ServiceWorkerGlobalScope;

// Workbox precaching (injected by vite-plugin-pwa)
precacheAndRoute(self.__WB_MANIFEST);

// Runtime caching
registerRoute(/^https:\/\/0\.peerjs\.com\/.*/, new NetworkOnly());
registerRoute(/^https:\/\/api\.ipify\.org\/.*/, new NetworkFirst({ cacheName: 'ip-detection', networkTimeoutSeconds: 3 }));

// Take control of pages immediately on update
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// Notification click — open/focus the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatTarget = (event.notification as any).data?.chat;
  const url = chatTarget ? `/?chat=${chatTarget}` : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus existing window if available
      for (const client of windowClients) {
        if (new URL(client.url).origin === location.origin) {
          client.focus();
          if (chatTarget) client.postMessage({ type: 'open-chat', chat: chatTarget });
          return;
        }
      }
      // No existing window — open new one
      return self.clients.openWindow(url);
    })
  );
});
