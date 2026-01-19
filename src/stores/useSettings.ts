import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ============================================================================
// Settings Types
// ============================================================================

interface SettingsState {
  /** Developer mode shows detailed message info and unhides revoked messages */
  developerMode: boolean
  setDeveloperMode: (enabled: boolean) => void
}

// ============================================================================
// Settings Store
// ============================================================================

export const useSettings = create<SettingsState>()(
  persist(
    set => ({
      developerMode: false,
      setDeveloperMode: enabled => set({ developerMode: enabled }),
    }),
    {
      name: 'laplace-comet-settings',
    }
  )
)
