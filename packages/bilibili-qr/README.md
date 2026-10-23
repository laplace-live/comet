# @laplace.live/bilibili-qr

Log in to Bilibili with a QR code, the way bilibili.com's web login does: issue a code, poll it while the user scans
and confirms it in the Bilibili app, and collect the session cookies. Extracted from
[LAPLACE Comet](https://github.com/laplace-live/comet), which signs in this way.

It needs a `fetch` that shows `Set-Cookie` headers (`Headers#getSetCookie()`) and returns redirects as they are
(`redirect: 'manual'`), as Node.js 22 or later, Bun, Deno and Cloudflare Workers do (Workers from compatibility date
2023-03-01, which brought `getSetCookie()`); its tests run on Node.js. Not in a web page, where browsers hide both
from scripts.

No runtime dependencies, and it draws nothing: show the code's `url` with whatever suits the app, such as
[`qrcode-terminal`](https://github.com/gtanner/qrcode-terminal) in a terminal or
[`@nuintun/qrcode`](https://github.com/nuintun/qrcode) for an image.

```sh
pnpm add @laplace.live/bilibili-qr
```

## Usage

```ts
import { cookieStringFromCredentials, generateQRCode, pollQRCode } from '@laplace.live/bilibili-qr'
import qrcode from 'qrcode-terminal'

const { url, qrcodeKey } = await generateQRCode()
qrcode.generate(url, { small: true }) // Scan it with the Bilibili app

for (;;) {
  await new Promise(resolve => setTimeout(resolve, 3000))
  const result = await pollQRCode(qrcodeKey, { signal: AbortSignal.timeout(15_000) })

  if (result.status === 'success') {
    // Sign requests in as the user who scanned the code
    const cookie = cookieStringFromCredentials(result.credentials)
    break
  }
  if (result.status === 'expired') break // Generate a new code
  // waiting_scan, waiting_confirm: keep polling. unknown: a state in result.response.data
}
```

Start the next poll only once the previous one has answered: a successful poll can consume the QR key, so
overlapping polls can lose the login.

## API

**`generateQRCode(options?)`** issues a code and resolves to `{ url, qrcodeKey, response }`: the URL to show as a QR
code, the key to poll it with, and Bilibili's response as received.

**`pollQRCode(qrcodeKey, options?)`** resolves to the login's state, with Bilibili's `response` as received:

| `status`          | Means                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| `waiting_scan`    | Nobody has scanned the code yet                                         |
| `waiting_confirm` | Scanned, waiting for the user to confirm the login in the app           |
| `expired`         | The code no longer logs in: generate a new one                          |
| `success`         | Logged in: `credentials` holds the session cookies, plus `refreshToken` |
| `unknown`         | A state this package doesn't know, in `response.data.code`              |

On `success` the package has collected the cookies, from the login URL Bilibili returns, the poll's `Set-Cookie`
headers, or by exchanging the one-use ticket the URL carries at Bilibili's passport. The ticket is only ever sent to
`passport.bilibili.com` and `passport.biligame.com`, redirects included.

**`cookieStringFromCredentials(credentials)`** builds the `Cookie` header for the credentials, encoding `SESSDATA`
back the way Bilibili set it.

Both requesting functions take the same options:

- `headers`: the headers every request sends, in place of `DEFAULT_HEADERS` (Chrome on Windows). Spread
  `DEFAULT_HEADERS` in to add to them rather than replace them.
- `signal`: aborts the call, a confirmed login's ticket exchange included.
- `fetch`: the `fetch` to send requests with, the global one by default.

`QR_CODE_STATUS` names Bilibili's state codes and `QR_LOGIN_ENDPOINTS` its two endpoints, for mocking them in tests.

### Errors

A failure on Bilibili's side rejects with a `QRLoginError`, whose `reason` says what failed:

- `http`: an HTTP error, its status in `status`
- `api`: Bilibili refused the request, with its `code` and its explanation, as received, in `apiMessage`. That is
  also the `message`, unless Bilibili sent none: `apiMessage` is then empty, and `message` names the code.
- `response`: a response this package doesn't understand
- `credentials`: the login was confirmed, but its cookies couldn't be collected

Network failures and aborts reject with whatever `fetch` threw: the signal's reason for an abort, such as the
`TimeoutError` of `AbortSignal.timeout`.

## The credentials are the account

`SESSDATA` signs in as the user, and `bili_jct` is the CSRF token Bilibili's write APIs take as `csrf`: store them as
you would a password. A successful poll's `response.data.url` carries the login too, so never log it.

The package doesn't renew cookies. `refreshToken` is what Bilibili's cookie refresh takes, should you implement it.

## License

AGPL-3.0
