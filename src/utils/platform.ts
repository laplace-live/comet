// ============================================================================
// Platform Detection Utilities (via Electron API)
// ============================================================================

/**
 * The current platform from Electron's process.platform
 * - 'darwin' for macOS
 * - 'win32' for Windows
 * - 'linux' for Linux
 */
export const platform = window.electronAPI?.platform

/** Check if the current platform is macOS */
export const isMacOS = platform === 'darwin'

/** Check if the current platform is Windows */
export const isWindows = platform === 'win32'

/** Check if the current platform is Linux */
export const isLinux = platform === 'linux'

/** Get the modifier key symbol for the current platform (⌘ on macOS, Ctrl on others) */
export const modifierKey = isMacOS ? '⌘' : 'Ctrl'

/** Get the modifier key name for the current platform */
export const modifierKeyName = isMacOS ? 'Cmd' : 'Ctrl'
