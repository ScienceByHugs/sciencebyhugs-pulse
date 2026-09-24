import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['brand-mark.svg'],
      manifest: {
        name: 'Science By HUGs Pulse',
        short_name: 'Pulse',
        description: 'Biometric-inspired tracking PWA for schedules, routines, and personal logs.',
        theme_color: '#05070A',
        background_color: '#05070A',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/brand-mark.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ]
})