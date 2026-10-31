importScripts("https://www.gstatic.com/firebasejs/12.18.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging-compat.js");

const config = Object.fromEntries(new URL(self.location).searchParams);
firebase.initializeApp(config);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notification = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(notification.title || data.title || "Jaggy Analyser", {
    body: notification.body || data.body || "New trade update",
    icon: self.registration.scope + "logo-jaggy.png",
    badge: self.registration.scope + "logo-jaggy.png",
    tag: data.event_id || "jaggy-trade-alert",
    data: { url: data.url && data.url !== "/" ? data.url : self.registration.scope },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || self.registration.scope, self.location.origin).href;
  event.waitUntil(clients.openWindow(url));
});