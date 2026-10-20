// Набор тонких иконок HUD (16×16, обводка currentColor) и фирменный знак.

import type { ReactNode } from 'react'

const PATHS = {
  mic: (
    <>
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V14.5M5.5 14.5h5" />
    </>
  ),
  micOff: (
    <>
      <path d="M10.5 6.5V4a2.5 2.5 0 0 0-5 0v3.5a2.5 2.5 0 0 0 4 2" />
      <path d="M3 7.5a5 5 0 0 0 8.4 3.6M13 7.5c0 .5-.1 1-.2 1.4M8 12.5V14.5M5.5 14.5h5M2 2l12 12" />
    </>
  ),
  send: <path d="M13.5 2.5V8a2 2 0 0 1-2 2H3M6 7l-3 3 3 3" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none" />,
  minimize: <path d="M3.5 8.5h9" />,
  maximize: <rect x="3.5" y="3.5" width="9" height="9" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.2v4.3M8 4.8v.1" />
    </>
  ),
  warning: (
    <>
      <path d="M8 1.8 14.8 13.8H1.2z" />
      <path d="M8 6.3v3.6M8 11.7v.1" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" />
    </>
  ),
  check: <path d="M3 8.5l3.2 3L13 4.5" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5V8l2.5 1.6" />
    </>
  ),
  hourglass: <path d="M4.5 2h7M4.5 14h7M5.5 2v2.5L8 8l2.5-3.5V2M5.5 14v-2.5L8 8l2.5 3.5V14" />,
  spinner: <path d="M8 1.5a6.5 6.5 0 1 1-6.5 6.5" />,
  pending: <circle cx="8" cy="8" r="5.5" strokeDasharray="2 2.3" />,
  ban: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M3.4 12.6l9.2-9.2" />
    </>
  ),
  minusCircle: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8h6" />
    </>
  ),
  square: <rect x="4.5" y="4.5" width="7" height="7" />,
  shield: (
    <>
      <path d="M8 1.5 13.5 3.5v4c0 3.4-2.4 5.9-5.5 7-3.1-1.1-5.5-3.6-5.5-7v-4z" />
      <path d="M5.6 5.6l4.8 4.8" />
    </>
  ),
  chevronDown: <path d="M4 6l4 4 4-4" />,
  chevronRight: <path d="M6 4l4 4-4 4" />,
  chat: <path d="M2.5 3h11v7.5h-6l-3 2.5v-2.5h-2z" />,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.1M2.5 8h.1M2.5 12h.1" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/** Фирменный знак: шестигранник, разомкнутое кольцо и ядро. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <polygon points="16,1.8 28.3,8.9 28.3,23.1 16,30.2 3.7,23.1 3.7,8.9" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <circle
        cx="16"
        cy="16"
        r="8.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray="40.5 13.5"
        transform="rotate(-62 16 16)"
      />
      <path d="M16 4.6v3M16 24.4v3M6.1 10.3l2.6 1.5M23.3 20.2l2.6 1.5" stroke="currentColor" strokeWidth="1" opacity="0.7" />
      <circle cx="16" cy="16" r="3" fill="currentColor" />
    </svg>
  )
}
