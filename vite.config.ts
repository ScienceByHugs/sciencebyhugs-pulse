import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const base = '/sciencebyhugs-pulse/'

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['brand/science-by-hugs.svg', 'brand/sbh-monogram.svg', 'brand/pulse.svg'],
      manifest: {
        name: 'Science By HUGs Pulse',
        short_name: 'Pulse',
        description: 'Biometric-inspired tracking PWA for schedules, routines, and personal logs.',
        theme_color: '#0A0A0B',
        background_color: '#0A0A0B',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          {
            src: base + 'brand/sbh-monogram.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ]
})
