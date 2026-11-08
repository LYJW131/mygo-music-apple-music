# Apple Music for MyGo Music

A [MyGo Music](https://github.com/egoist/mygo-music) plugin: Apple Music's catalog, the listener's library and whole
songs as 256 kbps AAC, through the music.apple.com web player's API. Widevine keys come from a CDM written here in
TypeScript (`src/widevine/`); ffmpeg decrypts. Lossless (ALAC) goes through the listener's wrapper-manager and
`amhelper`, a Go program shipped in the plugin (`helper/`). The plugin spec is MyGo Music's README ("Plugins") and
`internal/plugin/*.go`.

## Commands

```bash
npm run build        # src/ → dist/plugin (index.js bundle + plugin.json, locales, READMEs, LICENSE)
npm test             # build, then node --test tests/*.test.ts (offline)
npm run check        # typecheck + prettier --check + test + test:helper + package; what CI runs
npm run test:helper  # go vet + go test in helper/
npm run helper       # builds amhelper for this machine into dist/plugin/bin
npm run format       # prettier --write
npm run test:live    # signed out, real Apple API (not in CI)
APPLE_MUSIC_TOKEN_FILE=… npm run test:signed-in   # signed in, plays one song through ffmpeg (not in CI)
```

Node 22.18+ runs the `.ts` scripts and tests directly (type stripping); there is no tsx. Go (`helper/go.mod`) builds
and tests amhelper.

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
- Listening history: `activity.ts` answers `played`, which MyGo calls as a song starts, by posting a start to Apple's
  play activity service as MusicKit JS does (`universal-activity-service.itunes.apple.com/play`), with the previous
  song's end timed by the clock. Durations come from `toTrack`. The `listeningHistory` setting set to `off` stops it.
- Lossless: `lossless.ts` starts amhelper (config on stdin: wrapper, key, cache dir; it answers `{port, secret}`),
  notes each catalog song's `audioTraits` and `extendedAssetUrls.enhancedHls`, and asks amhelper to `prepare` a song
  and serve `song/<id>.m4a`; `null` falls back to AAC. Following amdl, lossless songs use the catalog's master
  playlist and Hi-Res ones the wrapper's `/m3u8` first (the catalog's sometimes lacks 88.2–192 kHz).
- `helper/`: `main.go` routes, `wrapper.go` the wrapper client (one request at a time, `queue.go` puts played songs
  before ones prepared ahead), `hls.go` playlists, `mp4.go` decrypts Apple's 15 s fragments into ~1 s ones as they
  arrive, `alac.go` checks a key's first samples look like ALAC (a wrong template gives noise, not an error),
  `store.go` the disk cache (templates and tracks ≤2000 each, tracks a week; a bad template or a 404 media file is fetched again).
  `internal/fairplay` is amdl's Temari port, copied; change it there first.
- Library ahead: `index.ts` wraps every export in `foreground` (`background.ts`), and `warmup.ts` fetches favorites,
  saved albums, stations, recently added and the 20 playlists changed last, one request at a time, pausing while the
  app asks for anything and a second after. Answers are `kept`: a library playlist until its `lastModifiedDate`
  changes, the rest for 10 minutes; writes `forget` what they change. A function's second argument `ahead` marks a
  background call; the app only ever passes one.
- Liked is Favorite Songs, the library playlist with `canDelete: false` and no catalog version, hidden from
  `playlists`; liking is a rating of 1.
- Upstream watch: `.github/workflows/upstream.yml` runs `scripts/upstream-watch.ts` when MyGo releases. Claude Opus
  (Anthropic API through GitHub OIDC, no key) reads the diff against the plugin, runs what it can on the runner, and
  `scripts/upstream-watch/report.ts` turns its report into a comment by lyjw131[bot] on the open Automation issue.
  Commands run under bubblewrap only to keep the job's OIDC request token from them. It runs Opus 5.5 in fast mode
  (twice the price). Breakers: 30 minutes and $10 a run (then it is told to hand in; past 1.5 times either it stops),
  and 3 automatic runs a day. When the report says the plugin needs a change, the same conversation makes it (20
  minutes and $10 more, `npm run check` must pass, no `.github/`), and `scripts/upstream-watch/propose.ts` opens a
  draft pull request of one commit, made through `createCommitOnBranch` so GitHub signs it as lyjw131[bot],
  co-authored by the Claude models only. To run it locally, set `ANTHROPIC_BASE_URL` to the magpie gateway
  (`http://127.0.0.1:3425`) and any `ANTHROPIC_API_KEY`.
  `helper/cmd/fakeapple` stands in for a wrapper and Apple's CDN (Temari's published sample, looped), so amhelper
  runs end to end without an account.
- Types: `src/types/host.d.ts` (the global `host`), `music.ts` (what MyGo takes), `apple.ts` (what Apple answers).

## Runtime constraints

The bundle runs in MyGo's moejs runtime, not Node:

- One ES module that imports nothing at runtime; `scripts/build.ts` fails the build otherwise. No Node APIs, no
  `Buffer`, no `crypto.subtle`. There are `fetch`, `BigInt`, `TextEncoder`, `atob`, timers and the `host` global.
- Never touch `host` at module load: tests import `src/` modules directly without one.
- Erasable TypeScript only (no `enum`, `namespace`, parameter properties): `erasableSyntaxOnly` is on, as Node strips
  types. Relative imports end in `.ts`.
- Errors the app should act on carry a code: `fail("signIn" | "setup" | "unavailable" | "unsupported", message)`.
- `host.storage` keys: `mediaUserToken`, `storefront`, `profile` (name and picture, a day), `devToken`, `resolved` (song → media + key, ≤3000), `covers`,
  `quality` (the app's last asked), `lossless` (song → its ALAC or none, a week).

## Conventions

- User-facing text goes through `t("English text")` and needs an entry in `locales/zh-CN.json`; a test checks every
  `t("…")` and navigation title. Chinese follows Apple Music's own Simplified Chinese wording (资料库, 歌单, 个人收藏,
  国家或地区, 账户), from the web player's translation strings.
- Comments say why, in plain sentences. Keep the existing tone.
- Never print or commit a media-user-token or developer token. Signed-in tests read the token from a file.
- `plugin.json` holds the version; `package.json` has none.
- Commits follow Conventional Commits, in English: `type(scope): summary` (types `feat`, `fix`, `perf`, `docs`,
  `test`, `build`, `ci`, `chore`; scopes such as `lossless`, `playback`, `library`, `helper`), lower case, no full
  stop. The body says what changed and why in plain sentences, wrapped at 72. Sign off (`git commit -s`), and end
  with the `Co-Authored-By` trailer.

## Releasing

MyGo installs the latest release's zip for its platform (`mygo-music-apple-music-v<version>-<os>-<arch>.zip`, with
`bin/amhelper`), else the one without a platform (AAC only), else the default branch, which has no built `index.js`: a
release is required. `scripts/package.ts` builds all of them; `scripts/helper.ts` lists the platforms.

1. Raise `version` in `plugin.json`, push to `main`, wait for CI.
2. Tag that commit `v<version>` and push the tag. The **Release** workflow checks the tag matches `plugin.json` and is
   on `main`, runs `npm run check`, and publishes the release with the zips and their SHA-256. Every listener is
   offered it as an update, so ask the maintainer before pushing a tag.

To try a build in the local app, unzip `dist/release/…-linux-amd64.zip` (or copy `dist/plugin/*` after
`npm run helper`) into `~/.config/MyGo Music/plugins/apple-music/` (a real
directory: symlinks aren't loaded) and restart MyGo.
