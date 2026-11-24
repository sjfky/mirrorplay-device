# 投影线路格式（projection wire format）

这份文件描述 mirrorplay 实际实现的协议。字段、取值和消息名对着 [OpenXPlay-Stream](https://github.com/OpenXPlay/OpenXPlay-Stream) 公开的源码整理，
实现是独立写的（AGPL-3.0-only，见 NOTICE）。

## 一条 WebSocket，两种帧

- 文本帧 = JSON 控制消息
- 二进制帧 = 24 字节头 + 载荷

同一个 socket 上双向都这样。车机浏览器（receiver）和设备端（input）连的是同一条协议，只是允许的消息集合不同。

## 二进制头（小端）

| 偏移 | 长度 | 字段 | 含义 |
|---|---|---|---|
| 0 | 1 | kind | 1=video, 2=audio, 3=microphone, 16=touch, 17=key |
| 1 | 1 | stream | 音/麦克风流编号；video、touch、key 固定 0 |
| 2 | 1 | flags | bit0 = 关键帧，bit1 = gap（不连续，接收端必须先 flush 再从这一帧重新开始） |
| 3 | 1 | reserved | 必须为 0 |
| 4 | 4 | sequence | 每种 kind 独立递增，回绕到 0 |
| 8 | 8 | ptsUs | 显示时间戳，微秒。中继已经把源的 pts 平移到自己那条时钟线上 |
| 16 | 8 | senderClockUs | 中继自己的 epoch 微秒时钟，用来量"偏离实况多久" |

### 载荷

- **video**：AVCC。每 NAL 前面 4 字节大端长度；一个 access unit 一帧，参数集（SPS/PPS）可以带在带内。
  中继对进来的流统一规范化成 AVCC：浏览器编码器只会写 Annex B，设备页在本地做一次
  `annexBToAvcc`，所以线上只有一种容器格式。
- **audio**：一帧原始 AAC（无 ADTS 头），编解码参数由 `audio-format` 消息给出。
- **touch**：`count(u8)` + 每触点 6 字节 = `id(u8)`、`pressed(u8: 0/1)`、`x(u16)`、`y(u16)`，
  坐标是"画面坐标"（去掉黑边后按视频宽高归一化），量化到 65535，最多 10 个触点。
- **key**：3 字节 = `code(u16 小端)`、`down(u8)`；code 0=Home 1=Back 2=Select 3-6=旋钮方向 7=PlayPause 8=Next 9=Previous 10=Voice。

## JSON 控制消息

方向：`client-to-relay`（车机→中继）、`relay-to-client`（中继→车机）、`device-to-relay`、`relay-to-device`。

| 消息 | 方向 | 作用 |
|---|---|---|
| `hello` | 车机/设备 → 中继 | 报告可解的 `decoders`（codec string + 是否硬解）、`displays`（宽高/dpr/刷新率/安全区）、`maxTouchContacts`、`audio`、`microphone`。重复 hello = 同一个接收端要重新同步 |
| `welcome` | 中继 → 车机 | `clientId`、`session`、`relay{name,version}`、`sourceUrl`（协议出处）、`attribution`、`projectUrl`、`features` |
| `session` | 中继 → 车机 | `{id, phase, reason}`；phase ∈ CONNECTING/ACTIVE/RECONNECTING/ENDED，reason 用 `startup/connecting`、`startup/waiting-media`、`startup/disconnected` 等 |
| `video-format` | 双向 | `{screen, format}`；format = `{codec, codecString, config(base64 avcC), width, height, fpsHint}`。设备用它宣告，中继在收到第一个 IDR 后转发给接收端 |
| `audio-format` | 双向 | `{stream, format}`；format = `{role, codec, sampleRate, channels, config}` |
| `view-area` | 中继 → 车机 | 这一屏应该画在哪：`{x, y, width, height, canvasWidth, canvasHeight}` |
| `display-settings` | 双向 | 分辨率/帧率/编码偏好；车机提出，中继回声确认并转给设备 |
| `keyframe` | 车机 → 中继 | 请给我一个 IDR（我掉帧了、刚加入、tab 回到前台）。中继会合并限流 |
| `pause` | 车机 → 中继 | 车机暂停/恢复（切后台等） |
| `stats` | 车机 → 中继 | 解码队列、丢帧、渲染 fps、延迟、rtt、时钟偏移等；基础字段固定，额外字段允许数值/短字符串 |
| `receiver-info` | 车机 → 中继 | 页面环境（UA、可用内存、是否安全上下文…）≤64KB |
| `ping`/`pong` | 双向 | `t0Us`/`t1Us`/`t2Us` 三时间戳，接收端由此算出与中继的时钟偏移与往返 |
| `error` | 中继 → 对方 | 协议违规：先发这条，再以 1002 关 socket |

64 位整数一律用十进制**字符串**传（JSON number 超过 2^53 会丢精度）。

## 会话规则（中继侧）

1. 格式先于帧：接收端在拿到 `video-format` 之前不会收到任何视频。
2. 掉队只从关键帧恢复：`awaitingKeyFrame` 期间非关键帧直接不发；恢复后的第一帧带 gap 标志。
3. 关键帧请求合并限流：400ms 窗口内多次请求只对源产生一次要求，其余登记为 deferred。
4. 背压：某接收端 socket 缓冲超过阈值就丢到下一个关键帧再发，计数进 `droppedForBackpressure`。
5. 时钟线上移：源的 pts 从它自己的起点计（ffmpeg 从 0 起、浏览器从采集起）；中继按"每帧到达时刻"给一次锚定，
   之后 pts 都平移到中继时钟上。锚点只在 pts 倒退或漂移超过一个 frame interval 时重设。
6. 一屏一个输入：设备接入时合成源让位（`startup/waiting-media` → `media-ready`）。

## 与上游的差异

* 输入侧协议（设备→中继）是本原型自定的：上游的设备是 iPhone，走 iAP2/AirPlay/CarPlay，无法照搬。
* hello 里多一个可选 `source` 字符串，用来让运维页面显示是哪台设备。
* microphone（kind 3）：上游用它把车机麦克风送回流设备，本原型没有实现，收到会当作协议违规处理并发 `error`。
* 没有 CarPlay 控制会话、没有 MFi 认证。见 README 的边界说明。
