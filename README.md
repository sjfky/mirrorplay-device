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
| `Tests/*` | 与中继侧 JavaScript **逐字节对拍**的测试，数据来自 `Fixtures/` |
| `App/ScreenCapture.swift` | ReplayKit 采集 + VideoToolbox 硬编（`kVTCompressionPropertyKey`、IDR 节奏与强插） |
| `App/DeviceConnection.swift` | `URLSessionWebSocketTask` 输入端：hello/video-format/样本出，start/keyframe/pause/view/触控进 |
| `App/ProjectionDevice.swift` | 装配：采集→编码→宣告一次→持续出帧；把车头触控画进帧里 |
| `App/MirrorplayDeviceApp.swift` | SwiftUI 界面（也就是被采集的那块画面） |
| `Fixtures/` | `npm run fixtures:ios` 生成的字节样本（真实 libx264 编码 + 中继编码器模块写出的头/载荷） |
| `project.yml` | XcodeGen 描述；不提交 `.xcodeproj`，因为 pbxproj 人读不了 diff |

## 在这台 Linux 上已经跑过的验证

```
$ npm run fixtures:ios && cd device-ios && swift test
Executed 19 tests, with 0 failures     # 15 skip 之前被消掉了：见下
```

`swift test` 编译并通过 19 个用例（Swift 5.9，Linux）。为确认这套测试真的会红，做了三次故意破坏：

* 隐藏 `Fixtures/` → 两个 `testFixturesArePresent` 直接失败（早期版本是"全绿但 15 个 skip"，那已经修掉了）
* 把 `touch.bin` 里一个 contact id 字节 `00` 改成 `02` → `testTouchPayloadIsTheSameNineteenBytes` 失败
* 把 `avcC.bin` 的 lengthSizeMinusOne 位改坏 → avcC 相关用例失败

`App/` 里依赖 UIKit/ReplayKit/AVFoundation 的文件在这台机器上只能做到**语法解析**（`swiftc -frontend -parse` 全绿），
类型检查与链接必须等 Mac。这一点不遮掩：跨语言字节对拍是真的跑过了，iOS 侧的框架调用还没。

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
* **后台**：app 退到后台 ReplayKit 就停了，`UIBackgroundModes` 我留空——不谎称支持后台推屏。
* **编码档位**：默认 main/level 4.0 + 无 B 帧；接收端配置解码用的 avcC 是从编码器实际吐出的参数集重建的，
  不是界面上下单的那个（这是浏览器端踩过的同一个坑：Chromium 不接受 baseline@720p 的编码器配置）。
