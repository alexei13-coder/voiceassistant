// Каркас HUD: верхняя панель, три колонки, нижняя панель и плавающие слои.

import { ActionLog } from './components/ActionLog'
import { BottomBar } from './components/BottomBar'
import { CenterStage } from './components/CenterStage'
import { ChatPanel } from './components/ChatPanel'
import { ConnectionBanner } from './components/ConnectionBanner'
import { Notices } from './components/Notices'
import { SystemPanel } from './components/SystemPanel'
import { TopBar } from './components/TopBar'
import { useJarvis } from './store'

export function App() {
  const reducedMotion = useJarvis((s) => s.reducedMotion)
  return (
    <div className="hud" data-reduced-motion={reducedMotion || undefined}>
      <TopBar />
      <main className="hud__main">
        <ChatPanel />
        <CenterStage />
        <div className="hud__side">
          <ActionLog />
          <SystemPanel />
        </div>
      </main>
      <BottomBar />
      <ConnectionBanner />
      <Notices />
    </div>
  )
}
