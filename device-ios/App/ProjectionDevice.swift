// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// The assembly: this app's own frames, a hardware H.264 encoder, and the projection socket, wired to
// the rules the relay expects of an input.
//
//   capture → overlay the car's taps → encode → announce once → samples forever
//                  ↑                                  ↓
//           drawn from the socket  ←  keyframe asked (a viewer joined or fell behind)
//
// Three decisions here are protocol decisions, not iOS ones, so they are commented where they live:
// the format is announced from the parameter sets the encoder actually produced; every run of media
// starts at a key frame and the relay marks it as a discontinuity; and the taps a head unit sent are
// drawn *before* encoding, because that is what makes the round trip visible on the car screen.

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import MirrorplayDeviceKit
import MirrorplayH264
import MirrorplayWire

public struct DeviceStatus: Equatable, Sendable {
    public enum Phase: String, Sendable {
        case idle, pairing, waiting, capturing, paused, interrupted, stopped
    }

    public var phase: Phase = .idle
    public var announced: String?
    public var runId = 0
    public var samplesSent = 0
    public var keyFramesSent = 0
    public var bytesSent = 0
    public var droppedSamples = 0
    /// What the head unit last did, expressed as contacts on the picture.
    public var contactsInPicture = 0
    public var relaySaid: String?
    public var encoderNote: String?
    public var lastError: String?
}

/// The thing an iPhone runs when it is the device end of the projection.
public final class ProjectionDevice: @unchecked Sendable {
    public let endpoint: RelayEndpoint
    public var onChange: ((DeviceStatus) -> Void)? { get { gate.onChange } set { gate.onChange = newValue } }
    /// Contacts as the head unit reported them, for the view to draw. The app draws them into the
    /// frames it encodes, so a tap in the car reappears in the car one round trip later.
    public var onTouch: (([TouchContact]) -> Void)? { get { gate.onTouch } set { gate.onTouch = newValue } }

    private let connection: DeviceConnection
    private let capture = AppScreenCapture()
    private let encoderLock = NSLock()
    private var encoder: H264Encoder
    private let gate = StateGate()
    private let coordinator: DeviceCoordinator
    private let geometryLock = NSLock()
    private var activeGeometryValue: Geometry
    private let hintLock = NSLock()
    private var mediaFpsHintValue: Double

    public struct Geometry: Equatable, Sendable {
        public var width: Int
        public var height: Int
        public var fps: Int
        public var bitrate: Int
        public init(width: Int = 1280, height: Int = 720, fps: Int = 30, bitrate: Int = 3_000_000) {
            self.width = width; self.height = height; self.fps = fps; self.bitrate = bitrate
        }
    }

    public init(endpoint: RelayEndpoint, geometry: Geometry = Geometry(), display: DisplayReport? = nil) {
        self.endpoint = endpoint
        self.mediaFpsHintValue = Double(geometry.fps)
        self.activeGeometryValue = geometry
        self.touchOverlayDisplay = display ?? DisplayReport(
            screen: 0, width: geometry.width, height: geometry.height, dpr: 2, refreshHz: Double(geometry.fps),
            safeArea: SafeAreaValue(top: 0, right: 0, bottom: 0, left: 0)
        )
        self.encoder = H264Encoder(width: geometry.width, height: geometry.height, fps: geometry.fps, bitrate: geometry.bitrate)
        self.coordinator = DeviceCoordinator(
            target: DeviceGeometry(width: geometry.width, height: geometry.height, fps: geometry.fps, bitrate: geometry.bitrate)
        )
        self.connection = DeviceConnection(endpoint: endpoint)
        wire()
    }

    // MARK: lifecycle

    public func start() {
        gate.mutate { $0.phase = .pairing }
        // The coordinator emits `.sendHello` when the socket reports it opened. The connection must not
        // also send an introduction closure, otherwise a reconnect writes two hellos and looks like a
        // protocol bug rather than a duplicated assembly line.
        connection.introduction = { [] }
        coordinator.startPairing()
        connection.start()
    }

    public func stop() {
        apply(coordinator.stopRequested())
        capture.stop()
        currentEncoder().stop()
        connection.stop()
        syncStatus()
    }

    /// Begin producing pictures. Called when the relay says `start`, which is after the pairing token
    /// has been accepted — a phone should not put the whole system into recording mode for a relay
    /// that turned it away.
    public func beginCapturing() {
        apply(coordinator.startRequested())
    }

    /// The app's UIKit/ReplayKit adapter calls these when the phone itself changes. The rules live in
    /// the coordinator so Linux tests can say what should happen.
    public func rotationChanged(width: Int, height: Int) {
        apply(coordinator.rotationChanged(width: width, height: height))
    }

    public func requestResolution(_ geometry: Geometry) {
        apply(coordinator.requestGeometry(DeviceGeometry(width: geometry.width, height: geometry.height, fps: geometry.fps, bitrate: geometry.bitrate)))
    }

    public func captureInterrupted(_ interrupted: Bool) {
        apply(coordinator.captureInterrupted(interrupted))
    }

    /// A local pause/resume that does not close the socket. The relay can send the same pause, but a
    /// person holding the phone also needs the same protocol decision.
    public func setPaused(_ paused: Bool) {
        apply(coordinator.setPaused(paused))
    }

    // MARK: what the relay says

    private func wire() {
        encoder.onPicture = { [weak self] picture in self?.publish(picture) }
        encoder.onNote = { [weak self] note in self?.gate.mutate { $0.encoderNote = note } }
        encoder.onFailure = { [weak self] error in self?.gate.fail(error) }
        capture.onFailure = { [weak self] error in self?.captureFailed(error) }

        connection.events = { [weak self] event in
            guard let self else { return }
            switch event {
            case .connected:
                self.gate.mutate { $0.relaySaid = "paired" }
                self.apply(self.coordinator.connectionOpened())
            case .disconnected:
                self.gate.mutate { $0.relaySaid = "socket closed" }
            case .started(let start):
                self.gate.mutate { $0.relaySaid = "start\(start.videoFormat.map { " \($0.width)x\($0.height)" } ?? "")" }
                self.apply(self.coordinator.startRequested())
            case .keyframeRequested:
                // The viewer needs a start point. A forced IDR plus the run-start flag is the answer;
                // waiting silently is not, because the viewer is dropping deltas until then.
                self.apply(self.coordinator.keyframeRequested())
            case .paused(let paused):
                self.gate.mutate { $0.relaySaid = paused ? "paused by head unit" : "resumed" }
                self.apply(self.coordinator.setPaused(paused))
            case .view(let view):
                let display = view.displays.first
                self.gate.mutate { $0.relaySaid = "view \(display.map { "\($0.width)x\($0.height)@\(Int($0.refreshHz))" } ?? "?")" }
            case .displaySettings(let settings):
                self.gate.mutate { $0.relaySaid = "display \(settings.resolution.rawValue)" }
            case .session(let session):
                self.gate.mutate { $0.relaySaid = "session \(session.phase.rawValue)" }
            case .touch(let contacts):
                self.gate.receiveTouch(contacts)
            case .key(let code, let down):
                self.gate.mutate { $0.relaySaid = "key \(code) \(down ? "down" : "up")" }
            case .relayError(let code, let message):
                self.gate.mutate {
                    if code == "rtt" { $0.relaySaid = message } else { $0.lastError = "\(code): \(message)" }
                }
            case .failed(let message):
                self.gate.mutate { $0.lastError = message }
            }
        }
    }

    private func helloMessage() -> ControlMessage {
        .hello(HelloMessage(
            version: 0,
            token: endpoint.token,
            decoders: [],
            displays: [touchOverlayDisplay],
            maxTouchContacts: wireMaxContacts,
            audio: [],
            microphone: false,
            source: "mirrorplay iOS device"
        ))
    }

    /// The picture this device sends, described the way the relay's view-area maths wants it: real
    /// size, real scale, real safe area. The view layer passes it in, because this object deliberately
    /// knows nothing about UIKit.
    public private(set) var touchOverlayDisplay: DisplayReport

    // MARK: outbound media

    /// The frame rate the announcement reports, taken from the encoder configuration currently in
    /// effect — not from what this app first asked for.
    public var mediaFpsHint: Double {
        hintLock.lock(); defer { hintLock.unlock() }
        return mediaFpsHintValue
    }

    private var currentGeometry: Geometry {
        geometryLock.lock(); defer { geometryLock.unlock() }
        return activeGeometryValue
    }

    private func publish(_ picture: CodedPicture) {
        // The announcement comes from the parameter sets this very IDR carried. The later delta units
        // may carry no SPS/PPS, and that is normal once the run has already been announced.
        let actual = picture.record.flatMap { try? AvcC(record: $0) }
        let geometry = currentGeometry
        let sample = DevicePicture(
            bytes: picture.avcc,
            ptsUs: picture.ptsUs,
            width: actual?.width ?? geometry.width,
            height: actual?.height ?? geometry.height,
            codecString: actual?.codecString,
            config: picture.record?.base64EncodedString(),
            isKeyframe: picture.isKeyframe,
            isRunStart: picture.isRunStart
        )
        apply(coordinator.receivedPicture(sample))
    }

    public func forceKeyframe() { currentEncoder().requestKeyframe() }

    // MARK: adapter plumbing

    private func currentEncoder() -> H264Encoder {
        encoderLock.lock(); defer { encoderLock.unlock() }
        return encoder
    }

    private func setStatus(phase: DeviceStatus.Phase? = nil, relaySaid: String? = nil, error: String? = nil) {
        gate.mutate { state in
            if let phase { state.phase = phase }
            if let relaySaid { state.relaySaid = relaySaid }
            if let error { state.lastError = error }
        }
    }

    private func syncStatus() {
        gate.mutate { state in
            state.runId = coordinator.runId
            switch coordinator.phase {
            case .idle: state.phase = .idle
            case .pairing: state.phase = .pairing
            case .waitingForKeyFrame: state.phase = .waiting
            case .streaming: state.phase = .capturing
            case .paused: state.phase = .paused
            case .interrupted: state.phase = .interrupted
            case .stopped: state.phase = .stopped
            }
        }
    }

    /// Capture failures are an interruption, not just a log line. Without this the app would stay in
    /// `.waitingForKeyFrame` forever, looking like the encoder stalled instead of the recorder stopped.
    private func captureFailed(_ error: CaptureError) {
        apply(coordinator.captureInterrupted(true))
        gate.fail(error)
    }

    private func apply(_ actions: [DeviceAction]) {
        var encoderSetupFailed = false

        for action in actions {
            switch action {
            case .sendHello:
                connection.send(helloMessage())
            case .sendFormat(let format, let screen):
                connection.send(.videoFormat(screen: screen, format: VideoFormatRecord(
                    codec: .h264,
                    codecString: format.codecString,
                    config: format.config,
                    width: format.width,
                    height: format.height,
                    fpsHint: mediaFpsHint
                )))
                gate.markAnnounced("\(format.codecString) \(format.width)x\(format.height)")
            case .sendSample(let sample, _, let marksRunStart):
                connection.sendSample(
                    sample.bytes,
                    presentationTimeUs: sample.ptsUs,
                    isKeyFrame: sample.isKeyframe,
                    isRunStart: marksRunStart
                )
                gate.counted(sample.bytes.count, keyframe: sample.isKeyframe)
            case .dropStaleSample:
                gate.mutate {
                    $0.droppedSamples += 1
                    $0.relaySaid = "dropped a sample the viewer could not decode yet"
                }
            case .startEncoder(let deviceGeometry):
                do {
                    gate.resetAnnouncement()
                    try startEncoder(deviceGeometry)
                } catch {
                    gate.fail(error)
                    encoderSetupFailed = true
                }
            case .stopEncoder:
                currentEncoder().stop()
            case .startCapture(let deviceGeometry):
                guard !encoderSetupFailed else { continue }
                let projectionGeometry = projectionGeometry(from: deviceGeometry)
                geometryLock.lock()
                activeGeometryValue = projectionGeometry
                geometryLock.unlock()
                capture.sink = TouchOverlay(switchTo: currentEncoder(), gate: gate)
                do {
                    try capture.start()
                    gate.mutate { $0.lastError = nil }
                } catch {
                    gate.fail(error)
                }
            case .stopCapture:
                capture.stop()
            case .requestKeyframe:
                currentEncoder().requestKeyframe()
            case .fail(let reason):
                gate.mutate { $0.lastError = reason }
            }
        }

        syncStatus()
    }

    private func startEncoder(_ geometry: DeviceGeometry) throws {
        let projectionGeometry = projectionGeometry(from: geometry)

        hintLock.lock()
        mediaFpsHintValue = Double(projectionGeometry.fps)
        hintLock.unlock()

        geometryLock.lock()
        activeGeometryValue = projectionGeometry
        geometryLock.unlock()

        let old = currentEncoder()
        let made: H264Encoder
        if old.width != geometry.width || old.height != geometry.height || old.fps != geometry.fps || old.bitrate != geometry.bitrate {
            old.stop()
            made = H264Encoder(
                width: geometry.width,
                height: geometry.height,
                fps: geometry.fps,
                bitrate: geometry.bitrate
            )
            made.onPicture = { [weak self] picture in self?.publish(picture) }
            made.onNote = { [weak self] note in self?.gate.mutate { $0.encoderNote = note } }
            made.onFailure = { [weak self] error in self?.gate.fail(error) }
            encoderLock.lock()
            encoder = made
            encoderLock.unlock()
        } else {
            made = old
        }
        try made.start()
    }

    private func projectionGeometry(from geometry: DeviceGeometry) -> Geometry {
        Geometry(width: geometry.width, height: geometry.height, fps: geometry.fps, bitrate: geometry.bitrate)
    }
}

/// Frames with the head unit's taps already drawn into them, then straight to the encoder.
private final class TouchOverlay: AppFrameSink, @unchecked Sendable {
    private let encoder: H264Encoder
    private let gate: StateGate

    init(switchTo encoder: H264Encoder, gate: StateGate) {
        self.encoder = encoder
        self.gate = gate
    }

    func receive(pixelBuffer: CVPixelBuffer, at time: CMTime) {
        draw(contacts: gate.currentContacts, into: pixelBuffer)
        encoder.encode(pixelBuffer: pixelBuffer, at: time)
    }

    /// BGRA pixels, drawn in place. An unexpected buffer layout means drawing nothing — a corrupted
    /// frame from a "helpful" fallback would be far harder to diagnose in the car.
    private func draw(contacts: [TouchContact], into buffer: CVPixelBuffer) {
        guard !contacts.isEmpty else { return }
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA else { return }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer),
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { return }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let width = rowBytes / 4
        let height = CVPixelBufferGetHeight(buffer)
        guard let context = CGContext(
            data: base,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: rowBytes,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return }

        for contact in contacts {
            let diameter: CGFloat = 68
            let rect = CGRect(
                x: contact.x * CGFloat(width) - diameter / 2,
                y: contact.y * CGFloat(height) - diameter / 2,
                width: diameter,
                height: diameter
            )
            context.setStrokeColor(CGColor(red: 0.31, green: 0.82, blue: 0.65, alpha: 1))
            context.setLineWidth(5)
            context.addEllipse(in: rect)
            context.strokePath()
        }
    }
}

/// The status, the contacts and the counters, behind one lock: the capture thread, the socket
/// callback and the SwiftUI view all read or write them, and a torn sample counter looks like a wire
/// bug rather than a threading one.
final class StateGate: @unchecked Sendable {
    var onChange: ((DeviceStatus) -> Void)?
    var onTouch: (([TouchContact]) -> Void)?

    private let lock = NSLock()
    private var status = DeviceStatus()
    private var contacts: [TouchContact] = []
    private var announced = false

    var currentContacts: [TouchContact] {
        lock.lock(); defer { lock.unlock() }
        return contacts
    }

    var needsAnnouncement: Bool {
        lock.lock(); defer { lock.unlock() }
        return !announced
    }

    func markAnnounced(_ description: String) {
        lock.lock()
        announced = true
        status.announced = description
        let snapshot = status
        lock.unlock()
        onChange?(snapshot)
    }

    /// An announcement belongs to one run of media; after a restart the new parameter sets have to be
    /// announced again, or a viewer keeps a decoder configured for the old run.
    func resetAnnouncement() {
        lock.lock()
        announced = false
        status.announced = nil
        let snapshot = status
        lock.unlock()
        onChange?(snapshot)
    }

    func mutate(_ change: (inout DeviceStatus) -> Void) {
        lock.lock()
        change(&status)
        let snapshot = status
        lock.unlock()
        onChange?(snapshot)
    }

    func receiveTouch(_ seen: [TouchContact]) {
        lock.lock()
        contacts = seen.filter(\.pressed)
        status.contactsInPicture = contacts.count
        let pressed = contacts
        let snapshot = status
        lock.unlock()
        onTouch?(pressed)
        onChange?(snapshot)
    }

    func counted(_ bytes: Int, keyframe: Bool) {
        lock.lock()
        status.samplesSent += 1
        status.bytesSent += bytes
        if keyframe { status.keyFramesSent += 1 }
        let snapshot = status
        lock.unlock()
        onChange?(snapshot)
    }

    func fail(_ error: Error) {
        mutate { $0.lastError = "\(error)" }
    }
}

/// An error for the cases where the message is the whole point.
struct ErrorDescription: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}
