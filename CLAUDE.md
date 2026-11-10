# Apple Music for MyGo Music

A [MyGo Music](https://github.com/egoist/mygo-music) plugin: Apple Music's catalog, the listener's library and whole
songs as 256 kbps AAC, through the music.apple.com web player's API. Widevine keys come from a CDM written here in
TypeScript (`src/widevine/`); `amhelper`, a Go program shipped in the plugin (`helper/`), decrypts, and MyGo (0.1.21
on) plays the fragmented MP4 it serves itself. ffmpeg does instead only where the zip has no amhelper. Lossless (ALAC)
goes through the listener's wrapper-manager and amhelper. The plugin spec is MyGo Music's README ("Plugins") and
`internal/plugin/*.go`.

## Commands

```bash
npm run build        # src/ → dist/plugin (index.js bundle + plugin.json, locales, READMEs, LICENSE)
npm test             # build, then node --test tests/*.test.ts (offline)
npm run check        # typecheck + prettier --check + test + test:helper + package; what CI runs
npm run test:helper  # go vet + go test in helper/
npm run helper       # builds amhelper for this machine into dist/plugin/bin
npm run format       # prettier --write
npm run test:e2e     # plays AAC and ALAC through MyGo's own plugin host and player, no account (CI, every platform)
npm run test:live    # signed out, real Apple API (not in CI)
APPLE_MUSIC_TOKEN_FILE=… npm run test:signed-in   # signed in, plays one song through amhelper and ffmpeg (not in CI;
                                                  # npm run helper after its build, or it plays through ffmpeg twice)
APPLE_MUSIC_WRITE_TOKEN_FILE=… npm run test:live-write   # changes an account kept for testing, and puts it back:
                                                         # a playlist made, edited and deleted (not in CI)
```

Node 22.18+ runs the `.ts` scripts and tests directly (type stripping); there is no tsx. Go (`helper/go.mod`) builds
and tests amhelper.

## Layout

- `src/index.ts` exports exactly the functions MyGo calls; `tests/plugin.test.ts` pins that list. Add an export there
  and in the test together.
- `src/api.ts` requests to amp-api (dev token + `media-user-token`, 401 retries once with a fresh dev token, and a
  refused token from the wrapper once after asking it again), `session.ts` tokens, `account.ts` sign-in (the
  `mediaUserToken` setting first, for accounts with a passkey or security key, which the window can't use; then the
  `wrapperAccount` setting; else the window), `wrapperaccount.ts` the token of an account the wrapper holds (amhelper's
  `GET token?account=`, asked again a little after the wrapper's `next_refresh_at`, between a minute and an hour; a
  wrapper-manager holds up to ten accounts, so the setting names one by Apple ID, instance id or region, never the first
  that comes), `models.ts` Apple resources → MyGo shapes.
- Pages: `browse.ts` (home, charts, recently added), `search.ts`, `library.ts`, `pages.ts` (album/artist/playlist),
  `stations.ts`, `lyrics.ts` (TTML).
- Playing: `playback.ts` (webPlayback → m3u8 → license; the song handed to amhelper as `POST aac/<id>` with its key
  and length, the segments' EXTINFs added up, and played from `aac/<id>.m4a`; ffmpeg `-listen` on 127.0.0.1 as ADTS
  where there's no amhelper), `amhelper.ts` (starts it; config on stdin), `prefetch.ts` (warm
  connections, resolve the first 3 songs of a page, ≤15/min; every list the app may play from is noted, home's only
  where no page opened has the song, and a song played lossless works out the 12 after it; a station's 10 are worked out
  as they come; `lyrics`, asked as every song starts, even one played from the app's cache, counts as playing, which
  leaves the wrapper asleep), `ffmpeg.ts`, `artwork.ts` (private playlist covers are slow blobstore links, kept locally
  by amhelper's `POST cover/<name>`, or ffmpeg).
- Listening history: `activity.ts` answers `played`, which MyGo calls as a song starts, by posting a start to Apple's
  play activity service as MusicKit JS does (`universal-activity-service.itunes.apple.com/play`), with the previous
  song's end timed by the clock. Durations come from `toTrack`. The `listeningHistory` setting set to `off` stops it.
- Lossless: `lossless.ts` (through `amhelper.ts`, whose config on stdin is wrapper, key, cache dir and covers dir; it
  answers `{port, secret}`, and runs without a wrapper for AAC and covers) notes each catalog song's `audioTraits` and `extendedAssetUrls.enhancedHls`, and asks amhelper to `prepare` a song
  and serve `song/<id>.m4a`; `null` falls back to AAC. Following amdl, lossless songs use the catalog's master
  playlist and Hi-Res ones the wrapper's `/m3u8` first (the catalog's sometimes lacks 88.2–192 kHz).
- `helper/`: `main.go` routes, `aac.go` the AAC (CENC, AES-CTR with each sample's IV from `senc`, and an edit list that
  skips the encoder's 2112 frames of priming), `cover.go` playlist covers (JPEG, shrunk to 600 wide), `account.go` an account's token (`/status`'s instances, then
  `/token?instance=`; neither waits behind songs), `wrapper.go` the
  wrapper client (one request at a time, `queue.go` puts played songs
  before ones prepared ahead), `hls.go` playlists, `mp4.go` decrypts Apple's 15 s fragments into ~1 s ones as they
  arrive, `alac.go` checks a key's first samples look like ALAC (a wrong template gives noise, not an error),
  `store.go` the disk cache (templates and tracks ≤2000 each, tracks a week; a bad template or a 404 media file is fetched again).
  `internal/fairplay` is amdl's Temari port, copied; change it there first.
- Library ahead: `index.ts` wraps every export in `foreground` (`background.ts`), and `warmup.ts` fetches favorites,
  saved albums, stations, recently added and the 20 playlists changed last, one request at a time, pausing while the
  app asks for anything and a second after. Answers are `kept`: a library playlist until its `lastModifiedDate`
  changes, the rest for 10 minutes; writes `forget` what they change. A function's second argument `ahead` marks a
  background call; the app only ever passes one.
- Playlist edits (`library.ts`): renamed, deleted, songs taken out by their library IDs, a new order PUT whole. Apple
  answers with the playlist as it was for a while after, its date too, so for 5 minutes the plugin answers with what
  the listener made of it (`edited`).
- Liked is Favorite Songs, the library playlist with `canDelete: false` and no catalog version, hidden from
  `playlists`; liking is a rating of 1.
- Upstream watch: `.github/workflows/upstream.yml` runs `scripts/upstream-watch.ts` when MyGo releases. Claude Fable
  (Anthropic API through GitHub OIDC, no key) reads the diff against the plugin, runs what it can on the runner, and
  `scripts/upstream-watch/report.ts` turns its report into a comment by lyjw131[bot] on the open Automation issue.
  Commands run under bubblewrap only to keep the job's OIDC request token from them. It runs Fable 5.2 in fast mode
  (twice the price). Breakers: 30 minutes and $20 a run (then it is told to hand in; past 1.5 times either it stops),
  and 3 automatic runs a day. When the report says the plugin needs a change, the same conversation makes it (20
  minutes and $20 more, `npm run check` must pass, no `.github/`), and `scripts/upstream-watch/propose.ts` opens a
  draft pull request of one commit, made through `createCommitOnBranch` so GitHub signs it as lyjw131[bot],
  co-authored by the Claude models only. To run it locally, set `ANTHROPIC_BASE_URL` to the magpie gateway
  (`http://127.0.0.1:3425`) and any `ANTHROPIC_API_KEY`.
  `helper/cmd/fakeapple` stands in for a wrapper and Apple's CDN (Temari's published sample, looped, and the web
  player's CENC AAC, made from `testdata/tone.aac`), so amhelper runs end to end without an account; amhelper asks it
  for Apple's files when `AMHELPER_APPLE` is set.
- End to end: `scripts/e2e.ts` checks out MyGo (its `minAppVersion` and newest release) into `dist/e2e`, copies
  `e2e/mygo_test.go` into its `internal/player`, and runs it: MyGo's plugin host loads the built plugin with a song
  of each kept in its storage, and MyGo's player plays what it answers, checked sample for sample against the same
  audio unencrypted. CI runs it on each platform a release ships amhelper for.
- Types: `src/types/host.d.ts` (the global `host`), `music.ts` (what MyGo takes), `apple.ts` (what Apple answers).

## Runtime constraints

The bundle runs in MyGo's moejs runtime, not Node:

- One ES module that imports nothing at runtime; `scripts/build.ts` fails the build otherwise. No Node APIs, no
  `Buffer`, no `crypto.subtle`. There are `fetch`, `BigInt`, `TextEncoder`, `atob`, timers and the `host` global.
- Never touch `host` at module load: tests import `src/` modules directly without one.
- Erasable TypeScript only (no `enum`, `namespace`, parameter properties): `erasableSyntaxOnly` is on, as Node strips
  types. Relative imports end in `.ts`.
- Errors the app should act on carry a code: `fail("signIn" | "setup" | "unavailable" | "unsupported", message)`.
- `host.storage` keys: `mediaUserToken`, `givenToken` (the `mediaUserToken` setting last signed in with, for accounts
  the sign-in window can't sign in to), `storefront`, `profile` (name and picture, a day), `devToken`, `resolved` (song → media + key + seconds, ≤3000; ones kept without seconds have their playlist read again), `covers`,
  `quality` (the app's last asked), `wrapperAccount` (the wrapper and account named, the token it gave and when to ask
  again), `lossless` (song → its ALAC or none, a week).

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
   on `main`, runs CI (`npm run check`, and the end-to-end test on every platform), and publishes the release with the zips and their SHA-256. Every listener is
   offered it as an update, so ask the maintainer before pushing a tag.

To try a build in the local app, unzip `dist/release/…-linux-amd64.zip` (or copy `dist/plugin/*` after
`npm run helper`) into `~/.config/MyGo Music/plugins/apple-music/` (a real
directory: symlinks aren't loaded) and restart MyGo.
