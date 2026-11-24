# 验证记录

日期：2026-11-24。环境：Node 22.23.5，Chromium 145（Playwright 构建，`--headless=new`），ffmpeg 6.0 static（libx264 + aac）。

## 1. Node：协议、媒体、会话规则、socket 集成

```
$ npm test
# tests 53
# pass 53
# fail 0
```

| 文件 | 覆盖 |
|---|---|
| `test/protocol.test.js` | 24 字节小端头逐字段、kind/flags 数值约定、touch 的 16 位量化与拒收条件、key 载荷、整包解析、JSON 消息形状/方向/非法 JSON、i64 一律字符串、stats 允许追加数值字段但拒绝嵌套对象 |
| `test/media.test.js` | Annex B↔AVCC 往返与错误路径、avcC 解析/生成/reserved 长度位拒绝、SPS 取分辨率（用 libx264 真实参数集）、AUD 与"参数集-after-slice"两种分帧规则、ADTS→原始 AAC 与 ASC 构造、libx264 合成源逐帧校验（关键帧内 avcC 与宣告的一致）、**场景重启后仍继续出帧**、**每个场景真跑一次 lavfi** |
| `test/policy.test.js` | 无格式时计数但不外发；接收端只从关键帧开始收、首帧带 gap；重复 hello 视为同一接收端重新同步；关键帧请求 400ms 合并（3 请求→1 次打扰源、2 次 deferred）；背压丢帧与恢复；格式变更先宣告再发帧；touch/key 原封不动回到设备并计数；媒体时间线锚定（间距保持、倒退即重锚）；ping/pong；stats 落库 |
| `test/relay.test.js` | 真 WebSocket：hello→welcome/session/view-area、无源时 `startup/waiting-media`、非法 token 在升级阶段 401、协议违规先发 `error` 再 1002 关连接、设备接入替换合成源且不混格式、触控跨 socket 无损、设备半开连接被心跳回收后合成源接管回来、页面 import 的每个模块确实被服务且 content-type 是 javascript |

## 2. 页面脚本

```
$ npm run test:pages
✔ admin.html  ✔ check.html  ✔ index.html  ✔ input.html  ✔ receiver.html
```

`scripts/check-pages.py` 会把页面内联模块里的 `'/src/...'`、`'/web/...'` 导入重写成真实文件路径后交给 `node --check`，因此它同时校验"浏览器要抓的这些路径确实存在"。

## 3. 截图

`docs/images/receiver.png`（解码中的车机页）与 `docs/images/admin.png`（中继运维页）由 `node src/tools/screenshot.js` 在无头 Chromium 里截；`--wait-for` 给的是"页面真的出画面"的条件，等到才拍。

## 4. Chromium 端到端（CDP）

```
$ node src/cli.js --port 3000 --token mirrorplay --source ffmpeg --scene testsrc2 --size 960x540 --fps 30 &
$ node src/tools/browser-check.js --relay-port 3000 --token mirrorplay
ok   head unit page loads — connecting
ok   head unit decodes the synthetic source — 44 frames in
ok   the announced format is H.264 with audio and a view-area — avc1.42C01F 960×540 ~30fps · avcC 42B · AAC_LC 48000Hz 2ch · view area 1146×645
ok   the canvas has picture on it — 9216/9216 sampled pixels lit
ok   the receiver measures delay against live — 45.32 ms
ok   no page errors on the receiver — []
ok   a tap on the head unit reaches the relay — 3 touch events counted
ok   and the synthetic source reacts to it — scene testsrc2 → testsrc
ok   all three readout modes switch — SPEED / QUALITY / SMART
ok   the device encodes a real capture — 12 frames from the device
ok   the head unit keeps playing from the new source — 159 frames after the swap
ok   and it picked up the device geometry — receiver 1280 px · device 1280×720@20
ok   the device draws a head unit touch into its own picture — touch: #4 0.250,0.350 · contacts 1
ok   the self-check decodes a frame from this relay — decoded picture 960×540

14/14 browser checks passed
```

设备那一路用 Chromium 的假摄像头（`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`），所以"屏幕→H.264 编码→中继→WebCodecs 解码→画布"整条链在无头环境里是真跑通的。
"车机点击回到设备"这一步用的是脚本化接收端：无头 Chromium 里后台标签不一定把合成的 pointer 事件交给页面自己的处理函数；页面真实派发触控的那一路已经被上一条（点边缘真的换了场景）覆盖。

## 5. 跑这套测试时发现并修掉的问题

留档，因为它们说明测试为什么长这样：

* `gap` 语义写错：接收端在带 gap 的关键帧上又 flush 又再要一个 IDR，于是每 2 秒只走一帧。gap 的意思是"flush 后从这一帧开始"。
* `VideoDecoder.reset()` 之后必须重新 `configure()`，所以格式的 flush 不能对活着的解码器做 reset。
* 浏览器 H.264 编码器只接受 `avc:{format:'annexb'}`（`avcc` 报 unsupported），而线上要 AVCC：容器规范化必须在设备页做，格式以 IDR 带内的 SPS/PPS 为准。
* `setPointerCapture` 对合成 pointer 事件抛异常，直接把触控上报打断在发送之前。
* `FfmpegSource.stop()` 置的 `stopping` 标记没在 `start()` 复位，于是换场景之后画面一帧不再出。
* lavfi 选项串是扁平的 `name=a=1:b=2:size=..:rate=..`，把 `mandelbrot` 拼错会让源静默出 0 帧；现在每个场景都被真跑一遍。
* 中继时钟必须是epoch 线（页面可比）+ 单调线（内部可用）两条；只用单调线时 ping/pong 抵消不掉纪元年差，"偏离实况"就成了天文数字。
* 设备被强杀时 socket 不会关闭，投影会永远等在 disconnected；现在中继按标准 WS ping/pong 心跳发现并回收，合成源随之接管回来。
* 心跳候选集合一开始取错了对象（`receiver.link?.ws` 并不存在），于是接收端从来没被 ping 过；现在直接遍历 `wss.clients`，与角色无关。
* 会话模型 `attachSource` 会把中继注册的 `link.onClose` 覆盖掉，所以设备断开后没有人把合成源请回来。关闭现在是一次广播（`CloseNotifier.onClosed` 可注册多个处理方），谁也不会挤掉谁。
* 路由重写时把 `/src/...` 的根目录算少一层，页面模块集体 404，现象却是"页面加载正常但一帧不出"。现在有一条测试真去 GET 页面 import 的每个模块。

## 6. iPhone 设备端（device-ios）：跨语言逐字节对拍

`device-ios/Fixtures/` 里的字节不是手写的规格，而是 `scripts/ios-fixtures.mjs` 用**本仓库自己的**协议模块
（`src/protocol`、`src/media`）对一段真实 libx264 720p 编码现场生成的：`sps.bin`/`pps.bin`/`avcC.bin`、
一个 IDR 的 Annex B 与它的 AVCC 双胞胎、一个 delta、带 keyframe+gap 的完整信封、touch/key 载荷，加上
`manifest.json` 里对应的字段值。两次生成的 md5 完全一致，所以 CI 里"重新生成必须无 diff"这道门槛是可复现的。

Swift 侧读同一批文件断言自己产出相同字节（Swift 5.9，Linux 上执行）：

```
$ npm run fixtures:ios && cd device-ios && swift test
	 Executed 16 tests, with 0 failures (0 unexpected) in 0.003 seconds   # MirrorplayDeviceKitTests
	 Executed 10 tests, with 0 failures (0 unexpected) in 0.044 seconds   # MirrorplayWireTests
	 Executed 9 tests,  with 0 failures (0 unexpected) in 0.055 seconds   # MirrorplayH264Tests
Executed 35 tests, with 0 failures (0 unexpected)
```

`MirrorplayDeviceKitTests` 是本轮新加的可移植设备状态机测试，不依赖 UIKit/ReplayKit，覆盖设备端真正会让中继和接收机看见的行为：重连会重新 `hello` 并要求新 IDR；每个 run 必须用实际参数集宣告；宣告前的 delta 会被丢掉而不是偷发；同尺寸重复请求不会抖动编码器；分辨率/旋转在出流时走 `stopCapture → stopEncoder → startEncoder → startCapture`，暂停时只更新目标；本地暂停、恢复、系统中断、捕获失败都归入同一套 run/宣告规则。

这套测试自己被三次反证过，因为"全绿的 skip"是这个项目一路上最想躲开的失败形态：

| 故意破坏 | 结果 |
|---|---|
| 把 `Fixtures/` 移走 | `testFixturesArePresent` 两个用例失败，并列出缺哪些文件、该跑哪条命令（早先版本这里是"19 个测试里 15 个 skip，仍然报绿"，已修） |
| 把 `touch.bin` 中一个 contact id 由 `00` 改成 `02` | `testTouchPayloadIsTheSameNineteenBytes` 失败：`expected [3, 2, …] actual [3, 0, …]` |
| 把 `avcC.bin` 的 lengthSizeMinusOne 位改坏 | avcC 相关用例失败 |

中继侧同样按 iOS 的**次序**而不是浏览器的次序来验证（`test/ios-input.test.js`，59 项里的 6 项）：先 hello、
再宣告一次格式、然后先来 3 个 delta（必须被扣住）、才给一个 IDR（接收端从这里起步并带 gap）、之后 delta 放行；
触控回投到设备时**payload 与 fixture 逐字节相同**，不做二次量化；设备被 `terminate()`（手机走出范围、没有
close 握手）后，心跳在两格宽限期后回收，并且中继把会话回到 waiting/disconnected 并说明原因。

尚未在此环境验证的：`App/` 里依赖 UIKit/ReplayKit/AVFoundation 的部分。这台 Linux 上只做到了**语法解析**
（`swiftc -frontend -parse` 全部 ✔），类型检查与链接必须在 Mac 上做。用到的符号名（`RPScreenRecorder
.startCapture(handler:completionHandler:)`、`RPSampleBufferType.video`、`CMSampleBufferGetImageBuffer`、
`VTCompressionSessionCreate`、`VTSessionSetProperty`、`kVTEncodeFrameOptionKey_ForceKeyFrame`、
`kCMSampleAttachmentKey_NotSync`、`CMVideoFormatDescriptionGetH264ParameterSetAtIndex`）是按 Apple 公开文档写的，
没有一个凭空造——但"照文档写出来"和"编译过"是两件事。所以：线路与容器层的等价是**测出来的**，iOS 框架调用层是
**写出来待编**的；`.ipa` 也一样，只有 Mac 上的 Xcode 用你自己的身份才能导出可安装的包。

工具链事实：Swift 5.9.2（Ubuntu 22.04 构建）跑在 Debian 13 用户态上；SwiftPM 硬要 `ld.gold`，这台机器只有
`ld.bfd`，于是放了一个转发到 `ld` 的 shim，测试才真的执行而不是被跳过。

由此带出的两个工程决定：

* 编码器属性逐条下发（`VTSessionSetProperty` 循环），被系统拒绝的键经 `encoderNote` 显示到界面上；整表一次
  `VTSessionSetProperties` 失败只会表现成"画面怎么这么卡"，不会告诉你是谁没生效。
* Info.plist 只开 `NSAllowsLocalNetworking`（实验室 LAN 的 ws://），别处仍要求 wss://；并写
  `NSLocalNetworkUsageDescription`——iOS 14+ 少了它，连本地中继会被静默拒绝，看上去就像"代码写错了"。
## 7. 已知未验证 / 未实现

* HEVC：线路上留了 `video-format.format.codec = H265` 的字段位，编码器与参数集解析都只有 H.264。
* 麦克风（kind 3）：无实现；`hello.microphone` 固定 false，收到该 kind 按协议违规处理。
* 真实车机浏览器：只在 Chromium 145 验过。`/check` 是给人自查的，不是兼容保证。
* TLS：预览/测试走明文 HTTP+WS，配对用 URL token 代替；真部署要自己上 TLS 且换长随机 token。
* 苹果协议与 MFi：见 README，本原型不做，也没有可绕的路子。
## 8. ipa 容器与 CI 文本（本机真跑）

**`device-ios/package-ipa.sh`** —— 由 `test/ipa-packaging.test.js` 驱动，本机 5 项全过：

| 输入 | 结果 |
| --- | --- |
| 以 `cf fa ed fe` 开头的 64 位 Mach-o（我手工拼的假 arm64 二进制） | 通过：报 `64-bit Mach-O`，产出 zip，`unzip -Z1` 断言所有条目都在 `Payload/` 下，且 `Payload/Good.app/Demo` 仍在 |
| 以 `ca fe ba be` 开头的 fat 头 | 通过：报 `fat archive`，并**不调用 file(1)**——因为 file 会把 fat 魔数读成 "Java class data"，那句话写在交付物里就是骗人 |
| 内容是 `# written by hand, not compiled` | 拒：`does not begin with a Mach-O magic (read 0x23207772)`，且没有生成 .ipa |
| Info.plist 说 Ghost、包里没有该文件 / 包里有 Demo 但 plist 没写名字 / 没有 CFBundleExecutable | 分别拒（三种不同的失败原因各一条断言） |
| 一个空目录、一个不存在的路径 | 拒，退出码 2，且不写文件 |

**CI 文本本身也有测试** —— `test/ci.test.js` 把 `.github/workflows/*.yml` 里的 `run:` 块逐个抽出来做
`sh -n`，并把每条命令的工具名对着"查过的名字表"校验。它当场抓到了我自己写的 `xcodecodebuild`（真实
拼写错误），也逼我把两处误判修掉：heredoc 的结束标记 `PLIST` 不是命令、续行里的 `build archive` 不是
程序名。另外两项断言把设计钉住：未签名容器**无条件**产出；签名导出必须 `inputs.team_id != ''` 且缺证书
secret 就停在 exit 5，而不是把未签名文件说成签过名。

写这几段时我一共把文件路径和 SPDX 头写错了 4 次（`AG-PL-3-0-only`、`mirrorplace` 之类），也把一个测试
文件写到了两个不存在的目录里（产生的垃圾目录已确认内容后删除）。这些不是笔误的趣事：它们说明
"我没验证过的东西不会假装验证过"在这个项目里是真的在发生——包括对我自己写的东西。

## 9. 没有 Mac 也能装到 iPhone：web app 那条路

`src/relay/server.js` 生成 `/receiver/manifest.webmanifest` 与 `/input/manifest.webmanifest`（**生成**而不是手写死文件，因为
配对 token 必须在装完之后再带得进去，否则桌面图标一打开就是"没有 token，看不到任何东西"）。图标不是 SVG 冒充：
`scripts/build-icons.mjs` 用同一套 Chromium 把 `app-icon.svg` 以 180/192/512 渲成真 PNG，并且读回 IHDR 自证尺寸。

`test/pwa.test.js` 6 项，全过：

| 断言 | 为什么它要紧 |
|---|---|
| 页面里有 `rel="manifest"`，且该 URL 的 content-type 是 `application/manifest+json` | 浏览器不认的东西不会因为你写了文件就生效 |
| `start_url` 带 `token=<中继的 token>` 和 `installed=1` | 装完就配对，是这条路的全部意义 |
| 清单里没有任何绝对 `localhost/127.0.0.1`（`start_url`、`scope`、每个 icon src 都是相对） | 我从 `--host 0.0.0.0` 起服务时 origin 就是 `localhost`；写死之后手机从局域网装到的会是指向错机器的图标 |
| 清单声明的每个图标都能取到，且 `IHDR` 的宽高 = `sizes` 声称的值 | 尺寸对不上是"过期产物"最典型的样子，肉眼在 diff 里看不出来 |
| `apple-touch-icon` 由 HTML 链接（iOS 主屏忽略 manifest 的 icons） | 少了它就是一个空白方块，看起来像"应用坏了"而不是"配置少一行" |
| 首页用话告诉人怎么装（Safari / Add to Home Screen） | 需要人操作的能力，如果没人读页面就等于不存在 |

同时把一处自相矛盾改掉了：图标原来设成"不提交，由构建生成"，但测试要求它必须可取——那任何一次干净克隆在跑生成脚本之前都是红的。
现在这 24 KiB 位图随仓库提交，`npm run icons` 只是重新生成的入口，不再是测试的前置条件。

## 10. 汇总

`npm test` 75 项（线路格式、H.264/ADTS 容器、会话规则、真 socket 中继、页面 import 服务、iOS 输入次序、ipa 容器、CI 文本、PWA）；
`npm run test:pages` 6 个页面（1 个纯标记页跳过）；`cd device-ios && swift test` 35 项（15 项线路/容器字节对拍 + 16 项 iOS 设备状态机）；`npm run test:browser` 14 项端到端。
在"PATH 上带不带 Swift 工具链的 `plutil`"两种环境下，`npm test` 都各跑两次全绿。

