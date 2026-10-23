/**
 * What made a login call fail:
 * - `http`: Bilibili answered with an HTTP error, in `status`
 * - `api`: Bilibili refused the request, with its `code` and its explanation in `apiMessage`
 * - `response`: Bilibili's answer wasn't one this package understands
 * - `credentials`: the login was confirmed, but its session cookies couldn't be collected
 */
export type QRLoginErrorReason = 'http' | 'api' | 'response' | 'credentials'

/**
 * A login call's failure on Bilibili's side. Network failures and aborts reject with whatever `fetch` threw, the
 * abort signal's reason for an abort.
 */
export class QRLoginError extends Error {
  readonly reason: QRLoginErrorReason
  /** The HTTP status of an `http` failure */
  readonly status: number | undefined
  /** Bilibili's error code of an `api` failure */
  readonly code: number | undefined
  /** Bilibili's explanation of an `api` failure as received, empty when it gave none; `message` names the code then */
  readonly apiMessage: string | undefined

  constructor(
    reason: QRLoginErrorReason,
    message: string,
    { status, code, apiMessage, cause }: { status?: number; code?: number; apiMessage?: string; cause?: unknown } = {}
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'QRLoginError'
    this.reason = reason
    this.status = status
    this.code = code
    this.apiMessage = apiMessage
  }
}
