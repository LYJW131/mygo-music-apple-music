# Apple Music for MyGo Music

在 [MyGo Music](https://github.com/egoist/mygo-music) 里听 Apple Music：完整歌曲（不是 30 秒试听），256 kbps AAC；有 wrapper 时还能听无损和高解析度无损（最高 24 位/192 kHz ALAC）。仅供有 Apple Music 订阅的个人收听，与 Apple 无关；用的是 music.apple.com 网页播放器的接口，Apple 改接口时可能失效。

[English](README.en.md)

## 安装

1. 点 [mygo-music://install-plugin?repo=LYJW131/mygo-music-apple-music](mygo-music://install-plugin?repo=LYJW131/mygo-music-apple-music)，或在「设置 → 插件 → +」里粘贴 `https://github.com/LYJW131/mygo-music-apple-music`。
2. 安装 [ffmpeg](https://ffmpeg.org)，并在「设置 → 插件」里允许 Apple Music 启动程序。它只会启动 ffmpeg（位置限定为 PATH、`/opt/homebrew/bin` 或 `/usr/local/bin`）和插件自带的 `amhelper`（用于无损）。

   ```bash
   brew install ffmpeg            # macOS
   winget install Gyan.FFmpeg     # Windows（装完重启 MyGo Music）
   sudo pacman -S ffmpeg          # Arch；其他发行版用各自的包管理器
   ```

3. 登录：点登录会打开 music.apple.com，在上面登录 Apple ID。

需要 MyGo Music 0.1.21 及以上。

## 能做什么

- **不登录**：搜索歌曲、专辑、艺人和歌单，搜索联想，粘贴 music.apple.com 链接，专辑、艺人、歌单页，排行榜。未登录时按美国（us）的曲库浏览。
- **登录后**：播放完整歌曲；首页推荐和最近播放；资料库歌曲、资料库专辑、资料库歌单、最近添加；把歌曲添加到个人收藏（同时添加到资料库）；把专辑和歌单添加到资料库或从资料库中删除；新建歌单、往自己的歌单里加歌；你的电台和最近播放的电台；歌词，有逐字时间的按字显示，有你语言的翻译时一并显示。账户显示你的 Apple Music 名称和头像。
- **无损**：见下一节。

播过的歌和打开页面时先准备好的前几首，点下去约 0.2 秒出声；没准备过的新歌约 1–2 秒。按顺序播放时会提前取下一首，切歌没有等待。

<a id="lossless"></a>

## 无损

Apple 的无损音频（ALAC）需要一个 **wrapper**：一个登录了你 Apple Music 账户、替插件向 Apple 要解密密钥的服务。插件自带的 `amhelper` 拿到密钥后，在本机一边下载一边解密，交给 MyGo 播放。

1. 部署一个 wrapper-manager（见下表），在里面登录你的 Apple Music 账户。
2. 在「设置 → 插件 → Apple Music」里填 **Wrapper 地址**，例如 `http://127.0.0.1:8080`；wrapper 放在要密钥的网关后面时再填 **Wrapper 密钥**。
3. 把 MyGo Music 的音质设为**无损**。

| 你的情况                                                           | 怎么部署                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已经在用 [AMDL](https://github.com/LYJW131/apple-music-downloader) | 直接用 AMDL 运行的 wrapper（`amdl wrapper install` 或桌面版设置引导装的那个），地址在 AMDL 的设置里                                                                                            |
| Linux x86_64 电脑或服务器                                          | [wrapper-manager](https://github.com/AMDL-Web/wrapper/tree/amdl/manager) 原生运行或用 Docker，默认端口 8080                                                                                    |
| macOS、Windows、Linux arm64、群晖等                                | wrapper-manager 的 [QEMU 版本](https://github.com/AMDL-Web/wrapper/tree/amdl/manager#run-on-any-os-via-qemu-wrapper-manager-qemu)，需要硬件虚拟化                                              |
| 放在别的机器或云上                                                 | 前面套一个检查密钥的网关（Cloudflare Worker 或反向代理），见 [AMDL 的部署说明](https://github.com/LYJW131/apple-music-downloader/blob/main/docs/deployment.md#the-wrapper)；插件里填同一个密钥 |

- 一个 wrapper-manager 最多登录 10 个账户，按歌曲所在的国家或地区选账户。
- 歌曲有高解析度无损时播放最高规格（如 24 位/96 kHz），只有无损时播放 16 或 24 位/44.1–48 kHz，没有无损时播放 AAC。wrapper 连不上时也会改播 AAC，不会没声音。
- 新歌第一次播放约 1–2 秒，大部分在等 wrapper；wrapper 一次只处理一个请求，你点的歌会排在预先准备的歌前面。播过的歌重启后也能立即播放。
- `amhelper` 提供 macOS（Apple 芯片和 Intel）、Linux（x86_64 和 arm64）和 Windows（x86_64）版本，MyGo 会自动安装对应的那个。

**注意**：能访问 wrapper 端口的人都能用你的账户，并读到账户的令牌。不要把没有密钥保护的 wrapper 暴露到公网。

## 隐私

- media-user-token 以明文保存在本机这个插件的数据目录里，只发给 Apple。退出登录只会删掉本机保存的这份。
- Wrapper 密钥保存在插件设置里，只发给你填的 wrapper。`amhelper` 只监听本机（127.0.0.1），并且要带随机路径才能访问；它在插件数据目录里缓存解密密钥和歌曲信息。

## 许可证

AGPL-3.0，与 MyGo Music 相同，见 [LICENSE](LICENSE)。解密代码来自 [apple-music-downloader](https://github.com/LYJW131/apple-music-downloader)。
