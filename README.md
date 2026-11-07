# Apple Music for MyGo Music

在 [MyGo Music](https://github.com/egoist/mygo-music) 里听 Apple Music：完整歌曲（不是 30 秒试听），256 kbps AAC。仅供有 Apple Music 订阅的个人收听，与 Apple 无关；用的是 music.apple.com 网页播放器的接口，Apple 改接口时可能失效。

[English](#english)

## 安装

1. 点 [mygo-music://install-plugin?repo=LYJW131/mygo-music-apple-music](mygo-music://install-plugin?repo=LYJW131/mygo-music-apple-music)，或在「设置 → 插件 → +」里粘贴 `https://github.com/LYJW131/mygo-music-apple-music`。
2. 安装 [ffmpeg](https://ffmpeg.org)，并在「设置 → 插件」里允许 Apple Music 启动程序。它只会启动 ffmpeg，位置限定为 PATH、`/opt/homebrew/bin` 或 `/usr/local/bin`。

   ```bash
   brew install ffmpeg            # macOS
   winget install Gyan.FFmpeg     # Windows（装完重启 MyGo Music）
   sudo pacman -S ffmpeg          # Arch；其他发行版用各自的包管理器
   ```

3. 登录：点登录会打开 music.apple.com，在上面登录 Apple ID。

需要 MyGo Music 0.1.21 及以上。

## 能做什么

- **不登录**：搜索歌曲、专辑、艺人和歌单，搜索联想，粘贴 music.apple.com 链接，专辑、艺人、歌单页，排行榜。未登录时按美国（us）的曲库浏览。
- **登录后**：播放完整歌曲；首页推荐和最近播放；资料库歌曲、资料库专辑、资料库歌单、最近添加；把歌曲添加到个人收藏（同时添加到资料库）；把专辑和歌单添加到资料库或从资料库中删除；新建歌单、往自己的歌单里加歌；你的电台和最近播放的电台；歌词，有逐字时间的按字显示，有你语言的翻译时一并显示。

## 播放是怎么做的

Apple 网页播放器播放的 AAC 用 Widevine 加密。插件像网页播放器一样向 Apple 的许可证服务器要这首歌的密钥：许可证请求由插件里用 TypeScript 写的 Widevine CDM 生成和解析（不依赖任何原生库），设备是 [apple-music-downloader](https://github.com/LYJW131/apple-music-downloader) 附带的 L3 测试设备。然后 ffmpeg 一边从 Apple 下载一边去掉加密，把音频原样复制（不重新编码）成分片 MP4，在本机交给 MyGo 边下边播。不需要 wrapper，也不播放无损 ALAC 和杜比全景声。

每首歌的音频地址和密钥都不会变，第一次播放后就记下来（最多 3000 首，只占几百 KB）：

- 播过的歌，包括重启之后，约 0.2 秒出声，不再问 Apple；
- 打开专辑、歌单、艺人页或搜索歌曲时，前 3 首会先准备好，点下去也是约 0.2–0.4 秒；为了不让账户像机器一样狂要许可证，每分钟最多准备 15 首，一次一首；
- 其他没准备过的新歌约 1.2–1.5 秒，大部分是在等 Apple 的 webPlayback（约 0.3 秒）和许可证服务器（约 0.6 秒）；
- 按顺序播放时，MyGo 会在当前这首播放时提前取下一首，切歌没有等待。

## 隐私

media-user-token 以明文保存在本机这个插件的数据目录里，只发给 Apple。退出登录只会删掉本机保存的这份。

## 许可证

AGPL-3.0，与 MyGo Music 相同，见 [LICENSE](LICENSE)。

## 开发

源码是 `src/` 下的 TypeScript，用 esbuild 打包成一个不依赖其他文件的 `index.js`（MyGo Music 只加载一个文件），放在 `dist/plugin`。需要 Node 22.18+。

```bash
npm install
npm run build             # 打包到 dist/plugin；把这个文件夹复制进 MyGo 的插件目录就能试
npm test                  # 打包，然后测试：Widevine 用到的密码学（对照 Node 自带的实现）、歌词和链接解析、打包结果能否像 MyGo 那样加载
npm run check             # 类型检查、格式检查、测试、打成发布用的 zip；CI 跑的就是这个
npm run test:live         # 不登录，用真实接口测搜索、专辑、艺人、歌单和排行榜
APPLE_MUSIC_TOKEN_FILE=path/to/token npm run test:signed-in   # 登录后：账户、播放（解密并完整解码一遍）、歌词、资料库、电台
```

发布：改 `plugin.json` 里的 `version`，推到 `main`，再给这个提交打 `v<版本号>` 的 tag 并推上去。**Release** workflow 会检查 tag 和版本号一致、提交在 `main` 上，跑完检查后发布带 zip 的 release。MyGo Music 安装的是最新 release 里的 zip。

---

## English

Apple Music in [MyGo Music](https://github.com/egoist/mygo-music): whole songs (not 30-second previews) as 256 kbps AAC. For personal listening with an Apple Music subscription; not affiliated with Apple. It uses the music.apple.com web player's API and may stop working when that changes.

**Install** with [mygo-music://install-plugin?repo=LYJW131/mygo-music-apple-music](mygo-music://install-plugin?repo=LYJW131/mygo-music-apple-music) (MyGo Music 0.1.21 or later). Install [ffmpeg](https://ffmpeg.org) and allow Apple Music to start programs in Settings > Plugins: it only starts ffmpeg. Sign in on music.apple.com in the window the app shows.

**Signed out**: search songs, albums, artists and playlists, suggestions, pasted music.apple.com links, album, artist and playlist pages, and charts, from the US catalog.

**Signed in**: whole songs; recommendations and recently played on Home; library songs, albums and playlists, recently added; favoriting songs (which adds them to the library); adding albums and playlists to the library and removing them; creating playlists and adding songs to your own; your station and recent stations; lyrics, word by word where Apple has them, with a translation into your language when there is one.

**How it plays**: the web player's AAC is encrypted with Widevine. The plugin asks Apple's license server for the song's key as the web player does, with a Widevine CDM written in TypeScript inside the plugin, with no native code (the device is the L3 test device that apple-music-downloader ships). ffmpeg then takes the encryption off as the audio comes in from Apple and hands it to the app on this machine as ADTS, copied as it is, not re-encoded, which plays as it arrives. No wrapper; no ALAC or Dolby Atmos. A song's audio and key never change, so they're kept once it has played: a song played before (even after a restart) starts in about 0.2 seconds. The first 3 songs of an album, playlist, artist or song search you open are made ready the same way before you pick one, at most 15 a minute, one at a time. Other new songs take about 1.2–1.5 seconds, most of it Apple's servers answering. The app fetches the next song in the queue while the current one plays.

**Privacy**: the media-user-token is kept unencrypted in the plugin's data on this machine and is only sent to Apple. Signing out forgets it here.

## License

AGPL-3.0, the same as MyGo Music. See [LICENSE](LICENSE).
