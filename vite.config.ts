import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: 'src/ui',
  server: {
    port: 4601,
    host: true, // reachable from a tablet or phone on the same network
    proxy: { '/api': 'http://localhost:4600', '/ws': { target: 'ws://localhost:4600', ws: true } },
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // Separate bundles so work on one cannot break another: the football draft
    // companion, the cockpit (with basketball's league pages inside it), and the basketball draft room.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/ui/index.html'),
        cockpit: resolve(__dirname, 'src/ui/cockpit.html'),
        nbaDraft: resolve(__dirname, 'src/ui/nba-draft.html'),
      },
    },
  },
})
