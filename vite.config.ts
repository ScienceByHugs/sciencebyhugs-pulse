import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const base = '/sciencebyhugs-pulse/'

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        importScripts: ['push-sw.js']
      },
      includeAssets: ['brand/science-by-hugs.svg', 'brand/sbh-monogram.svg', 'brand/pulse.svg', 'brand/pulse-app-icon.svg'],
      manifest: {
        name: 'PULSE — Science By Hugs',
        short_name: 'Pulse',
        description: 'PULSE — Track. Measure. Evolve. Research tracking system by Science By Hugs.',
        theme_color: '#0A0A0B',
        background_color: '#0A0A0B',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          {
            src: base + 'brand/pulse-app-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ]
})
