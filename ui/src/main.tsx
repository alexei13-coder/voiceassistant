// Точка входа UI. Шрифты локальные (@fontsource, с кириллицей) — HUD работает без сети.

import '@fontsource/manrope/300.css'
import '@fontsource/manrope/400.css'
import '@fontsource/manrope/500.css'
import '@fontsource/manrope/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles/tokens.css'
import './styles/global.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startConnection } from './core/connection'
import { syncReducedMotionPreference } from './motion'

async function startCore(): Promise<void> {
  const search = window.location.search
  // Ветка целиком вырезается из продакшен-сборки: import.meta.env.DEV там — константа false.
  if (import.meta.env.DEV && new URLSearchParams(search).get('mock') === '1') {
    const { startMockCore } = await import('./core/mockCore')
    startMockCore(search)
    return
  }
  startConnection()
}

const root = document.getElementById('root')
if (!root) throw new Error('Нет элемента #root в index.html')

syncReducedMotionPreference()
void startCore()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
