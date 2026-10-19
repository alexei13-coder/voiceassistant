import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Порт 1420 зафиксирован: он в списке разрешённых Origin ядра в режиме --dev (docs/protocol.md §1.1).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebView2 на Windows 11 — современный Chromium
    target: 'chrome120',
    sourcemap: false,
  },
})
