import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ============================================================================
// Settings Types
// ============================================================================

interface SettingsState {
  // Persisted settings
  /** Developer mode shows detailed message info and unhides revoked messages */
  developerMode: boolean
  setDeveloperMode: (enabled: boolean) => void

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
    set => ({
      // Persisted settings
      developerMode: false,
      setDeveloperMode: enabled => set({ developerMode: enabled }),

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
      partialize: state => ({ developerMode: state.developerMode }),
    }
  )
)
