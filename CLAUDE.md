# Apple Music for MyGo Music

A [MyGo Music](https://github.com/egoist/mygo-music) plugin: Apple Music's catalog, the listener's library and whole
songs as 256 kbps AAC, through the music.apple.com web player's API. Widevine keys come from a CDM written here in
TypeScript (`src/widevine/`); ffmpeg decrypts. The plugin spec is MyGo Music's README ("Plugins") and
`internal/plugin/*.go`.

## Commands

```bash
npm run build        # src/ → dist/plugin (index.js bundle + plugin.json, locales, README, LICENSE)
npm test             # build, then node --test tests/*.test.ts (offline)
npm run check        # typecheck + prettier --check + test + package; what CI runs
npm run format       # prettier --write
npm run test:live    # signed out, real Apple API (not in CI)
APPLE_MUSIC_TOKEN_FILE=… npm run test:signed-in   # signed in, plays one song through ffmpeg (not in CI)
```

Node 22.18+ runs the `.ts` scripts and tests directly (type stripping); there is no tsx.

## Layout

- `src/index.ts` exports exactly the functions MyGo calls; `tests/plugin.test.ts` pins that list. Add an export there
  and in the test together.
- `src/api.ts` requests to amp-api (dev token + `media-user-token`, 401 retries once with a fresh dev token),
  `session.ts` tokens, `account.ts` sign-in, `models.ts` Apple resources → MyGo shapes.
- Pages: `browse.ts` (home, charts, recently added), `search.ts`, `library.ts`, `pages.ts` (album/artist/playlist),
  `stations.ts`, `lyrics.ts` (TTML).
- Playing: `playback.ts` (webPlayback → m3u8 → license → ffmpeg `-listen` on 127.0.0.1), `prefetch.ts` (warm
  connections, resolve the first 3 songs of a page, ≤15/min), `ffmpeg.ts`, `artwork.ts` (private playlist covers are
  slow blobstore links, kept locally via ffmpeg).
- Types: `src/types/host.d.ts` (the global `host`), `music.ts` (what MyGo takes), `apple.ts` (what Apple answers).

## Runtime constraints

The bundle runs in MyGo's moejs runtime, not Node:

- One ES module that imports nothing at runtime; `scripts/build.ts` fails the build otherwise. No Node APIs, no
  `Buffer`, no `crypto.subtle`. There are `fetch`, `BigInt`, `TextEncoder`, `atob`, timers and the `host` global.
- Never touch `host` at module load: tests import `src/` modules directly without one.
- Erasable TypeScript only (no `enum`, `namespace`, parameter properties): `erasableSyntaxOnly` is on, as Node strips
  types. Relative imports end in `.ts`.
- Errors the app should act on carry a code: `fail("signIn" | "setup" | "unavailable" | "unsupported", message)`.
- `host.storage` keys: `mediaUserToken`, `storefront`, `devToken`, `resolved` (song → media + key, ≤3000), `covers`.

## Conventions

- User-facing text goes through `t("English text")` and needs an entry in `locales/zh-CN.json`; a test checks every
  `t("…")` and navigation title. Chinese follows Apple Music's own Simplified Chinese wording (资料库, 歌单, 个人收藏,
  国家或地区, 账户), from the web player's translation strings.
- Comments say why, in plain sentences. Keep the existing tone.
- Never print or commit a media-user-token or developer token. Signed-in tests read the token from a file.
- `plugin.json` holds the version; `package.json` has none.

## Releasing

MyGo installs the latest release's zip (`mygo-music-apple-music-v<version>.zip`, no platform in the name), else the
default branch, which has no built `index.js`: a release is required.

1. Raise `version` in `plugin.json`, push to `main`, wait for CI.
2. Tag that commit `v<version>` and push the tag. The **Release** workflow checks the tag matches `plugin.json` and is
   on `main`, runs `npm run check`, and publishes the release with the zip and its SHA-256. Every listener is
   offered it as an update, so ask the maintainer before pushing a tag.

To try a build in the local app, copy `dist/plugin/*` into `~/.config/MyGo Music/plugins/apple-music/` (a real
directory: symlinks aren't loaded) and restart MyGo.
