// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// The iPhone's own surface — the thing that gets captured and pushed to the car.
//
// Read the boundary first, because it is the whole design: ReplayKit's in-app capture hands this app
// the frames *this app draws*. It cannot hand over another app's windows, and no third-party app can
// drive the system screen mirroring. So what the car sees is this view: a connection panel, the
// projector's own status, and the taps the head unit sent, drawn here and therefore encoded back
// there. A CarPlay receiver that shows arbitrary phone apps is an MFi accessory speaking Apple's
// session — a different product, and not what this prototype has.
//
// Nothing in this file speaks the protocol: it only shows what ProjectionDevice reports.

import SwiftUI
import MirrorplayWire

@main
struct MirrorplayDeviceApp: App {
    @StateObject private var model = DeviceModel()

    var body: some Scene {
        WindowGroup {
            DeviceScreen(model: model)
                .onAppear { model.prepareIfConfigured() }
        }
    }
}

@MainActor
final class DeviceModel: ObservableObject {
    /// The address fields are separate published values, not a struct behind a binding: a text field
    /// that writes into a copy of a value type is how a form ends up forgetting what you typed.
    @Published var host: String = ""
    @Published var port: String = ""
    @Published var token: String = RelayDefaults.token
    @Published var tls: Bool = false
    /// The capture geometry and the phone's own metrics, asked for once when connecting: a device
    /// that reports 1280×720 while sending 9:16-scaled pixels is how a car gets a stretched picture.
    @Published var geometryWidth: Double = 1280
    @Published var geometryHeight: Double = 720
    @Published var geometryFps: Int = 30

    @Published var status = DeviceStatus()
    @Published var logLines: String = ""
    @Published var started = false
    /// Where the car's taps land on this screen. The app draws them, the encoder captures them, and
    /// the head unit sees its own finger come back: that is the whole proof the input leg works.
    @Published var contacts: [TouchContact] = []

    private var device: ProjectionDevice?
    private let defaultsKey = "mirrorplay.relay"
    private var lastReportedScreenSize: CGSize?

    private var screenBounds: CGRect { UIScreen.main.bounds }
    private var displayScale: Double { Double(UIScreen.main.scale) }
    /// The insets in the scene's own window. `UIScreen.main` has neither of them, and a device that
    /// reports the wrong safe area is a device whose touches land off the picture.
    private var scene: UIWindowScene? {
        UIApplication.shared.connectedScenes.first as? UIWindowScene
    }

    private var safeTop: Double { Double(lastWindow?.safeAreaInsets.top ?? 0) }
    private var safeBottom: Double { Double(lastWindow?.safeAreaInsets.bottom ?? 0) }

    private var lastWindow: UIWindow? {
        (scene?.windows.first { $0.isKeyWindow }) ?? scene?.windows.first
    }

    init() {
        guard let saved = UserDefaults.standard.dictionary(forKey: defaultsKey) else { return }
        host = saved["host"] as? String ?? ""
        port = saved["port"] as? String ?? ""
        token = saved["token"] as? String ?? RelayDefaults.token
        tls = saved["tls"] as? Bool ?? false
    }

    var canConnect: Bool { !host.isEmpty && !token.isEmpty }

    var endpoint: RelayEndpoint {
        RelayEndpoint(host: host, port: Int(port), tls: tls, token: token)
    }

    /// Nothing streams on its own: a phone that reconnected overnight must not start recording the
    /// screen without the person holding it deciding to.
    func prepareIfConfigured() { started = false }

    func connect() {
        guard canConnect else { return }
        UserDefaults.standard.set(["host": host, "port": port, "token": token, "tls": tls], forKey: defaultsKey)
        let size = CGSize(width: geometryWidth, height: geometryHeight)
        let made = ProjectionDevice(
            endpoint: endpoint,
            geometry: ProjectionDevice.Geometry(width: Int(size.width), height: Int(size.height), fps: geometryFps),
            display: DisplayReport(
                width: Int(screenBounds.width * displayScale),
                height: Int(screenBounds.height * displayScale),
                dpr: displayScale,
                refreshHz: Double(max(1, UIScreen.main.maximumFramesPerSecond)),
                safeArea: SafeAreaValue(
                    top: Int(safeTop * displayScale), right: 0,
                    bottom: Int(safeBottom * displayScale), left: 0
                ),
                viewport: SizeValue(width: Int(screenBounds.width), height: Int(screenBounds.height))
            )
        )
        made.onChange = { [weak self] snapshot in
            Task { @MainActor in
                self?.status = snapshot
                if let line = snapshot.lastError ?? snapshot.relaySaid { self?.log(line) }
            }
        }
        made.onTouch = { [weak self] seen in
            Task { @MainActor in self?.contacts = seen }
        }
        device = made
        started = true
        lastReportedScreenSize = screenBounds.size
        made.start()
        log("pairing with endpoint at host \(host)\(port.isEmpty ? "" : ":\(port)")")
    }

    func disconnect() {
        device?.stop()
        device = nil
        started = false
        contacts = []
        status = DeviceStatus()
        lastReportedScreenSize = nil
        log("stopped")
    }

    func askKeyFrame() {
        device?.forceKeyframe()
        log("the encoder was asked for an IDR")
    }

    func togglePause() {
        guard let device else { return }
        let pause = status.phase != .paused
        device.setPaused(pause)
        log(pause ? "pause requested locally" : "resume requested locally")
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            device?.captureInterrupted(true)
        case .active:
            device?.captureInterrupted(false)
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    func reportScreenSize(_ size: CGSize) {
        guard let device, size.width > 0, size.height > 0 else { return }
        guard size != lastReportedScreenSize else { return }
        lastReportedScreenSize = size
        let pixels = CGSize(width: size.width * displayScale, height: size.height * displayScale)
        let width = Int(pixels.width.rounded())
        let height = Int(pixels.height.rounded())
        device.rotationChanged(width: width, height: height)
        log("rotation/size changed → \(width)x\(height)")
    }

    private func log(_ line: String) {
        // Timestamped, newest first: this list is what gets read aloud when a run goes wrong in the
        // car park, and "which line was it at 21:04" is the only useful question about it.
        let clock = Date().formatted(date: .omitted, time: .standard)
        logLines = (["\(clock) \(line)"] + logLines.split(separator: "\n").prefix(39).map(String.init)).joined(separator: "\n")
    }
}

struct DeviceScreen: View {
    @ObservedObject var model: DeviceModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Something unmistakably this app's own, so a single glance in the car answers the
            // question "which pixels am I looking at".
            VStack(spacing: 14) {
                Text("mirrorplay").font(.system(size: 42, weight: .semibold, design: .monospaced)).foregroundStyle(.green)
                Text("device end · this screen is what the car receives").multilineTextAlignment(.center)
                    .font(.footnote).foregroundStyle(.white.opacity(0.7))

                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                    GridRow { label("phase"); value(model.status.phase.rawValue) }
                    GridRow { label("announced"); value(model.status.announced ?? "not yet") }
                    GridRow { label("samples"); value("\(model.status.samplesSent) · \(model.status.keyFramesSent) IDR") }
                    GridRow { label("out"); value("\(model.status.bytesSent / 1024) KiB") }
                    GridRow { label("relay said"); value(model.status.relaySaid ?? "—") }
                    GridRow { label("encoder"); value(model.status.encoderNote ?? "—") }
                    GridRow { label("error"); value(model.status.lastError ?? "none") }
                }
                .padding(.top, 8)

                Spacer()

                Text(model.logLines)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.55))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(4)
            }
            .padding(.horizontal, 28)
            .padding(.top, 40)

            // The head unit's fingers, drawn here so they are captured here.
            ForEach(model.contacts, id: \.id) { contact in
                TouchMark(contact: contact)
            }

            VStack {
                Spacer()
                Panel(model: model).padding(.bottom, 8)
            }
        }
        .overlay(
            // The scene itself knows when the phone has turned into a different pixel rectangle;
            // ReplayKit captures that new surface, so the encoder and announcement have to follow.
            GeometryReader { screen in
                Color.clear
                    .onChange(of: screen.size) { size in model.reportScreenSize(size) }
            }
            .allowsHitTesting(false)
        )
        .onChange(of: scenePhase) { phase in
            model.scenePhaseChanged(phase)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.white.opacity(0.5))
    }

    private func value(_ text: String) -> some View {
        Text(text).font(.system(.body, design: .monospaced)).foregroundStyle(.white)
    }
}

private struct TouchMark: View {
    let contact: TouchContact

    var body: some View {
        GeometryReader { space in
            Circle()
                .stroke(.green, lineWidth: 5)
                .frame(width: 68, height: 68)
                .position(x: contact.x * space.size.width, y: contact.y * space.size.height)
                .overlay(Text("\(contact.id)").font(.caption).foregroundStyle(.green).offset(x: 44, y: -26))
        }
        .ignoresSafeArea()
    }
}

private struct Panel: View {
    @ObservedObject var model: DeviceModel

    var body: some View {
        VStack(spacing: 10) {
            if !model.started {
                TextField("relay host, e.g. 192.168.1.20", text: $model.host)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.URL)
                    .padding(10).background(.white.opacity(0.08)).cornerRadius(9)
                HStack {
                    TextField("port", text: $model.port)
                        .keyboardType(.numberPad)
                        .frame(width: 96)
                        .padding(10).background(.white.opacity(0.08)).cornerRadius(9)
                    SecureField("pairing token", text: $model.token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(10).background(.white.opacity(0.08)).cornerRadius(9)
                }
                Toggle(isOn: $model.tls) { Text("wss:// (needed outside a lab)") }.font(.footnote).tint(.green)
                Button(action: model.connect) { Text("Connect and share this screen").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(.green).disabled(!model.canConnect)
                Text("ReplayKit records this app's own screen. It is not, and cannot be, system screen mirroring.")
                    .font(.caption2).foregroundStyle(.white.opacity(0.45))
                    .multilineTextAlignment(.center)
            } else {
                HStack(spacing: 10) {
                    Button("key frame", action: model.askKeyFrame).buttonStyle(.bordered).tint(.green)
                    Button(model.status.phase == .paused ? "resume" : "pause", action: model.togglePause)
                        .buttonStyle(.bordered).tint(model.status.phase == .paused ? .green : .orange)
                    Button("stop", action: model.disconnect).buttonStyle(.bordered).tint(.red)
                }
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial.opacity(0.9))
        .cornerRadius(14)
    }
}

/// The token a head unit's page carries in its URL, so a phone can be pointed at the same relay
/// without typing the pairing string twice.
enum RelayDefaults {
    static let token = "mirrorplay"
}
