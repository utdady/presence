import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Presence',
        short_name: 'Presence',
        description: 'Live presence messaging',
        theme_color: '#0E1114',
        background_color: '#0E1114',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://127.0.0.1:8000',
      '/invites': 'http://127.0.0.1:8000',
      '/nearby': { target: 'http://127.0.0.1:8000', ws: true },
      '/me': 'http://127.0.0.1:8000',
      '/peers': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/auth': 'http://127.0.0.1:8000',
      '/invites': 'http://127.0.0.1:8000',
      '/nearby': { target: 'http://127.0.0.1:8000', ws: true },
      '/me': 'http://127.0.0.1:8000',
      '/peers': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
})
