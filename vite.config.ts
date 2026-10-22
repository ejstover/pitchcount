import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), tailwindcss(), VitePWA({
    registerType: 'prompt',
    injectRegister: false,
    includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
    manifest: {
      id: '/', name: 'Pitchwork · Practice Pitch Tracker', short_name: 'Pitchwork',
      description: 'Every pitch counts. Baseball and softball practice, saved on your device.',
      start_url: '/', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#168ed0',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,ttf}'],
      cleanupOutdatedCaches: true,
      navigateFallback: 'index.html',
    },
  })],
  test: { exclude: ['**/node_modules/**', '**/.test-artifacts/**'], environment: 'node', setupFiles: ['src/test-setup.ts'] },
})
