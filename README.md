# Apple Music for MyGo Music

在 [MyGo Music](https://github.com/egoist/mygo-music) 里搜索和播放，音质默认为 256 kbps AAC，可选至高 24-bit/192 kHz ALAC 高解析度无损支持（配置方法[见下文](#lossless)）。

[English](README.en.md)

## 安装和使用

1. 打开 MyGo Music，在「设置 → 插件 → `+`」里粘贴 `https://github.com/LYJW131/mygo-music-apple-music`。
2. 来源选择 **Apple Music**。
3. 点登录，使用有效订阅的 Apple 账户登录。
4. 在「设置 → 插件 → Apple Music」里允许启动程序。插件自带的 `amhelper` 在本机解密歌曲，交给 MyGo Music 直接播放，不用另装 ffmpeg；只有 Windows arm64 这类没有 `amhelper` 的平台才要装 [ffmpeg](https://ffmpeg.org)。

## 功能

- 首页推荐、最近播放、电台、资料库专辑、资料库歌单、最近添加。
- 把歌曲添加到个人收藏。
- 添加内容到资料库、从资料库中移除。
- 新建歌单、在歌单中添加曲目。
- 完整歌词支持，有逐字时间的按字显示，显示翻译。账户显示你的 Apple Music 名称和头像。
- 可选的无损支持，未设置或获取失败时自动回退到 AAC
- 在 MyGo Music 里播放的歌曲会像在 Apple 自己的 App 里一样计入收听历史记录（最近播放、Replay、推荐）；在插件设置的「使用收听历史记录」里填 `off` 关闭。

<a id="lossless"></a>

## 播放无损/高解析度无损音频

### 原理

需要一个 `wrapper`，登录可用订阅账户。插件自带的 `amhelper` 拿到密钥模板后，在本机边下载边解密，交给 MyGo Music 播放。

### 设置

1. 部署一个 wrapper-manager（见下表）并登录你的 Apple Music 账户（不一定要与应用中的账户一致，但地区不同时有可能无法获取对应音轨流和密钥）。
2. 在「设置 → 插件 → Apple Music」里填 **Wrapper 地址**，wrapper 放在要密钥的网关后面时再填 **Wrapper 密钥**。
3. 把 MyGo Music 的音质设为**无损**。

| 你的情况                                                            | 怎么部署                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已经在用 [AMDL](https://github.com/AMDL-Web/apple-music-downloader) | 直接用 AMDL 运行的 wrapper（`amdl wrapper install` 或桌面版设置引导装的那个），地址在 AMDL 的设置里                                                                                                       |
| Linux x86_64 电脑或服务器                                           | [wrapper-manager](https://github.com/AMDL-Web/wrapper/tree/amdl/manager) 原生运行或用 Docker，默认端口 8080                                                                                               |
| macOS、Windows、Linux arm64、群晖等                                 | wrapper-manager 的 [QEMU 版本](https://github.com/AMDL-Web/wrapper/tree/amdl/manager#run-on-any-os-via-qemu-wrapper-manager-qemu)，需要硬件虚拟化                                                         |
| 部署在 Cloudflare                                                   | [一键部署](https://github.com/AMDL-Web/wrapper/tree/amdl/cloudflare)到 Cloudflare Containers（需要 Workers 付费计划），部署时设置的 `API_KEY` 填进 **Wrapper 密钥**；中国大陆需要给 Worker 绑定自己的域名 |

- 一个 wrapper-manager 最多登录 10 个账户，按歌曲所在的国家或地区选账户。
- 能访问 wrapper 端口的人都能使用你的账户，不要把没有密钥保护的 wrapper 暴露到公网。

## 跟随 MyGo Music 更新

MyGo Music 发新版本后，会有一个自动化流程检查这个版本是否影响插件：Claude 阅读上游改动、实际运行测试，然后在[跟踪 issue](https://github.com/LYJW131/mygo-music-apple-music/issues/2) 里写下结论（无需更新、可选更新、需要更新或已失效）。需要改的会尽快跟进并发布插件新版本，MyGo 会提示你更新。

## 隐私

- media-user-token 以**明文形式**保存在个插件数据目录里，只发给 Apple，退出登录只删本机。
- 开启「使用收听历史记录」时（默认开启），每首歌开始播放时，插件把歌曲 ID、时长和播放了多久发给 Apple（`universal-activity-service.itunes.apple.com`），和 Apple Music 网页版上报的一样。
- Wrapper 密钥保存在插件设置里，只发给设置的 wrapper 地址。`amhelper` 只监听本机，要带随机路径才能访问；它在插件数据目录里缓存解密密钥和歌曲信息。

## 许可证

[AGPL-3.0](LICENSE)，无损部分实现基于 [apple-music-downloader](https://github.com/AMDL-Web/apple-music-downloader)、[wrapper](https://github.com/WorldObservationLog/wrapper) 和 [Temari](https://github.com/WorldObservationLog/Temari)。仅供有 Apple Music 订阅的个人收听，与 Apple 无关；使用 music.apple.com 网页播放器接口，Apple 改接口时可能失效。
