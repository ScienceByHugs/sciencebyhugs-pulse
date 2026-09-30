import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Pages supplies an empty base path for a custom domain and a repository path otherwise.
const pagesPath = process.env.PULSE_BASE_PATH
const base = pagesPath === undefined ? '/' : `${pagesPath.replace(/\/$/, '')}/`

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
