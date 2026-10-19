// ВРЕМЕННАЯ ЗАГЛУШКА. Модуль orb/ заменит её WebGL2-реализацией.
// Контракт: export function Orb(props: { className?: string }) — занимает всё место контейнера,
// состояние берёт из useJarvis (state, confirmation, reducedMotion, lastStop), уровни звука — из live.ts.

export function Orb({ className }: { className?: string }) {
  return <canvas className={className} aria-hidden="true" />
}
