# Marketing screenshots

`pnpm screenshots` ([`scripts/screenshots.ts`](../scripts/screenshots.ts)) takes the pictures laplace.live's Comet
pages show of the app and writes them to [`screenshots/<shot>.png`](../screenshots), which are committed. The app speaks
one language, so there is one set.

```sh
pnpm screenshots                    # every shot
pnpm screenshots --only=hero,login  # shots by name, comma-separated
```

Run it on a Mac with a Retina display, from a terminal with Screen Recording permission, with the screen unlocked, and
leave the Mac idle meanwhile: the app's window comes to the front and takes focus for each capture. The Graphite accent
colour and Increase Contrast change the window's chrome, so a run refuses them. It needs Node 22.18 or later, which runs
the script's TypeScript as is.

## The shots

- **`hero`**, a conversation in the narrow window, framed as the 447 × 679 window in the picture laplace.live/comet
  shows, so the 1118 × 1582 file drops in for it. `hero-dark` is the same in dark mode.
- **Docs shots**, named after the page they illustrate: `login` (the QR code screen) and `login-accounts` (the account
  menu) for `/comet/login`, `messaging` (a fan group chat) and `messaging-menu` (a conversation's pin and Do Not
  Disturb menu) for `/comet/messaging`, `settings` and `settings-about` for `/comet/settings`. `login` keeps the hero's
  narrow window; the rest use a wide one, so the session list sits beside the conversation and dialogs float instead of
  docking to the bottom.

The showcase ([`showcase.ts`](../scripts/screenshots/showcase.ts)) gives them something to show: a creator, 星屑电台,
with two more accounts, one of them signed out, and an inbox with a fan group, a verified studio, a pinned collaborator
and a 大会员. Everyone in it is made up, down to UIDs from a range Bilibili never hands out; their avatars are emoji on
gradients, painted by [`art.ts`](../scripts/screenshots/art.ts), and the fan art,
[`fan-art.jpg`](../scripts/screenshots/fan-art.jpg), was generated with Gemini, so no one's real face, name, UID,
message or artwork ships in a screenshot.

## How a run works

- **A fresh build on a throwaway profile.** The script builds what `pnpm package` builds, from `forge.config.ts` and
  by the Vite worker Forge runs per target, plus the harness ([`harness.ts`](../scripts/screenshots/harness.ts))
  beside it in `.vite/build`, with `NODE_ENV=production` for the build and the app whatever your shell exports. It
  starts Electron on the checkout with the harness preloaded (`-r`), so the harness moves `appData` into a temporary
  folder before the real `main.cjs` loads, and your accounts, settings and Chromium profile stay untouched.
  `--use-mock-keychain` keeps safeStorage, and the credentials it seals, off your keychain.
- **Bilibili is the showcase.** The harness replaces the main process's `fetch` with the showcase, which answers the
  `BILIBILI_ENDPOINTS` the app calls with replies typed as the app's own API types, and serves the renderer's pictures
  through `protocol.handle`. Every other socket is refused, so the broadcast WebSocket retries in the log and a run
  never reaches the network. A request the showcase has no answer for fails the run, naming it.
- **Pictures made for the run.** Before the first shot, the harness paints every avatar on a canvas in the app's page,
  which has the emoji font, and moves each emoji so the middle of its ink is the middle of the face, rather than leave
  it to an SVG's text, which Chromium sets a device pixel or two off centre at avatar sizes. The fan art is the top
  square of `fan-art.jpg`: a bubble draws a picture 300 px wide in its own proportions and a chat opens on its newest
  message, so the whole portrait would show little but its lower half.
- **Signed in the way a user does.** A fresh profile opens on the login screen, where `login` is taken; the showcase
  then confirms its QR code and the app signs in on its own next poll. The other two accounts come in through the IPC
  the Add Account sheet uses. The last is then signed out on the showcase's side and made active, so the app's own
  login check marks it 需重新登录 and falls back to the first.
- **Staged per shot.** Each shot reloads the page in its window size and theme (`nativeTheme.themeSource`), then opens
  its conversation and its menu with mouse presses, as a user does, or Settings and About through the events the app
  menu sends. A press rather than `click()`: without a pointer Chromium takes what follows for keyboard use, so a menu
  highlights its first item and a dialog draws a focus ring on the link it focuses.
- **Captured as macOS draws the window**, traffic lights and shadow included, with `screencapture -l` on its window id;
  `sips` converts every PNG to sRGB.
- **Only real changes are written.** Each capture is compared with the committed file, which stays when they differ in
  no more than the harness's `NOISE` share of pixels, so a rerun after an unrelated change leaves git clean. A pixel
  only counts as changed when a channel moves by more than `CHANNEL_TOLERANCE`, which absorbs the colour conversion
  from another display but also hides a palette tweak that small: delete the PNGs it affects before the run. A full
  run deletes the committed PNGs of shots no longer listed, and leaves files git doesn't track alone.

## Adding a shot

Add an entry to `SHOTS` in [`shots.ts`](../scripts/screenshots/shots.ts): its window, the conversation it opens, and what
it opens on top. New people, conversations or accounts go in the showcase. An endpoint the app newly calls needs an
answer there too, or the run fails naming it.

## Keeping shots still

Two runs must draw the same pixels, or every rerun rewrites the PNGs. The page's clock is held at Sunday 4 October
2026, 20:32 in Beijing over the DevTools protocol (`Date` and the time zone, not the app's code), so `3 分钟前` and
`20:31` read the same whenever the run happens. Scroll bars are hidden, as overlay ones are when nothing scrolls, so
a mouse or the "Always" setting can't add classic ones. Before each capture an input gives up focus so no caret
blinks, looping animations (the login screen's ping, the connected badge's pulse) are held at their first frame, and
the pointer leaves the window.

## When to run it

After merging each Version Packages PR, on the updated `master`: `settings-about` shows the version from
`package.json`, which only that merge bumps, so the shots change with every release, and the website then pictures
what users download. Also after editing a shot or the showcase. Commit the PNGs it rewrites.

## Pitfalls

- macOS can refuse to activate the app while someone types in another one, and an inactive window draws grey traffic
  lights and a smaller shadow. Before each shot loads and again for its capture, the harness re-requests focus until
  the window is key, for up to five minutes, and asks for a click when it takes long. Behind the lock screen nothing
  takes focus at all; it says so and waits, and the five minutes start once the Mac is unlocked.
- It rebuilds `.vite/` the way `pnpm package` does, so don't run it beside `pnpm start`, which builds there too.
- The harness is built with the main process's own Vite config, which strips `console.log` from production bundles:
  it logs with `console.info`.
- The account menu opens against the right end of its trigger, which spans the session list. In the narrow window that
  is the window's edge, away from the avatar the docs point at, so `login-accounts` uses the wide window.
