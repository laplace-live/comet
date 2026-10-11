// The website's and the docs' shots of Comet. Each docs page's shots take its slug on laplace.live:
// `login` for `/comet/login`, `settings-about` for the About section of `/comet/settings`.

import type { ConversationKey } from './showcase.ts'

/** Logical px. The size of the picture laplace.live/comet shows, so `hero` drops in for it. */
const NARROW = { width: 447, height: 679 }
/** Wide enough for the session list beside a conversation, and for dialogs to float rather than dock. */
const WIDE = { width: 960, height: 640 }

export interface Shot {
  /** File name, without `.png`. */
  name: string
  window: { width: number; height: number }
  dark?: boolean
  /** Taken before anyone signs in: the QR code login screen. */
  login?: boolean
  /** The conversation opened from the session list. */
  open?: ConversationKey
  /** What the shot opens over the inbox. */
  overlay?: 'accounts' | 'chat-menu' | 'settings' | 'about'
}

export const SHOTS: Shot[] = [
  { name: 'hero', window: NARROW, open: 'yuzu' },
  { name: 'hero-dark', window: NARROW, open: 'yuzu', dark: true },
  { name: 'login', window: NARROW, login: true },
  { name: 'login-accounts', window: WIDE, open: 'yuzu', overlay: 'accounts' },
  { name: 'messaging', window: WIDE, open: 'fans' },
  { name: 'messaging-menu', window: WIDE, open: 'yuzu', overlay: 'chat-menu' },
  { name: 'settings', window: WIDE, open: 'yuzu', overlay: 'settings' },
  { name: 'settings-about', window: WIDE, open: 'yuzu', overlay: 'about' },
]
