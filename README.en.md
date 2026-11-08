# Apple Music for MyGo Music

Search and play Apple Music in [MyGo Music](https://github.com/egoist/mygo-music), as 256 kbps AAC, and optionally as
Hi-Res Lossless ALAC up to 24-bit/192 kHz (set up [below](#lossless)).

[中文](README.md)

## Install and use

1. Open MyGo Music, and paste `https://github.com/LYJW131/mygo-music-apple-music` in Settings > Plugins > `+`.
2. Choose **Apple Music** as the source.
3. Sign in with an Apple account that has a subscription. For an account that signs in with a passkey or security key,
   see [below](#media-user-token).
4. Allow Apple Music to start programs in Settings > Plugins > Apple Music. The plugin's own `amhelper` decrypts songs
   on this machine and MyGo Music plays them itself, with nothing else to install; only on a platform it doesn't come
   for, such as Windows on arm64, does it play through [ffmpeg](https://ffmpeg.org), which you install.

<a id="media-user-token"></a>

### Signing in with a media-user-token

MyGo Music's sign-in window can't use passkeys or security keys such as a YubiKey. With an account that signs in with
one, sign in in your own browser and give the plugin its token:

1. Open [music.apple.com](https://music.apple.com) in a desktop browser and sign in.
2. In its developer tools (F12), under Application (Storage) > Cookies > `https://music.apple.com`, copy the value of
   `media-user-token`.
3. Paste it in Settings > Plugins > Apple Music > **Media User Token**. The whole cookie header works too: the plugin
   takes `media-user-token` out of it.

That signs you in. Signing in again then uses it without the window; emptying it signs you out. When the token runs out
(usually after some months), copy and paste a new one.

## Features

- Home recommendations, recently played, stations, library albums, library playlists, recently added.
- Adding songs to Favorite Songs.
- Adding to the library and removing from it.
- Creating playlists and adding songs to them.
- Full lyrics, word by word where Apple has them, with translations. The account shows your Apple Music name and
  picture.
- Optional lossless, falling back to AAC when it isn't set up or a song can't be had.
- Songs played in MyGo Music count toward your listening history (Recently Played, Replay, recommendations) as in
  Apple's own apps; type `off` in the plugin's **Use Listening History** setting to stop it.

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

## Keeping up with MyGo Music

When MyGo Music releases, an automated check looks at what the release means for this plugin: Claude reads the
upstream changes, runs tests, and posts its verdict (nothing to do, optional, needed, or broken) on the
[tracking issue](https://github.com/LYJW131/mygo-music-apple-music/issues/2). What needs changing is followed up in a
new plugin release, which MyGo offers you as an update.

## Privacy

- The media-user-token is kept **unencrypted** in the plugin's data and only sent to Apple. Signing out forgets it on
  this machine only. One given in the settings is kept unencrypted in the plugin's settings too.
- With **Use Listening History** on (the default), the plugin tells Apple
  (`universal-activity-service.itunes.apple.com`) as each song starts which song it is, how long it is and how long
  the one before played, as the web player at music.apple.com does.
- The wrapper key is kept in the plugin's settings and only sent to the wrapper address set. `amhelper` listens on this
  machine only, under a random path, and keeps the keys and songs it worked out in the plugin's data.

## License

[AGPL-3.0](LICENSE). Lossless builds on [apple-music-downloader](https://github.com/AMDL-Web/apple-music-downloader),
[wrapper](https://github.com/WorldObservationLog/wrapper) and [Temari](https://github.com/WorldObservationLog/Temari).
For personal listening with an Apple Music subscription; not affiliated with Apple. It uses the music.apple.com web
player's API and may stop working when that changes.
