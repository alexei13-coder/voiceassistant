// Набор тонких иконок HUD (16×16, обводка currentColor).

import type { ReactNode } from 'react'

const PATHS = {
  mic: (
    <>
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
      <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" />
    </>
  ),
  micOff: (
    <>
      <path d="M10.25 6.6V4a2.25 2.25 0 0 0-4.4-.66M5.75 6.5v1a2.25 2.25 0 0 0 3.6 1.8" />
      <path d="M3.25 7.5a4.75 4.75 0 0 0 8 3.47M12.75 7.5c0 .45-.06.88-.17 1.3M8 12.25v2M2.5 2.5l11 11" />
    </>
  ),
  send: <path d="M8 13V3.5M4 7.25 8 3.25l4 4" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
  minimize: <path d="M4 8h8" />,
  maximize: <rect x="4" y="4" width="8" height="8" rx="1" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  check: <path d="M3.5 8.5l3 2.75 6-6.5" />,
  spinner: <path d="M8 1.75a6.25 6.25 0 1 1-6.25 6.25" />,
  chevronDown: <path d="M4.5 6.25 8 9.75l3.5-3.5" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
