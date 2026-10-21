// Каркас HUD: верхняя панель, (при проблемах со связью) тонкая строка, три колонки,
// нижняя панель и плавающие уведомления.

import { ActionLog } from './components/ActionLog'
import { BottomBar } from './components/BottomBar'
import { CenterStage } from './components/CenterStage'
import { ChatPanel } from './components/ChatPanel'
import { ConnectionBanner } from './components/ConnectionBanner'
import { MemoryPanel } from './components/MemoryPanel'
import { Notices } from './components/Notices'
import { SystemPanel } from './components/SystemPanel'
import { TopBar } from './components/TopBar'
import { useSwyvorn } from './store'

export function App() {
  const reducedMotion = useSwyvorn((s) => s.reducedMotion)
  return (
    <div className="hud" data-reduced-motion={reducedMotion || undefined}>
      <TopBar />
      <ConnectionBanner />
      <main className="hud__main">
        <ChatPanel />
        <CenterStage />
        <div className="hud__side">
          <ActionLog />
          <MemoryPanel />
          <SystemPanel />
        </div>
      </main>
      <BottomBar />
      <Notices />
    </div>
  )
}
