// The showcase's pictures, so no one's real face or artwork ships in a screenshot: avatars are an emoji on a
// gradient, painted in the app's page, and the fan art is fan-art.jpg, an illustration generated with Gemini.

import { nativeImage } from 'electron'

import fanArtJpg from './fan-art.jpg?inline'

export type Face = [emoji: string, from: string, to: string]

/** Px square each avatar is painted at: three times the 80 device px a 2× display draws the largest at. */
export const FACE_SIZE = 240

/**
 * Runs in the page: each face as a PNG data URL, `size` px square, its emoji on a diagonal gradient lit from the
 * top left. Painted rather than left to an SVG's text, which Chromium sets a device pixel or two off centre at
 * avatar sizes; and centred by where the emoji's ink falls, as Apple draws some (🍊, 🎵) off centre in their box.
 */
export function paintFaces(faces: Record<string, Face>, size: number): Record<string, string> {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('no 2D canvas to paint the avatars on')
  const draw = (emoji: string, x: number, y: number): void => {
    ctx.fillStyle = '#000'
    ctx.font = `${String(size / 2)}px "Apple Color Emoji"`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(emoji, x, y)
  }
  const painted: Record<string, string> = {}
  for (const [key, [emoji, from, to]] of Object.entries(faces)) {
    // The emoji alone, to find its ink: its edge is where it turns half opaque, which leaves out faint steam.
    ctx.reset()
    draw(emoji, size / 2, size / 2)
    const { data } = ctx.getImageData(0, 0, size, size)
    let [left, top, right, bottom] = [size, size, 0, 0]
    for (let pixel = 0; pixel < size * size; pixel++) {
      if (data[pixel * 4 + 3] < 128) continue
      const x = pixel % size
      const y = Math.floor(pixel / size)
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x + 1)
      bottom = Math.max(bottom, y + 1)
    }

    ctx.reset()
    const fill = ctx.createLinearGradient(0, 0, size, size)
    fill.addColorStop(0, from)
    fill.addColorStop(1, to)
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, size, size)
    const light = ctx.createRadialGradient(size * 0.3, size * 0.22, 0, size * 0.3, size * 0.22, size * 0.75)
    light.addColorStop(0, 'rgb(255 255 255 / 0.38)')
    light.addColorStop(1, 'rgb(255 255 255 / 0)')
    ctx.fillStyle = light
    ctx.fillRect(0, 0, size, size)
    ctx.shadowColor = 'rgb(0 0 0 / 0.18)'
    ctx.shadowOffsetY = size / 40
    ctx.shadowBlur = size / 20
    // Moved so the middle of its ink is the middle of the face.
    draw(emoji, size - (left + right) / 2, size - (top + bottom) / 2)
    painted[key] = canvas.toDataURL('image/png')
  }
  return painted
}

/**
 * The fan art as it's sent: the top square of fan-art.jpg. A chat bubble draws a picture 300 px wide in its own
 * proportions and the chat opens on the newest message, so the whole portrait would show little but its lower half.
 */
export function fanArt(): { png: Uint8Array<ArrayBuffer>; width: number; height: number } {
  const portrait = nativeImage.createFromDataURL(fanArtJpg)
  if (portrait.isEmpty()) throw new Error('fan-art.jpg did not decode')
  const { width } = portrait.getSize()
  return { png: new Uint8Array(portrait.crop({ x: 0, y: 0, width, height: width }).toPNG()), width, height: width }
}
