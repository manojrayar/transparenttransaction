const CACHE_NAME = 'tta-cache-v1';
const FILES = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

// Handle push: show notification with approve/reject actions
self.addEventListener('push', (evt) => {
  let data = {};
  try { data = evt.data.json(); } catch(e) { data.body = evt.data.text(); }
  const title = data.title || 'TTA Request';
  const options = {
    body: data.body || 'You have a request',
    data: data,
    actions: [
      {action:'approve', title:'Approve'},
      {action:'reject', title:'Reject'}
    ],
    tag: data.tag || 'tta-request',
    renotify: true
  };
  evt.waitUntil(self.registration.showNotification(title, options));
});

// Notification action clicks
self.addEventListener('notificationclick', (evt) => {
  const action = evt.action;
  const payload = evt.notification.data || {};
  evt.notification.close();

  if(action === 'approve' || action === 'reject'){
    // POST decision to server (payload must include serverEndpoint & requestId)
    if(payload && payload.serverEndpoint && payload.requestId && payload.approverPhone){
      fetch(payload.serverEndpoint + '/record-approval', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({requestId: payload.requestId, approver: payload.approverPhone, decision: action==='approve' ? 'yes' : 'no'})
      }).catch(err => console.warn('approval post failed', err));
    } else {
      // If missing approverPhone, open client so user can approve from UI
      evt.waitUntil(self.clients.openWindow('/'));
    }
    evt.waitUntil(self.clients.openWindow('/'));
  } else {
    evt.waitUntil(self.clients.openWindow('/'));
  }
});
