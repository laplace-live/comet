import { NOTIFICATION_SOUND_DEFAULT, NOTIFICATION_SOUND_NONE } from '@/lib/notification-sounds'

let audioContext: AudioContext | null = null
let activeSource: AudioBufferSourceNode | null = null
let currentPlaybackToken = 0
const decodedBuffers = new Map<string, Promise<AudioBuffer | null>>()

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') {
    return null
  }
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new window.AudioContext()
  }
  return audioContext
}

/** Stop any sound currently playing through Web Audio in the renderer. */
export function stopRendererSoundPlayback(): void {
  currentPlaybackToken++
  if (!activeSource) return
  const source = activeSource
  activeSource = null
  try {
    source.stop()
    source.disconnect()
  } catch {
    // Source already ended
  }
}

async function loadAudioBuffer(ctx: AudioContext, soundId: string): Promise<AudioBuffer | null> {
  const cached = decodedBuffers.get(soundId)
  if (cached) return cached

  const pending = (async () => {
    try {
      const bytes = await window.electronAPI?.notificationSounds?.readSoundData({ soundId })
      if (!bytes || bytes.byteLength === 0) {
        decodedBuffers.delete(soundId)
        return null
      }
      return await ctx.decodeAudioData(bytes.slice().buffer)
    } catch (err) {
      console.error('[SoundPlayer] Failed to decode sound:', soundId, err)
      decodedBuffers.delete(soundId)
      return null
    }
  })()

  decodedBuffers.set(soundId, pending)
  return pending
}

/**
 * Play a custom or OS system notification sound via Web Audio in the renderer
 * (used on Windows and Linux for both background notifications and Settings previews).
 */
export async function playNotificationSoundInRenderer(soundId: string): Promise<boolean> {
  if (!soundId || soundId === NOTIFICATION_SOUND_NONE || soundId === NOTIFICATION_SOUND_DEFAULT) {
    return false
  }

  stopRendererSoundPlayback()
  const token = currentPlaybackToken

  const ctx = getAudioContext()
  if (!ctx) return false

  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      // Ignore if resume fails
    }
  }

  const buffer = await loadAudioBuffer(ctx, soundId)
  if (token !== currentPlaybackToken) return true
  if (!buffer) return false

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.onended = () => {
    if (activeSource === source) {
      activeSource = null
    }
    source.disconnect()
  }
  activeSource = source
  source.start(0)
  return true
}

/** Stop any active preview playback in both the renderer and (on macOS) the main process. */
export function stopPreviewPlayback(): void {
  void previewNotificationSound(NOTIFICATION_SOUND_NONE)
}

/** Preview a notification sound from Settings across macOS, Windows, and Linux. */
export async function previewNotificationSound(soundId: string): Promise<void> {
  stopRendererSoundPlayback()
  const api = window.electronAPI
  if (!api?.notificationSounds) return

  const id = soundId || NOTIFICATION_SOUND_NONE
  if (api.platform === 'darwin' || id === NOTIFICATION_SOUND_DEFAULT) {
    await api.notificationSounds.preview({ soundId: id })
    return
  }
  if (id === NOTIFICATION_SOUND_NONE) return

  const played = await playNotificationSoundInRenderer(id)
  if (!played) {
    await api.notificationSounds.preview({ soundId: NOTIFICATION_SOUND_DEFAULT })
  }
}

/** Clear cached buffers and active playback state (for isolated tests). */
export function resetSoundPlayerCache(): void {
  stopRendererSoundPlayback()
  decodedBuffers.clear()
}
