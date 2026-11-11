# Apple Music for MyGo Music

[![Install in MyGo Music](docs/install-badge.en.svg)](https://lyjw131.github.io/mygo-music-apple-music/install.html)

Search and play Apple Music in [MyGo Music](https://github.com/egoist/mygo-music), as 256 kbps AAC, and optionally as
Hi-Res Lossless ALAC up to 24-bit/192 kHz (set up [below](#lossless)).

[中文](README.md)

## Install and use

1. Click the badge above, and MyGo Music asks to install it; or paste `https://github.com/LYJW131/mygo-music-apple-music` in
   Settings > Plugins > `+`.
2. Choose **Apple Music** as the source.
3. Sign in with an Apple account that has a subscription. For an account that signs in with a passkey or security key,
   see [below](#media-user-token).
4. Allow Apple Music to start programs in Settings > Plugins > Apple Music. The plugin's own `amhelper` decrypts songs
   on this machine and MyGo Music plays them itself, with nothing else to install; only on a platform it doesn't come
   for, such as Windows on arm64, does it play through [ffmpeg](https://ffmpeg.org), which you install.

<a id="media-user-token"></a>

### Signing in with a media-user-token

MyGo Music's sign-in window can't use passkeys. Sign in in your own browser instead, and give the plugin its token:

1. On [music.apple.com](https://music.apple.com), signed in, open the developer tools (F12) and copy the value of
   `media-user-token` under Application (Storage) > Cookies > `https://music.apple.com`.
2. Paste it in Settings > Plugins > Apple Music > **Media User Token**. The whole cookie header works too.

That signs you in; emptying it signs you out. When the token runs out (usually after some months), copy and paste a new
one.

<a id="wrapper-account"></a>

### Signing in with the wrapper's account

If your account is logged in to a [wrapper-manager](#lossless) already, you needn't sign in to the plugin as well: put
the account's Apple ID in **Wrapper Account**. The plugin asks the wrapper for the account's media-user-token through
`amhelper`, and the wrapper refreshes the token on its own. It needs [AMDL-Web](https://github.com/AMDL-Web)'s
[wrapper](https://github.com/AMDL-Web/wrapper).

- **Several accounts**: your Apple ID names the one to use, or a country or region code such as `jp` the wrapper's
  first ready account there.
- A **Media User Token** in the settings goes first. Emptying **Wrapper Account** signs you out.

## Features

- Home recommendations, recently played, stations, library albums, library playlists, recently added.
- Adding songs to Favorite Songs.
- Adding to the library and removing from it.
- Creating, renaming and deleting playlists, and adding, removing and reordering their songs.
- Playing songs you uploaded to your library (through `amhelper`).
- Full lyrics, word by word where Apple has them, with translations. The account shows your Apple Music name and
  picture.
- Optional lossless, falling back to AAC when it isn't set up or a song can't be had.
- With MyGo Music's Settings > Playback > **Even Out Loudness** on, songs play as loud as each other, by the loudness
  Apple measured of each.
- Songs played in MyGo Music count toward your listening history as in Apple's own apps, and those played from an album
  or playlist page show in Recently Played; type `off` in the plugin's **Use Listening History** setting to stop it.

<a id="lossless"></a>

## Lossless and Hi-Res Lossless

### How it works

It needs a `wrapper` signed in to an account with a subscription. The plugin's own `amhelper` gets the key templates
from it, decrypts the song on this machine as it downloads, and hands it to MyGo Music.

### Setting up

1. Run a wrapper-manager (see below) and sign in to your Apple Music account in it (it needn't be the account in the
   app, but in a different country or region some songs and their keys may not be available).
2. In Settings > Plugins > Apple Music, set **Wrapper Address**, and **Wrapper Key** if the wrapper is behind a gateway
   that checks one.
3. Set MyGo Music's quality to **Lossless**.

| You have                                                           | Run                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AMDL](https://github.com/AMDL-Web/apple-music-downloader) already | The wrapper AMDL runs (`amdl wrapper install`, or the desktop app's setup); its address is in AMDL's settings                                                                                                                |
| A Linux x86_64 computer or server                                  | [wrapper-manager](https://github.com/AMDL-Web/wrapper/tree/amdl/manager), natively or in Docker, on port 8080 by default                                                                                                     |
| macOS, Windows, Linux arm64, Synology…                             | wrapper-manager's [QEMU variant](https://github.com/AMDL-Web/wrapper/tree/amdl/manager#run-on-any-os-via-qemu-wrapper-manager-qemu), which needs hardware virtualization                                                     |
| Cloudflare                                                         | [Deploy it](https://github.com/AMDL-Web/wrapper/tree/amdl/cloudflare) to Cloudflare Containers (a Workers paid plan); put the `API_KEY` you set there in **Wrapper Key**. In mainland China, give the Worker your own domain |

- A wrapper-manager holds up to 10 accounts and picks the one for the song's country or region.
- Whoever reaches the wrapper's port can use your account: don't expose a wrapper to the internet without a key.
- The plugin's **Lossless Quality** setting chooses the level: **Hi-Res Lossless** (the default) plays each song at
  the best it has, up to 24-bit/192 kHz; **Lossless** keeps to 24-bit/48 kHz. From MyGo Music 0.1.23 it is a menu;
  before, a text field: leave it empty for Hi-Res Lossless, or type `lossless`.
- MyGo Music's audio output runs at 48 kHz: Hi-Res Lossless above that is brought down to 48 kHz on its way out (see
  [The output's sample rate](#limits)); the **Lossless** level is never brought down.

<a id="ringo"></a>

## Compared with Ringo

[Ringo](https://github.com/LYJW131/ringo) is another project by the same author: a standalone Apple Music client
forked from MyGo Music, with this plugin's Apple Music code rewritten in Go and built into it.

Both ask Apple for the same things. They differ in one way: the plugin can only hand MyGo Music data through its plugin
interface, while Ringo can change the app itself.

Each row below is one feature. ✅ is there, ❌ isn't, and "Partly" says what's short. The last column is why the
plugin lacks it, by the name of the entry under [What the plugin can't do](#limits).

**Playing and quality**

| Feature                                       | MyGo Music + this plugin                       | Ringo                                                  | Why the plugin lacks it  |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ | ------------------------ |
| 256 kbps AAC                                  | ✅                                             | ✅                                                     |                          |
| Lossless and Hi-Res Lossless (with a wrapper) | ✅ two levels, chosen in the plugin's settings | ✅ two levels                                          |                          |
| High Efficiency (HE-AAC, 64 kbps)             | ❌                                             | ✅                                                     | Audio formats            |
| Dolby Atmos for headphones or speakers        | ❌                                             | ✅                                                     | Audio formats            |
| Songs you uploaded                            | ✅                                             | ✅                                                     |                          |
| Even Out Loudness                             | ✅                                             | ✅                                                     |                          |
| The quality playing, in the player bar        | ❌                                             | ✅                                                     | Audio formats            |
| Output at the song's own sample rate          | ❌ everything is resampled to 48 kHz           | ✅ and on macOS the output device can be set to it too | The output's sample rate |
| Autoplay (similar songs once the queue ends)  | ❌                                             | ✅                                                     | Autoplay                 |

**Listening history** (with Use Listening History on)

| Feature                                      | MyGo Music + this plugin                  | Ringo                   | Why the plugin lacks it |
| -------------------------------------------- | ----------------------------------------- | ----------------------- | ----------------------- |
| A song starting                              | ✅                                        | ✅                      |                         |
| Pausing, resuming, seeking, ending, quitting | ❌ the song before is timed by the clock  | ✅ at the real position | Playback events         |
| The album or playlist a song plays from      | Partly: guessed from the page last opened | ✅                      | Playback events         |

**Pages**

| Feature                                                    | MyGo Music + this plugin | Ringo | Why the plugin lacks it    |
| ---------------------------------------------------------- | ------------------------ | ----- | -------------------------- |
| Home, charts, albums, artists, playlists, stations, search | ✅                       | ✅    |                            |
| Layouts such as 3:4 cards and large pictures               | ❌                       | ✅    | Layouts and motion artwork |
| Motion artwork                                             | ❌                       | ✅    | Layouts and motion artwork |
| An album's sections below it, record label pages           | ❌                       | ✅    | Layouts and motion artwork |

**Library**

| Feature                                                       | MyGo Music + this plugin        | Ringo | Why the plugin lacks it               |
| ------------------------------------------------------------- | ------------------------------- | ----- | ------------------------------------- |
| Favorite Songs, albums, playlists, recently added             | ✅                              | ✅    |                                       |
| Creating, renaming and deleting playlists                     | ✅                              | ✅    |                                       |
| Adding songs to a playlist, removing and reordering them      | ✅                              | ✅    |                                       |
| Adding albums and playlists to the library, and removing them | ✅                              | ✅    |                                       |
| Adding one song to the library                                | Partly: added as it's favorited | ✅    | What's in the library                 |
| Whether each song is in the library                           | ❌                              | ✅    | What's in the library                 |
| Sorting and finding albums and songs                          | ❌                              | ✅    | It hands over data, and draws nothing |

**Accounts, lyrics, interface**

| Feature                                                                 | MyGo Music + this plugin                                             | Ringo                                   | Why the plugin lacks it               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------- |
| Signing in on the web, with a token, or as an account the wrapper holds | ✅                                                                   | ✅                                      |                                       |
| Several accounts                                                        | Partly: one at a time, switched by an Apple ID typed in the settings | ✅ switched with a click                | Settings have no lists                |
| Lyrics word by word, translations                                       | ✅                                                                   | ✅                                      |                                       |
| Lyrics without any timing                                               | Partly: shown, but staying on the last line                          | ✅ readable from the top                | Lyrics                                |
| Interface and wording                                                   | MyGo Music's own                                                     | Laid out as Apple Music's, in its words | It hands over data, and draws nothing |

<a id="limits"></a>

### What the plugin can't do

MyGo Music is a player for many sources, and its plugin interface asks a source for songs, pages and audio. These aren't
things the plugin left out, but things the interface doesn't give it yet:

- **Playback events**: MyGo Music calls `played` once, as a song starts, with its ID only: it doesn't say when a song
  is paused, sought in, played out or quit, nor which album or playlist it's played from. The plugin times the song
  before by the clock, and takes the album or playlist page last opened that has the song as where it's played from;
  played afterwards from somewhere that doesn't say, such as a search or an artist's page, it's counted to that album
  or playlist.
- **Layouts and motion artwork**: a page's sections have no layout of their own, MyGo Music lays them out by what they
  hold; albums and playlists have no field for a video cover, and an album has nowhere for sections besides its songs.
- **What's in the library**: a song has no field saying whether it's in the library, and there's no call to add one
  song to it (only to save albums and playlists), so favoriting a song also adds it to the library.
- **Settings have no lists**: from MyGo Music 0.1.23 a setting can be a switch or a menu (the lossless levels are
  one), but a menu's choices are written into the plugin ahead of time: there is no list that could show the accounts
  a wrapper holds, so switching accounts still means typing an Apple ID.
- **Audio formats**: AAC is decoded as AAC-LC only, so Apple's High Efficiency (HE-AAC) can't play; there is no decoder for
  Dolby Atmos (EC-3); a stream has no
  sample rate or bit depth to say, and nowhere in the interface to show a quality.
- **Lyrics**: of lyrics without any timing, MyGo Music drops LRC lines without a time, and lines all at 0 stay on the
  last one.
- **Autoplay**: once the queue ends, the app asks the plugin for nothing more (only stations do), so there's no
  Autoplay.

Others come from what a plugin is:

- **It hands over data, and draws nothing**: how a page looks, where its buttons are and the words on them are MyGo
  Music's; the plugin only names what it hands over (from MyGo Music 0.1.24 that includes the titles of the Favorite Songs
  and Library Albums pages), not words like "Save" or "Like" on buttons and notices, and is asked for a page only as it's opened.
- **The output's sample rate**: the audio is played by MyGo Music's player, whose output runs at 48 kHz: every other
  rate is resampled to it, and a 96 kHz Hi-Res Lossless song reaches the device at 48 kHz. From MyGo Music 0.1.24 it is
  low-pass filtered before going down; 0.1.21 to 0.1.23 don't filter, and what it has above 24 kHz folds back into
  what is heard. The plugin only hands over audio and can't
  change that; Ringo changed the player, and plays each song at its own rate.
- **Where it runs**: in MyGo Music's JavaScript runtime, 30 seconds a call at most, in at most 256 MB, without Node's
  APIs. Decrypting songs and fetching the ones you uploaded is done in `amhelper`, which comes with the plugin.
- **The helper needs allowing**: `amhelper` is a program of its own, which you allow the plugin to start in its
  settings. On a platform it doesn't come for, such as Windows on arm64, songs play through ffmpeg, songs you uploaded
  don't play, loudness isn't evened out, and covers are kept through ffmpeg.

## Keeping up with MyGo Music

When MyGo Music releases, an automated check looks at what the release means for this plugin: Claude reads the
upstream changes, runs tests, and posts its verdict (nothing to do, optional, needed, or broken) on the
[tracking issue](https://github.com/LYJW131/mygo-music-apple-music/issues/2). It also looks for anything in
[What the plugin can't do](#limits) that the release's plugin interface now gives, and makes that feature, in a draft
pull request apart from any fix, with this list changed to match. What needs changing is followed up in a new plugin
release, which MyGo offers you as an update.

## Privacy

- The media-user-token is kept **unencrypted** in the plugin's data and only sent to Apple. Signing out forgets it on
  this machine only. One given in the settings is kept unencrypted in the plugin's settings too, and one from the
  wrapper, which `amhelper` fetches, in the plugin's data.
- With **Use Listening History** on (the default), the plugin tells Apple
  (`universal-activity-service.itunes.apple.com`) as each song starts which song it is, how long it is, how long the
  one before played and the album or playlist it's guessed to play from, as the web player at music.apple.com does.
- The wrapper key is kept in the plugin's settings and only sent to the wrapper address set. `amhelper` listens on this
  machine only, under a random path, and keeps the keys and songs it worked out in the plugin's data, and the last 20
  songs you uploaded that played.

## License

[AGPL-3.0](LICENSE). Lossless builds on [apple-music-downloader](https://github.com/AMDL-Web/apple-music-downloader),
[wrapper](https://github.com/WorldObservationLog/wrapper) and [Temari](https://github.com/WorldObservationLog/Temari).
For personal listening with an Apple Music subscription; not affiliated with Apple. It uses the music.apple.com web
player's API and may stop working when that changes.
