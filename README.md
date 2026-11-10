# Apple Music for MyGo Music

[![在 MyGo Music 中安装](docs/install-badge.svg)](https://lyjw131.github.io/mygo-music-apple-music/install.html)

在 [MyGo Music](https://github.com/egoist/mygo-music) 里搜索和播放，音质默认为 256 kbps AAC，可选至高 24-bit/192 kHz ALAC 高解析度无损支持（配置方法[见下文](#lossless)）。

[English](README.en.md)

## 安装和使用

1. 点上面的徽章，MyGo Music 会问是否安装；或者在「设置 → 插件 → `+`」里粘贴 `https://github.com/LYJW131/mygo-music-apple-music`。
2. 来源选择 **Apple Music**。
3. 点登录，使用有效订阅的 Apple 账户登录。账户用通行密钥或安全密钥登录的，见[下文](#media-user-token)。
4. 在「设置 → 插件 → Apple Music」里允许启动程序。插件自带的 `amhelper` 在本机解密歌曲，交给 MyGo Music 直接播放，不用另装 ffmpeg；只有 Windows arm64 这类没有 `amhelper` 的平台才要装 [ffmpeg](https://ffmpeg.org)。

<a id="media-user-token"></a>

### 用 media-user-token 登录

MyGo Music 的登录窗口不支持通行密钥，可以在自己的浏览器里登录，再把令牌交给插件：

1. 在已经登录的 [music.apple.com](https://music.apple.com) 打开开发者工具（F12），「Application / 存储 → Cookies → `https://music.apple.com`」里复制 `media-user-token` 的值。
2. 粘贴到「设置 → 插件 → Apple Music → **Media User Token**」。也可以直接粘贴整段 Cookie。

填好即登录，清空这一项即退出登录。令牌失效后（一般几个月）重新复制一个粘贴进去。

<a id="wrapper-account"></a>

### 用 wrapper 里的账户登录

已经在 [wrapper-manager](#lossless) 里登录了自己的账户，就不用在插件里再登录一次，在 **Wrapper 账户** 里填这个账户的 Apple ID。插件通过 `amhelper` 向 wrapper 要这个账户的 media-user-token，wrapper 自己定期刷新令牌。需要 [AMDL-Web](https://github.com/AMDL-Web) 的 [wrapper](https://github.com/AMDL-Web/wrapper)。

- **多个账户**：填自己的 Apple ID 即可指定用哪一个，也可以填国家或地区代码（如 `jp`），用 wrapper 里该地区第一个可用的账户。
- 同时填了 **Media User Token** 时以它为准。清空 **Wrapper 账户** 即退出登录。

## 功能

- 首页推荐、最近播放、电台、资料库专辑、资料库歌单、最近添加。
- 把歌曲添加到个人收藏。
- 添加内容到资料库、从资料库中移除。
- 新建、重命名、删除歌单，在歌单中添加、移除曲目和调整顺序。
- 播放你上传到资料库的歌曲（需要 `amhelper`）。
- 完整歌词支持，有逐字时间的按字显示，显示翻译。账户显示你的 Apple Music 名称和头像。
- 可选的无损支持，未设置或获取失败时自动回退到 AAC
- 打开 MyGo Music「设置 → 播放 → 音量均衡」后，按 Apple 测得的响度让每首歌一样响。
- 在 MyGo Music 里播放的歌曲会像在 Apple 自己的 App 里一样计入收听历史记录，从专辑或歌单页播放的会出现在「最近播放」里，可在插件设置的「使用收听历史记录」里填 `off` 关闭。

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

<a id="ringo"></a>

## 与 Ringo 对照

Ringo 是同一作者的另一个项目：把这个插件的 Apple Music 代码移植成 Go，编进一个从 MyGo Music 分支出来的独立 Apple Music 客户端，目前没有公开。两者向 Apple 要的东西一样，区别在于插件只能通过 MyGo Music 的插件接口交出数据，Ringo 可以改应用本身。

| 方面     | MyGo Music + 本插件                                                                                                      | Ringo                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 播放     | 256 kbps AAC；配 wrapper 播放无损和高解析度无损；播放你上传的歌曲                                                        | 同左，另有自动播放（队列放完后接着播相似的歌曲）                                               |
| 音质     | 只有一档「无损」，有 ALAC 就取最高的；没有高效（HE-AAC）和杜比全景声                                                     | 高效、高质量、无损、高解析度无损分档；杜比全景声的耳机版和扬声器版；播放栏显示音质             |
| 音量均衡 | 有：按 Apple 测得的每首歌的响度，打开 MyGo Music 的「音量均衡」后统一到约 -16 LKFS                                       | 有                                                                                             |
| 播放上报 | 歌曲开始时上报，字段和网页版一致；来自哪个专辑或歌单按最近打开的页面推测；暂停、拖动、播完不上报，上一首的时长按时钟估算 | 开始、暂停、继续、拖动、播完、退出都按实际位置上报，带准确的来源                               |
| 页面     | 首页、排行榜、专辑、艺人、歌单、电台、搜索，版式由 MyGo Music 按内容类型决定                                             | 另有 3:4 竖卡片和大图版式、动态封面、专辑页的推荐区块、唱片公司页、资料库里的艺人页            |
| 资料库   | 个人收藏、专辑、歌单、最近添加；新建、重命名、删除歌单，添加、移除、调整曲目顺序；添加到资料库或从中移除                 | 同左，另有每首歌是否在资料库、先添加到资料库再喜爱，专辑和歌曲的排序与查找                     |
| 账户     | 一次一个账户；可以用 wrapper 里的账户，在设置里填 Apple ID 切换                                                          | 多个账户，点选切换，wrapper 里的账户自动列出                                                   |
| 歌词     | 逐字歌词和翻译                                                                                                           | 同左，另外整篇没有时间轴的歌词可以从头阅读                                                     |
| 界面     | MyGo Music 自己的界面                                                                                                    | 侧栏、设置、专辑页和艺人页按 Apple Music 重排，文案用 Apple Music 的词，手势和滚动条也照它调整 |

### 插件方案的限制

MyGo Music 是支持多种音源的通用播放器，插件接口只要求音源交出歌曲、页面和音频。下面这些不是插件没做，而是这个接口目前没有给：

- **播放事件**：MyGo Music 只在一首歌开始时调用一次 `played`，只给歌曲 ID，不告诉暂停、拖动、播完和退出，也不告诉是从哪个专辑或歌单播放的。插件按时钟估算上一首播了多久，并把最近打开的、含有这首歌的专辑或歌单页当作来源；之后又从搜索、艺人页这类不说来源的地方播放时，会记到之前那张专辑或那个歌单名下。
- **版式和动态封面**：页面区块没有版式字段，由 MyGo Music 按内容类型决定怎么排；专辑、歌单没有视频封面字段。
- **资料库状态**：歌曲没有「是否在资料库」字段，也没有把单曲添加到资料库的接口（只有收藏专辑和歌单），所以插件把喜爱一首歌做成同时添加到资料库。
- **设置只有文本框**：没有开关、下拉菜单和列表，音质分档、杜比全景声、多个账户这类选择只能让你手填文字，插件就没有做。
- **音频格式**：AAC 只能解码 AAC-LC，Apple 的高效档（HE-AAC）放不了；流没有采样率、位深字段，界面上也没有显示音质的位置。
- **歌词**：整篇没有时间轴的歌词，MyGo Music 会把不带时间的 LRC 行丢掉，按每行 0 秒给又会停在最后一行。
- **自动播放**：队列放完后不会向插件要歌（只有电台会），所以没有自动播放。

另一些来自插件这种架构本身：

- **只交数据，不画界面**：页面长什么样、按钮放在哪、界面上的文字，都由 MyGo Music 决定，插件只能改自己交出去的标题；页面也只在你点开时才向插件要。
- **运行环境**：插件跑在 MyGo Music 的 JavaScript 运行时里，每次调用最多 30 秒，内存上限 256 MB，没有 Node 接口。解密和下载你上传的歌曲这类工作放在随插件附带的 `amhelper` 里。
- **helper 要授权**：`amhelper` 是一个独立程序，要你在设置里允许插件启动程序。没有 `amhelper` 的平台（如 Windows arm64）改用 ffmpeg，那里播放不了你上传的歌曲，没有音量均衡，封面也要靠 ffmpeg 保存。

## 跟随 MyGo Music 更新

MyGo Music 发新版本后，会有一个自动化流程检查这个版本是否影响插件：Claude 阅读上游改动、实际运行测试，然后在[跟踪 issue](https://github.com/LYJW131/mygo-music-apple-music/issues/2) 里写下结论（无需更新、可选更新、需要更新或已失效）。需要改的会尽快跟进并发布插件新版本，MyGo 会提示你更新。

## 隐私

- media-user-token 以**明文形式**保存在个插件数据目录里，只发给 Apple，退出登录只删本机。在设置里填写的令牌也以明文保存在插件设置里。用 wrapper 里的账户登录时，令牌由 `amhelper` 从 wrapper 取来，同样保存在插件数据目录里。
- 开启「使用收听历史记录」时（默认开启），每首歌开始播放时，插件把歌曲 ID、时长、播放了多久和推测的来源专辑或歌单发给 Apple（`universal-activity-service.itunes.apple.com`），和 Apple Music 网页版上报的一样。
- Wrapper 密钥保存在插件设置里，只发给设置的 wrapper 地址。`amhelper` 只监听本机，要带随机路径才能访问；它在插件数据目录里缓存解密密钥和歌曲信息，以及最近播放的 20 首你上传的歌曲。

## 许可证

[AGPL-3.0](LICENSE)，无损部分实现基于 [apple-music-downloader](https://github.com/AMDL-Web/apple-music-downloader)、[wrapper](https://github.com/WorldObservationLog/wrapper) 和 [Temari](https://github.com/WorldObservationLog/Temari)。仅供有 Apple Music 订阅的个人收听，与 Apple 无关；使用 music.apple.com 网页播放器接口，Apple 改接口时可能失效。
