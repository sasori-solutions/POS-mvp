// Keep the marketing domain's root on the network; the app worker serves its own HTML.
if (location.hostname !== 'pos.larioscow.dev' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
  })
}
