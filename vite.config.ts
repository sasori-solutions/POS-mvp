import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [tailwindcss(), react(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'],
    manifest: {name: 'POS México', short_name: 'POS México', lang: 'es-MX', description: 'Tu negocio, en orden.', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff', icons: [{src:'/icons/icon-192.png',sizes:'192x192',type:'image/png'}, {src:'/icons/icon-512.png',sizes:'512x512',type:'image/png'}, {src:'/icons/icon-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]},
    workbox: {navigateFallback: '/index.html', globPatterns:['**/*.{js,css,html,woff2,png,svg}'], globIgnores: ['_worker.js', 'landing/**', 'assets/landing-*'], cleanupOutdatedCaches:true},
    devOptions: {enabled:false},
  }), {
    name: 'standalone-landing',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (context.path === '/index.html') {
          return html.replace('src="/registerSW.js"', 'src="/register-app-worker.js"')
        }
        if (context.path !== '/landing/index.html') return html
        // The marketing page must never register the operational app's worker.
        return html
          .replace(/<script\b[^>]*\bid="vite-plugin-pwa:register-sw"[^>]*>[\s\S]*?<\/script>/g, '')
          .replace(/<link\b[^>]*\brel="manifest"[^>]*>/g, '')
      },
    },
  }],
  build: { rollupOptions: { input: { app: 'index.html', landing: 'landing/index.html' } } },
  server: {host:'127.0.0.1',port:5173,strictPort:true},
  preview: {host:'127.0.0.1',port:4173,strictPort:true},
})
