// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// The iOS device leg's protocol state machine, without UIKit, ReplayKit, AVFoundation or sockets.
//
// This exists because the hard parts of the phone input are not iOS API calls. They are decisions a
// relay and a viewer can observe: when to introduce the phone again, when to restart the encoder, when
// to announce a new decoder configuration, and when a frame must not be sent yet because the viewer
// cannot possibly decode it. Those rules can be tested on Linux, so they live here instead of hiding in
// the app layer where "it looked right on the phone" is the only feedback loop.
//
// The app still owns the platform parts: capture starts here as an action, but ReplayKit is called by
// ProjectionDevice. Likewise `.sendHello` only records that the phone must introduce itself; the app
// serialises the actual JSON hello.

import Foundation

/// The encoder geometry the coordinator is allowed to ask for.
public struct DeviceGeometry: Equatable, Sendable {
    public var width: Int
    public var height: Int
    public var fps: Int
    public var bitrate: Int

    public init(width: Int, height: Int, fps: Int = 30, bitrate: Int = 3_000_000) {
        self.width = width
        self.height = height
        self.fps = fps
        self.bitrate = bitrate
    }
}

public enum DevicePhase: String, Equatable, Sendable {
    case idle
    case pairing
    case waitingForKeyFrame
    case streaming
    case paused
    case interrupted
    case stopped
}

/// The decoder configuration that will be announced to the relay before samples are accepted.
public struct DeviceFormat: Equatable, Sendable {
    public var codecString: String
    public var config: String
    public var width: Int
    public var height: Int

    public init(codecString: String, config: String, width: Int, height: Int) {
        self.codecString = codecString
        self.config = config
        self.width = width
        self.height = height
    }
}

/// One encoded picture in the shape the coordinator can reason about. `config` is present on IDRs whose
/// in-band parameter sets were readable; later pictures may omit it.
public struct DevicePicture: Equatable, Sendable {
    public var bytes: Data
    public var ptsUs: Int64
    public var width: Int?
    public var height: Int?
    public var codecString: String?
    public var config: String?
    public var isKeyframe: Bool
    public var isRunStart: Bool

    public init(
        bytes: Data,
        ptsUs: Int64,
        width: Int? = nil,
        height: Int? = nil,
        codecString: String? = nil,
        config: String? = nil,
        isKeyframe: Bool = false,
        isRunStart: Bool = false
    ) {
        self.bytes = bytes
        self.ptsUs = ptsUs
        self.width = width
        self.height = height
        self.codecString = codecString
        self.config = config
        self.isKeyframe = isKeyframe
        self.isRunStart = isRunStart
    }

    public var format: DeviceFormat? {
        guard
            let width, width > 0,
            let height, height > 0,
            let codecString, !codecString.isEmpty,
            let config, !config.isEmpty
        else { return nil }
        return DeviceFormat(codecString: codecString, config: config, width: width, height: height)
    }
}

/// What the app should do next. Actions are deliberately side-effect-free values so tests can inspect
/// protocol-visible behaviour without pretending they own a real session.
public enum DeviceAction: Equatable, Sendable {
    case sendHello
    case sendFormat(DeviceFormat, screen: Int)
    case sendSample(DevicePicture, runId: Int, marksRunStart: Bool)
    case dropStaleSample(DevicePicture)
    case startEncoder(DeviceGeometry)
    case stopEncoder
    case startCapture(DeviceGeometry)
    case stopCapture
    case requestKeyframe
    case fail(reason: String)
}

public let defaultDeviceBitrate = 3_000_000

/// A Foundation-only coordinator for resolution, rotation, pause, reconnect, interruption and
/// key-frame gating.
///
/// The rules encoded here are:
///
/// 1. A reconnect sends `hello` again and, if media was live, asks for a new IDR because the relay has
///    no decoder context for the reopened socket.
/// 2. Every media run starts at a key frame carrying a newly announced format. Samples before the
///    announcement are not forwarded; a viewer configured from stale avcC data decodes garbage.
/// 3. A target-size change restarts capture/encoder only when media was active. Repeating the same
///    request must not churn the session.
/// 4. Pause stops capture while preserving connection; resume is a new media run.
/// 5. Interruption stops capture and encoder; recovery starts a new run before any further samples.
public final class DeviceCoordinator: @unchecked Sendable {
    private struct State {
        var phase: DevicePhase = .idle
        var runId = 0
        var target: DeviceGeometry
        var screen: Int
        var announcedFormat: DeviceFormat?
        var pendingRunStart = false
    }

    private let lock = NSLock()
    private var state: State

    public init(target: DeviceGeometry, screen: Int = 0) {
        self.state = State(target: Self.normalize(target), screen: screen)
    }

    public var phase: DevicePhase {
        lock.lock(); defer { lock.unlock() }
        return state.phase
    }

    public var runId: Int {
        lock.lock(); defer { lock.unlock() }
        return state.runId
    }

    public var target: DeviceGeometry {
        lock.lock(); defer { lock.unlock() }
        return state.target
    }

    public var announcedFormat: DeviceFormat? {
        lock.lock(); defer { lock.unlock() }
        return state.announcedFormat
    }

    /// Mark that the app is about to open/introduce a socket, without forcing capture yet.
    @discardableResult
    public func startPairing() -> [DeviceAction] {
        mutate { st in
            guard st.phase == .idle || st.phase == .stopped else { return [] }
            st.phase = .pairing
            st.announcedFormat = nil
            st.pendingRunStart = false
            return []
        }
    }

    /// Called every time the socket opens, including after a reconnect.
    @discardableResult
    public func connectionOpened() -> [DeviceAction] {
        mutate { st in
            var actions: [DeviceAction] = [.sendHello]
            switch st.phase {
            case .idle:
                st.phase = .pairing
            case .pairing:
                break
            case .waitingForKeyFrame, .streaming:
                st.phase = .waitingForKeyFrame
                st.runId += 1
                st.pendingRunStart = true
                st.announcedFormat = nil
                actions.append(.requestKeyframe)
            case .paused, .interrupted:
                st.announcedFormat = nil
                st.pendingRunStart = true
            case .stopped:
                st.phase = .pairing
                st.announcedFormat = nil
                st.pendingRunStart = false
            }
            return actions
        }
    }

    /// The relay accepted this input and told it to begin producing media.
    @discardableResult
    public func startRequested() -> [DeviceAction] {
        mutate { st in
            switch st.phase {
            case .waitingForKeyFrame, .streaming:
                return []
            case .paused:
                return beginRun(&st, prependStopEncoder: true)
            case .idle, .pairing, .stopped, .interrupted:
                return beginRun(&st, prependStopEncoder: false)
            }
        }
    }

    /// An explicit stop. This is not pause: the app should close the socket after this.
    @discardableResult
    public func stopRequested() -> [DeviceAction] {
        mutate { st in
            let wasProducing = st.phase == .waitingForKeyFrame || st.phase == .streaming || st.phase == .paused || st.phase == .interrupted
            st.phase = .stopped
            st.pendingRunStart = false
            st.announcedFormat = nil
            return wasProducing ? [.stopCapture, .stopEncoder] : []
        }
    }

    @discardableResult
    public func keyframeRequested() -> [DeviceAction] {
        mutate { st in
            guard st.phase == .waitingForKeyFrame || st.phase == .streaming else { return [] }
            return [.requestKeyframe]
        }
    }

    @discardableResult
    public func setPaused(_ paused: Bool) -> [DeviceAction] {
        mutate { st in
            if paused {
                guard st.phase == .waitingForKeyFrame || st.phase == .streaming else { return [] }
                st.phase = .paused
                st.pendingRunStart = false
                return [.stopCapture]
            }
            guard st.phase == .paused else { return [] }
            return beginRun(&st, prependStopEncoder: true)
        }
    }

    /// A new desired picture size/frame-rate/bitrate. If capture is live, this is a new media run.
    @discardableResult
    public func requestGeometry(_ geometry: DeviceGeometry) -> [DeviceAction] {
        mutate { st in
            requestGeometry(geometry, &st)
        }
    }

    /// Orientation change with the phone's new pixel dimensions. This is resolution work, not just UI.
    @discardableResult
    public func rotationChanged(width: Int, height: Int) -> [DeviceAction] {
        mutate { st in
            var old = st.target
            old.width = width
            old.height = height
            return requestGeometry(old, &st)
        }
    }

    /// System interruption: backgrounding, another recorder stealing the screen, or a failed capture
    /// callback. Recovery is always a new run.
    @discardableResult
    public func captureInterrupted(_ interrupted: Bool) -> [DeviceAction] {
        mutate { st in
            if interrupted {
                guard st.phase != .idle, st.phase != .stopped else { return [] }
                st.phase = .interrupted
                st.pendingRunStart = false
                st.announcedFormat = nil
                return [.stopCapture, .stopEncoder]
            }
            guard st.phase == .interrupted else { return [] }
            return beginRun(&st, prependStopEncoder: false)
        }
    }

    /// Reports one encoded access unit and returns the protocol-visible outbound work for it.
    @discardableResult
    public func receivedPicture(_ picture: DevicePicture) -> [DeviceAction] {
        mutate { st in
            guard st.phase == .waitingForKeyFrame || st.phase == .streaming else { return [] }

            if picture.isKeyframe {
                let actual = picture.format
                var actions: [DeviceAction] = []
                let needsFormat = st.announcedFormat == nil
                let announcedFormatChanged = !needsFormat && actual != nil && actual != st.announcedFormat

                if needsFormat {
                    guard let actual else {
                        return [.fail(reason: "encoder produced a key frame without parameter sets to announce")]
                    }
                    st.announcedFormat = actual
                    actions.append(.sendFormat(actual, screen: st.screen))
                } else if announcedFormatChanged, let actual {
                    st.announcedFormat = actual
                    actions.append(.sendFormat(actual, screen: st.screen))
                }

                let marksRunStart = st.pendingRunStart || picture.isRunStart
                st.pendingRunStart = false
                st.phase = .streaming
                actions.append(.sendSample(picture, runId: st.runId, marksRunStart: marksRunStart))
                return actions
            } else {
                if st.pendingRunStart {
                    return [.dropStaleSample(picture)]
                }
                guard st.announcedFormat != nil else {
                    return [.dropStaleSample(picture)]
                }
                let marksRunStart = picture.isRunStart
                st.pendingRunStart = false
                return [.sendSample(picture, runId: st.runId, marksRunStart: marksRunStart)]
            }
        }
    }

    // MARK: internals

    private func mutate(_ body: (inout State) -> [DeviceAction]) -> [DeviceAction] {
        lock.lock()
        defer { lock.unlock() }
        return body(&state)
    }

    private func beginRun(_ state: inout State, prependStopEncoder: Bool) -> [DeviceAction] {
        var actions: [DeviceAction] = []
        if prependStopEncoder { actions.append(.stopEncoder) }
        state.runId += 1
        state.phase = .waitingForKeyFrame
        state.pendingRunStart = true
        state.announcedFormat = nil
        actions.append(.startEncoder(state.target))
        actions.append(.startCapture(state.target))
        return actions
    }

    private func requestGeometry(_ geometry: DeviceGeometry, _ state: inout State) -> [DeviceAction] {
        let normalized = Self.normalize(geometry)
        guard normalized != state.target else { return [] }

        let wasProducing = state.phase == .waitingForKeyFrame || state.phase == .streaming
        let wasDeferred = state.phase == .paused || state.phase == .interrupted
        state.target = normalized

        guard wasProducing else {
            if wasDeferred || state.phase == .pairing {
                state.pendingRunStart = true
                state.announcedFormat = nil
            }
            return []
        }

        var actions: [DeviceAction] = [.stopCapture, .stopEncoder]
        actions.append(contentsOf: beginRun(&state, prependStopEncoder: false))
        return actions
    }

    private static func normalize(_ geometry: DeviceGeometry) -> DeviceGeometry {
        DeviceGeometry(
            width: max(16, geometry.width),
            height: max(16, geometry.height),
            fps: max(1, geometry.fps),
            bitrate: max(64_000, geometry.bitrate)
        )
    }
}
