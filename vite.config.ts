import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'],
    manifest: {name: 'POS México', short_name: 'POS México', lang: 'es-MX', description: 'Tu negocio, en orden.', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff', icons: [{src:'/icons/icon-192.png',sizes:'192x192',type:'image/png'}, {src:'/icons/icon-512.png',sizes:'512x512',type:'image/png'}, {src:'/icons/icon-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]},
    workbox: {navigateFallback: '/index.html', globPatterns:['**/*.{js,css,html,woff2,png,svg}'], cleanupOutdatedCaches:true},
    devOptions: {enabled:false},
  })],
  server: {host:'127.0.0.1',port:5173,strictPort:true},
  preview: {host:'127.0.0.1',port:4173,strictPort:true},
})
