import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type {
  NotificationSoundCategory,
  NotificationSoundId,
  NotificationSoundSettings,
} from '@/lib/notification-sounds'

import { DEFAULT_NOTIFICATION_SOUNDS, normalizeNotificationSoundSettings } from '@/lib/notification-sounds'

// ============================================================================
// Settings Types
// ============================================================================

interface SettingsState {
  // Persisted settings
  /** Developer mode shows detailed message info and unhides revoked messages */
  developerMode: boolean
  setDeveloperMode: (enabled: boolean) => void
  /** Accounts that muted 客服消息, which Bilibili offers no Do Not Disturb for */
  customerServiceMutedMids: number[]
  setCustomerServiceMuted: (mid: number, muted: boolean) => void
  /**
   * 在本机保留聊天记录: keep each account's session lists and opened chats on disk, sealed with safeStorage, so a
   * relaunch shows them at once. Turning it off deletes them.
   */
  keepChatsOnDevice: boolean
  setKeepChatsOnDevice: (enabled: boolean) => void
  /** Per-category notification sound IDs ('default', 'none', 'custom:*', or 'system:*') */
  notificationSounds: NotificationSoundSettings
  setNotificationSound: (category: NotificationSoundCategory, soundId: NotificationSoundId) => void

  // UI state (not persisted)
  /** Whether the settings modal is open */
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  toggleSettings: () => void

  /** Whether the about modal is open */
  aboutOpen: boolean
  openAbout: () => void
  closeAbout: () => void
}

// ============================================================================
// Settings Store
// ============================================================================

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Persisted settings
      developerMode: false,
      setDeveloperMode: enabled => set({ developerMode: enabled }),
      customerServiceMutedMids: [],
      setCustomerServiceMuted: (mid, muted) =>
        set(state => ({
          customerServiceMutedMids: [...state.customerServiceMutedMids.filter(m => m !== mid), ...(muted ? [mid] : [])],
        })),
      keepChatsOnDevice: true,
      setKeepChatsOnDevice: enabled => set({ keepChatsOnDevice: enabled }),
      notificationSounds: { ...DEFAULT_NOTIFICATION_SOUNDS },
      setNotificationSound: (category, soundId) => {
        if (get().notificationSounds[category] === soundId) return
        set(state => ({
          notificationSounds: {
            ...state.notificationSounds,
            [category]: soundId,
          },
        }))
        if (category === 'system') {
          void window.electronAPI?.notificationSounds?.setSystemSoundPref({ soundId })
        }
      },

      // UI state
      settingsOpen: false,
      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),
      toggleSettings: () => set(state => ({ settingsOpen: !state.settingsOpen })),

      aboutOpen: false,
      openAbout: () => set({ aboutOpen: true }),
      closeAbout: () => set({ aboutOpen: false }),
    }),
    {
      name: 'laplace-comet-settings',
      // Only persist settings, not UI state
      partialize: state => ({
        developerMode: state.developerMode,
        customerServiceMutedMids: state.customerServiceMutedMids,
        keepChatsOnDevice: state.keepChatsOnDevice,
        notificationSounds: state.notificationSounds,
      }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<SettingsState>
        return {
          ...currentState,
          ...persisted,
          notificationSounds: normalizeNotificationSoundSettings(persisted.notificationSounds),
        }
      },
    }
  )
)
