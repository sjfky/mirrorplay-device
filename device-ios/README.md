# iPhone 作为设备端（mirrorplay · device-ios）

中继（`src/relay`）在整条投影线路里扮演"车机一侧的中转"，这个目录是**手机那一端**：把 iPhone 的画面编码成
H.264、按 OpenXPlay 的线路格式推进投影，并把车头发回的触控画回自己的画面。

## 先说清楚这台设备能做到哪里，做不到哪里

ReplayKit 的**进程内采集**（`RPScreenRecorder.startCapture`）只把这个 app 自己绘制的帧交给你。它拿不到别的
app 的窗口；也不是系统级屏幕镜像。所以车机上看到的是这个 app 的画面（连接状态、编解码统计、以及车头点按的
位置回显），而不是"手机整块屏"。

要在真机上让画面内容再多一点，路径是 ReplayKit 的系统广播扩展（Broadcast Upload Extension），需要
App Group、用户每次手动选择"开始广播"，且上架审查要说明用途——那是另一个产品形态，本原型没做，也不假装做了。

至于"手机上跑 CarPlay 画面"：CarPlay 的接收端角色属于经过 MFi 认证的配件，需要苹果签发的配件身份与 NDA 下的
协议文档。OpenXPlay 连自己都不打包任何 MFi 凭据。这一层不是工程难度问题，是授权问题。

## 文件

| 路径 | 内容 |
|---|---|
| `Sources/MirrorplayWire/` | 线路格式：24 字节头、kind/flags、touch/key 载荷、JSON 控制消息与方向规则 |
| `Sources/MirrorplayH264/` | avcC 记录构建/解析、Annex B↔AVCC、SPS 取分辨率（Exp-Golomb + 防竞争字节） |
| `Sources/MirrorplayDeviceKit/` | Foundation-only 设备状态机：重连、旋转/分辨率、暂停/恢复、关键帧、中断的协议可见决策 |
| `Tests/*` | 与中继侧 JavaScript **逐字节对拍**的测试；`MirrorplayDeviceKitTests` 覆盖设备状态机规则 |
| `App/Capture.swift` | ReplayKit 采集 + VideoToolbox 硬编：属性先问 `VTCopySupportedPropertyDictionaryForEncoder` 再逐条下发，被拒的键经 `encoderNote` 上报；IDR 按节奏与按请求都会产生 |
| `App/DeviceConnection.swift` | `URLSessionWebSocketTask` 输入端：hello/video-format/样本出，start/keyframe/pause/view/触控进 |
| `App/ProjectionDevice.swift` | 装配：把 RelayKit 采集、VideoToolbox 编码和 socket 发送接到 `DeviceCoordinator` 的状态机上；宣告一次/重连/旋转/暂停等协议规则不在这里重写 |
| `App/MirrorplayDeviceApp.swift` | SwiftUI 界面（也就是被采集的那块画面）；把 `scenePhase` 和屏幕尺寸变化转交给 `ProjectionDevice` 的状态机，协议规则不在界面里 |
| `Fixtures/` | `npm run fixtures:ios` 生成的字节样本（真实 libx264 编码 + 中继编码器模块写出的头/载荷） |
| `project.yml` | XcodeGen 描述；不提交 `.xcodeproj`，因为 pbxproj 人读不了 diff |
| `package-ipa.sh` | 把已编译好的 `.app` 封成 Payload 结构的**未签名** .ipa；魔数用真实 Mach-o/fat 值判定，伪产物直接拒 |
| `mac-build.sh` | Mac 上一条命令：fixture+测试 → xcodegen → archive →（有 TEAM_ID 才）签名导出 |

## 在这台 Linux 上已经跑过的验证

```
$ npm run fixtures:ios && cd device-ios && swift test
Executed 35 tests, with 0 failures     # 16 MirrorplayWire + 9 MirrorplayH264 + 16 MirrorplayDeviceKit
```

`swift test` 编译并通过 35 个用例（Swift 5.9，Linux）。新增的 16 个 `MirrorplayDeviceKitTests` 不碰 ReplayKit 对象，只验证设备端协议可见规则：重连重新 hello 并要求新 IDR；每个 run 必须用实际参数集宣告；未宣告前的 delta 丢弃不偷发；重复同尺寸请求不抖动；分辨率/旋转在出流时 stop→restart，暂停时只更新目标；恢复与中断恢复都是新 run。

* 隐藏 `Fixtures/` → 两个 `testFixturesArePresent` 直接失败（早期版本是"全绿但 15 个 skip"，那已经修掉了）
* 把 `touch.bin` 里一个 contact id 字节 `00` 改成 `02` → `testTouchPayloadIsTheSameNineteenBytes` 失败
* 把 `avcC.bin` 的 lengthSizeMinusOne 位改坏 → avcC 相关用例失败

`App/` 里依赖 UIKit/ReplayKit/AVFoundation 的文件在这台机器上只能做到**语法解析**（`swiftc -frontend -parse` 全绿），
类型检查与链接必须等 Mac。这一点不遮掩：跨语言字节对拍是真的跑过了，iOS 侧的框架调用还没。

## 第一次在 Xcode 里编译，先看这几处

这台机器上没有 Apple 编译器，所以看不到我写错的签名。下表左边是**从 iOS SDK 头文件抄下来**的东西，右边是编译
不过时最先该核对的地方——我在这轮里正是因为抄了头文件才发现自己写错了 4 处：

| 用到的签名 | 抄自 | 若报错先查 |
|---|---|---|
| `VTCompressionSessionCreate` 的 9 个标签 | `VTCompressionSession.h` | 我曾写成 `imageBufferAttributes` / `refcon`，并漏掉 `compressionSessionOut`（后果是 `made` 永远为 nil）；正确为 `sourceImageBufferAttributes` / `outputCallbackRefCon` / `compressionSessionOut` |
| `VTCompressionOutputCallback` | 同上 | 参数是 5 个：`(outputCallbackRefCon, sourceFrameRefCon, status, infoFlags, sampleBuffer)`；我最初按 4 个写 |
| `VTSessionSetProperty` 第一个参数 | `VTSession.h`：`typedef CFTypeRef VTSessionRef` | 因此**不需要** `as VTSession` 转换（我一度加过，是多余的） |
| `kVTEncodeFrameOptionKey_ForceKeyFrame` | `VTCompressionProperties.h`，注释原话是编码器"未必接受所有请求" | 所以本文件还自己按 `keyframeInterval` 数帧产 IDR，不把这个开关当保证 |
| `RPSampleBufferType`、`RPScreenRecorder.shared()` / `startCapture(handler:completionHandler:)` / `stopCapture(handler:)` | ReplayKit 文档索引 | 枚举 case 是 `.video`（我先前写 `.videoFrame`，那是猜的） |
| `MirrorplayDeviceKit` 里的 `DeviceCoordinator` | `Sources/MirrorplayDeviceKit/DeviceCoordinator.swift` + `project.yml` | 先确认 app target 的 package products 包含 `MirrorplayDeviceKit`，再 `xcodegen generate`。若这里报找不到，说明项目文件没有随 Package.swift 重新生成；不要把重连/分辨率/中断规则塞回 `ProjectionDevice` |
| `lipo -archs`、`plutil -extract … raw` | macOS 工具链 | 只有 Mac 上有能读懂 fat 头的 `lipo`；`package-ipa.sh` 探测**能力**而不是探测存在——Linux 上 Swift 工具链自带的 plutil 没有 `-extract`，它的 usage 文本曾被当成 bundle id 用过一次，现在由 `test/ipa-packaging.test.js` 钉住 |

不在表里的调用是 Foundation / SwiftUI 的常规用法，出问题通常来自 SDK 版本而不是名字。

## 关于 .ipa：这里能给的和不能给的

这台 Linux 上给不出一个**可安装的 .ipa**，原因两条，都不是"再努力一下"能绕的：

* 编译与链接 iOS 二进制需要 Xcode 的 iOS SDK（Apple 平台软件，且许可限定 Apple 硬件），Linux 上没有等价物；
* 签名需要签名身份（证书 + 私钥 + Profile），必须是你自己的 Apple 身份。**我不会伪造一个装不上的 .ipa 交给你。**

能做的是把"到 Xcode 之前"和"到签名之后"都铺平：

1. 在 Mac 上 `device-ios/mac-build.sh` → 出 `.xcarchive`；没有 TEAM_ID 时，还会用 `package-ipa.sh` 从 archive 里
   封一个 **Payload 结构正确、未签名** 的 `build/mirrorplay-unsigned.ipa`；
2. 你自己完成签名这一步（你说了可以自签）：SideStore/AltStore/Sideloadly 吃这个未签名容器，或者在任意 Mac 上
   `codesign` + `xcodebuild -exportArchive`；给 `TEAM_ID` 重跑 `mac-build.sh` 就直接出签名 ipa；
3. 没有本地 Mac，也可以把代码推到 GitHub，用 `.github/workflows/ios-device.yml` 的 macOS runner：
   * `team_id` 留空：CI 产出 **Payload 结构正确、未签名** 的 `mirrorplay-unsigned-ipa` artifact。你再用
     SideStore/AltStore/Sideloadly 等工具签一次，否则 iPhone 仍会拒装；
   * `team_id` 填 Apple Team ID，并配置 secrets `IOS_SIGNING_CERT_P12_BASE64` 与
     `IOS_SIGNING_CERT_PASSWORD`：CI 才导出 `mirrorplay-signed-ipa`。这是 development 导出，安装设备需要
     已在 profile/设备列表里注册；缺证书 secrets 时作业会**明确失败**，不会把未签名文件标成已签名。

`package-ipa.sh` 的行为不是纸面承诺：它有测试（`test/ipa-packaging.test.js`），本机的输出见
`docs/verification.md` 第 8 节 —— 真 Mach-O/fat 头通过；把 Info.plist 指向不存在的可执行文件、指向 Ghost 却装了
Demo 的包、塞了非 Mach-O 占位内容的目录、不是 bundle 的目录、以及不存在的目录，全部被拒且不留下 .ipa。

顺带：不需要 Mac、也不需要签名的装法已经落地——中继生成 manifest（token 走 start_url 的 query）、真位图图标、
首页写明 Safari「Add to Home Screen」步骤；见根目录 README 的 "iPhone, without a Mac" 一节与 `test/pwa.test.js`（6 项）。
它的边界同样清楚：网页拿得到摄像头，拿不到手机自己的屏幕，所以"把本机整屏推出去"仍然只有上面那条原生路径。

## 在 Mac 上出包

```bash
brew install xcodegen
device-ios/mac-build.sh                       # 无签名：产出 .xcarchive
TEAM_ID=ABCDE12345 device-ios/mac-build.sh    # 有签名：产出可安装的 .ipa
```

脚本会先重跑 fixture 与两侧测试，再 `xcodegen generate`，再 `xcodebuild build archive`；给了 `TEAM_ID` 才
`-exportArchive`。没有签名身份就没有可安装的 ipa——脚本会这么说，而不是给一个装不上的压缩包。
CI（`.github/workflows/ios-device.yml`）同理：默认产出 archive，签名需要仓库属主自己的证书与 Profile 作为 secrets。

## 真机跑起来要注意的

* **本地网络权限**：iPhone 连局域网中继会触发 iOS 的 Local Network 授权；`NSLocalNetworkUsageDescription` 已经在
  `project.yml` 的 Info.plist 里写了文案，第一次连接要点允许。
* **明文 ws:// 只在实验室**：非 localhost 的明文 WebSocket 会被 ATS 拦；真部署请用 `wss://` 并把界面上的 TLS 开关打开。
  token 只是"配对"的替身，不是安全边界。
* **后台 / 中断**：app 退到后台 ReplayKit 就停了，`UIBackgroundModes` 我留空——不谎称支持后台推屏。`DeviceScreen`
  会把 `scenePhase` 变成 `.background` / `.active` 转交给 `DeviceCoordinator`，中断时停采集和编码器，恢复时一定开新 run 并重新宣告格式。
* **暂停 / 恢复**：界面上的 pause/resume 和中继发来的 `pause` 走同一套规则：暂停只停采集、保持连接；恢复会重建编码器 run，并要求首帧 IDR 带 gap。
* **旋转 / 分辨率**：app 现在允许 portrait + landscape；SwiftUI 视图把实际屏幕尺寸变化转交给 `ProjectionDevice`。若正在出流，同尺寸重复请求不重启；真尺寸变化会 stop→restart，并在新的参数集到达后重新 `video-format`。
* **编码档位**：默认 main/level 4.0 + 无 B 帧；接收端配置解码用的 avcC 是从编码器实际吐出的参数集重建的，
  不是界面上下单的那个（这是浏览器端踩过的同一个坑：Chromium 不接受 baseline@720p 的编码器配置）。
