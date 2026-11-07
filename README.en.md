# Apple Music for MyGo Music

[中文](README.md)

Apple Music in [MyGo Music](https://github.com/egoist/mygo-music): whole songs (not 30-second previews) as 256 kbps AAC, and, with a wrapper, Lossless and Hi-Res Lossless (ALAC up to 24-bit/192 kHz). For personal listening with an Apple Music subscription; not affiliated with Apple. It uses the music.apple.com web player's API and may stop working when that changes.

**Install** with [mygo-music://install-plugin?repo=LYJW131/mygo-music-apple-music](mygo-music://install-plugin?repo=LYJW131/mygo-music-apple-music) (MyGo Music 0.1.21 or later). Install [ffmpeg](https://ffmpeg.org) and allow Apple Music to start programs in Settings > Plugins: it starts only ffmpeg and its own `amhelper`, for lossless. Sign in on music.apple.com in the window the app shows.

**Signed out**: search songs, albums, artists and playlists, suggestions, pasted music.apple.com links, album, artist and playlist pages, and charts, from the US catalog.

**Signed in**: whole songs; recommendations and recently played on Home; library songs, albums and playlists, recently added; favoriting songs (which adds them to the library); adding albums and playlists to the library and removing them; creating playlists and adding songs to your own; your station and recent stations; lyrics, word by word where Apple has them, with a translation into your language when there is one. The account shows your Apple Music name and picture.

A song played before, or one of the first few of a page you open, starts in about 0.2 seconds; other new songs in 1–2 seconds. The next song in the queue is fetched while the current one plays.

<a id="lossless"></a>

## Lossless

Apple's lossless audio (ALAC) needs a **wrapper**: a service signed in to your Apple Music account that asks Apple for the keys on the plugin's behalf. The plugin's own `amhelper` then decrypts the song on this machine as it downloads and hands it to MyGo.

1. Run a wrapper-manager (see below) and sign in to your Apple Music account in it.
2. In Settings > Plugins > Apple Music, set **Wrapper Address**, such as `http://127.0.0.1:8080`, and **Wrapper Key** if the wrapper is behind a gateway that checks one.
3. Set MyGo Music's quality to **Lossless**.

| You have                                                          | Run                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AMDL](https://github.com/LYJW131/apple-music-downloader) already | The wrapper AMDL runs (`amdl wrapper install`, or the desktop app's setup); its address is in AMDL's settings                                                                                                                                 |
| A Linux x86_64 computer or server                                 | [wrapper-manager](https://github.com/AMDL-Web/wrapper/tree/amdl/manager), natively or in Docker, on port 8080 by default                                                                                                                      |
| macOS, Windows, Linux arm64, Synology…                            | wrapper-manager's [QEMU variant](https://github.com/AMDL-Web/wrapper/tree/amdl/manager#run-on-any-os-via-qemu-wrapper-manager-qemu), which needs hardware virtualization                                                                      |
| Another machine or the cloud                                      | Put it behind a gateway that checks a key (a Cloudflare Worker or a reverse proxy); see [AMDL's deployment notes](https://github.com/LYJW131/apple-music-downloader/blob/main/docs/deployment.md#the-wrapper). Set the same key in the plugin |

- A wrapper-manager holds up to 10 accounts and picks the one for the song's country or region.
- A song plays at its best: Hi-Res (such as 24-bit/96 kHz) when it has it, else 16 or 24-bit at 44.1–48 kHz, else AAC. With the wrapper unreachable, songs play as AAC rather than not at all.
- A new song takes 1–2 seconds the first time, mostly the wrapper. The wrapper answers one request at a time, and the song you pick goes before the ones made ready ahead. Songs played before start at once, even after a restart.
- `amhelper` is built for macOS (Apple silicon and Intel), Linux (x86_64 and arm64) and Windows (x86_64); MyGo installs the one for your computer.

**Careful**: whoever reaches the wrapper's port can use your account and read its token. Don't expose a wrapper to the internet without a key.

## Privacy

The media-user-token is kept unencrypted in the plugin's data on this machine and is only sent to Apple. Signing out forgets it here. The wrapper key is kept in the plugin's settings and only sent to your wrapper. `amhelper` listens on this machine only (127.0.0.1), under a random path, and keeps the keys and songs it worked out in the plugin's data.

## License

AGPL-3.0, the same as MyGo Music. See [LICENSE](LICENSE). The decryption comes from [apple-music-downloader](https://github.com/LYJW131/apple-music-downloader).
