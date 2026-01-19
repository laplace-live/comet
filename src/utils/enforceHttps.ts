/**
 * Force HTTPS for the given URL, mainly used by avatar URL. will return `''` for invalid string
 * @param url
 * @returns
 */
export function enforceHttps(url: string | undefined | null) {
  if (typeof url === 'string') {
    return url.replace('http:', 'https:')
  } else {
    return ''
  }
}
