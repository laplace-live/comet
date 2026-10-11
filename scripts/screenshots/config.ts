/** What `screenshots.ts` hands the harness it launches, as JSON in {@link CONFIG_ENV}. */
export interface HarnessConfig {
  /** Chromium's profile parent, so the run never shares the real app's userData or accounts. */
  appData: string
  /** The committed screenshots folder. */
  out: string
  /** Shot names to take; empty means all. */
  only: string[]
}

export const CONFIG_ENV = 'COMET_SCREENSHOTS_CONFIG'
