// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// The part that turns a phone's own frames into the projection's H.264.
//
// Read the boundary first, because it is the whole design: ReplayKit's in-app capture hands this app
// the frames *this app draws* (`RPScreenRecorder.startCapture`). It cannot hand over another app's
// windows, and no third-party app can drive the system screen mirror. So what the car receives is
// this app's surface — connection state, encoder counters, and the taps the head unit sent, drawn
// here and therefore encoded back there. A receiver that shows arbitrary phone apps is an MFi
// accessory speaking Apple's session, and that is not this prototype. See ../README.md.
//
// Two things in here are protocol decisions rather than iOS decisions, and they are commented where
// they live: the format announced to the relay is built from the parameter sets the encoder actually
// produced, and every run of media begins at a key frame with the gap flag set, because that is the
// only frame a viewer can start decoding from.
//
// These API names were checked against Apple's documentation, not recalled from memory (RPScreenRecorder.shared(),
// startCapture(handler:completionHandler:), stopCapture(handler:), RPSampleBufferType.video,
// VTCompressionSessionCreate, VTSessionSetProperty(_:key:value:),
// VTCopySupportedPropertyDictionaryForEncoder, kVTCompressionPropertyKey_{RealTime,AverageBitRate,
// MaxKeyFrameInterval,DataRateLimits,ProfileLevel,ExpectedFrameRate,MaxFrameDelayCount}). Nothing was
// invented. What no Linux machine can check is whether this particular Xcode build still type-checks
// them — see "第一次在 Xcode 里编译" in ../README.md for the two lines to look at first.

import AVFoundation
import CoreMedia
import CoreVideo
import MirrorplayH264
import MirrorplayWire
import VideoToolbox

/// ReplayKit hands over a frame; this delivers it as one finished AVCC access unit.
public protocol AppFrameSink: AnyObject, Sendable {
    func receive(pixelBuffer: CVPixelBuffer, at time: CMTime)
}

public enum CaptureError: Error, CustomStringConvertible {
    case recorderUnavailable
    case recorderBusy
    case recorderFailed(String)
    case encoderFailed(status: Int32, stage: String)
    case noParameterSets
    case unreadableSample

    public var description: String {
        switch self {
        case .recorderUnavailable: return "ReplayKit is unavailable (the simulator, or a device without screen recording)"
        case .recorderBusy: return "another capture already owns the screen recorder"
        case .recorderFailed(let reason): return "screen capture stopped: \(reason)"
        case .encoderFailed(let status, let stage): return "VideoToolbox failed at \(stage) with status \(status)"
        case .noParameterSets: return "the encoder produced no parameter sets to announce"
        case .unreadableSample: return "an encoded sample arrived that this code cannot read"
        }
    }
}

/// One finished picture, already in the container the wire requires.
public struct CodedPicture: Sendable {
    public let avcc: Data
    /// `avcC` for the announcement, built from the parameter sets of this very access unit.
    public let record: Data?
    public let ptsUs: Int64
    public let isKeyframe: Bool
    /// True for the first picture of a run, which a viewer must flush its decoder for.
    public let isRunStart: Bool
}

/// VideoToolbox, configured the way this wire likes it: one IDR every couple of seconds, no B
/// frames, and every setting the encoder declined reported instead of swallowed.
public final class H264Encoder: @unchecked Sendable {
    public var onPicture: ((CodedPicture) -> Void)?
    public var onNote: ((String) -> Void)?
    public var onFailure: ((CaptureError) -> Void)?

    public let width: Int
    public let height: Int
    public let fps: Int
    public let bitrate: Int
    /// A viewer can only join, or catch up after a loss, on a key frame — so the device makes one on
    /// a clock as well as on request.
    public let keyframeInterval: Int

    private var session: VTCompressionSession?
    private var sinceIdr: Int
    private var forceKeyframe = false
    private var awaitingRunStart = true
    private var announced: Data?

    public init(width: Int, height: Int, fps: Int, bitrate: Int = 3_000_000, keyframeInterval: Int? = nil) {
        self.width = max(16, width)
        self.height = max(16, height)
        self.fps = max(1, fps)
        self.bitrate = max(64_000, bitrate)
        self.keyframeInterval = keyframeInterval ?? max(1, self.fps * 2)
        self.sinceIdr = self.keyframeInterval // the first picture out is an IDR
    }

    /// The settings we want, as name/key/value triples so a declined key can be named in the log
    /// rather than reported as "the encoder ignored something".
    private var requested: [(name: String, key: CFString, value: CFTypeRef)] {
        [
            ("RealTime", kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
            // Main profile, level 4.0, no B frames: no viewer has to reorder before it can show a
            // frame, which is what keeps "behind live" small. (Chromium's encoder refuses baseline at
            // 720p too, so this is what browsers and phones agree on.)
            ("ProfileLevel", kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Main_4_0 as CFString),
            ("AverageBitRate", kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            ("DataRateLimits", kVTCompressionPropertyKey_DataRateLimits,
             [NSNumber(value: bitrate / 8), NSNumber(value: 1)] as CFArray),
            ("MaxKeyFrameInterval", kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: keyframeInterval)),
            ("ExpectedFrameRate", kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
            ("MaxFrameDelayCount", kVTCompressionPropertyKey_MaxFrameDelayCount, NSNumber(value: 1)),
        ]
    }

    public func start() throws {
        var made: VTCompressionSession?
        let created = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            sourceImageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: Self.outputCallback,
            outputCallbackRefCon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &made
        )
        guard created == noErr, let session = made else {
            throw CaptureError.encoderFailed(status: created, stage: "VTCompressionSessionCreate")
        }
        self.session = session

        // The session says what it implements. Asking it, rather than assuming the property names
        // imply support, is what turns "the encoder silently ignored my bit rate" into a sentence the
        // operator can read.
        var supported: CFDictionary?
        let surveyed = VTSessionCopySupportedPropertyDictionary(session, supportedPropertyDictionaryOut: &supported)
        let capabilities = surveyed == noErr ? (supported as? [CFString: Any]) : nil
        if surveyed != noErr { onNote?("the encoder would not describe its capabilities (status \(surveyed)); applying settings anyway") }

        var declined: [String] = []
        for property in requested {
            if let capabilities, capabilities.index(forKey: property.key) == nil {
                declined.append("\(property.name) (not offered)")
                continue
            }
            let status = VTSessionSetProperty(session, key: property.key, value: property.value)
            if status != noErr { declined.append("\(property.name) (status \(status))") }
        }
        if !declined.isEmpty { onNote?("encoder declined: \(declined.joined(separator: ", "))") }

        let prepared = VTCompressionSessionPrepareToEncodeFrames(session)
        if prepared != noErr { throw CaptureError.encoderFailed(status: prepared, stage: "prepare") }
        awaitingRunStart = true
        sinceIdr = keyframeInterval
        onNote?("H.264 encoder up: \(width)×\(height)@\(fps), IDR every \(keyframeInterval) frames")
    }

    public func stop() {
        guard let session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
        onNote?("encoder stopped")
    }

    /// The relay asked for an IDR now, because a viewer joined or lost its place. `forceKeyFrame` in
    /// the frame options is a request the encoder may answer on its own schedule, which is why this
    /// class also counts frames since the last IDR.
    public func requestKeyframe() { forceKeyframe = true }

    public func encode(pixelBuffer: CVPixelBuffer, at time: CMTime) {
        guard let session else { return }
        var options: [CFString: Any] = [:]
        if forceKeyframe || sinceIdr >= keyframeInterval {
            options[kVTEncodeFrameOptionKey_ForceKeyFrame] = kCFBooleanTrue
            forceKeyframe = false
        }
        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: time,
            duration: .invalid,
            frameProperties: options as CFDictionary,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
        if status != noErr { onFailure?(.encoderFailed(status: status, stage: "encode")) }
    }

    // Parameter order taken from VTCompressionSession.h: (outputCallbackRefCon, sourceFrameRefCon,
    // status, infoFlags, sampleBuffer). The refcon we supplied is first; the per-frame refcon we never
    // set is second; infoFlags is what the encoder says about this frame's delivery.
    private static let outputCallback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
        guard let refcon else { return }
        let owner = Unmanaged<H264Encoder>.fromOpaque(refcon).takeUnretainedValue()
        if status != noErr {
            owner.onFailure?(.encoderFailed(status: status, stage: "output"))
            return
        }
        owner.deliver(sampleBuffer)
    }

    fileprivate func deliver(_ sampleBuffer: CMSampleBuffer?) {
        guard let sampleBuffer, let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        let read = CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer)
        guard read == kCMBlockBufferNoErr, let pointer, length > 0 else {
            onFailure?(.unreadableSample)
            return
        }
        let bytes = [UInt8](UnsafeBufferPointer(start: UnsafeRawPointer(pointer).assumingMemoryBound(to: UInt8.self), count: length))

        // A hardware encoder normally answers in AVCC; if this one hands over Annex B, reframe it
        // here. The relay's payload container is AVCC for every source, so a viewer never has to
        // know which kind of device fed the projection.
        let looksLikeAnnexB = bytes.starts(with: [0, 0, 0, 1]) || bytes.starts(with: [0, 0, 1])
        let avcc: [UInt8]
        do {
            avcc = looksLikeAnnexB ? [UInt8](try annexBToAvcc(Data(bytes))) : bytes
        } catch {
            onFailure?(.unreadableSample)
            return
        }

        // The IDR flag comes from the sample attachments (`NotSync` absent means a sync point), and
        // the announcement comes from the parameter sets this very unit carries in band.
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]]
        let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
        let presentation = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let record = Self.record(from: avcc)
        if announced == nil, record == nil, !notSync {
            // A key frame with no parameter sets to announce is a bug in the encoder, not in here,
            // but saying so beats announcing a guess.
            onFailure?(.noParameterSets)
            return
        }
        if announced == nil, let record { announced = record }

        sinceIdr = notSync ? sinceIdr + 1 : 0
        let runStart = awaitingRunStart
        awaitingRunStart = false
        onPicture?(CodedPicture(
            avcc: Data(avcc),
            record: record ?? announced,
            ptsUs: Int64(CMTimeGetSeconds(presentation) * 1_000_000),
            isKeyframe: !notSync,
            isRunStart: runStart
        ))
    }

    /// The record a receiver configures its decoder from, rebuilt from the in-band parameter sets of
    /// an IDR — the same path the browser device takes, so both inputs are checked by the same rules.
    static func record(from avcc: [UInt8]) -> Data? {
        // The H.264 module throws when an access unit has no parameter sets; a delta picture is
        // exactly that, so "no record" here is normal and not a failure.
        guard let sets = try? parameterSets(accessUnit: Data(avcc), annexB: false) else { return nil }
        return try? AvcC(sps: sets.sps, pps: sets.pps).bytes
    }
}

/// `RPScreenRecorder.startCapture` in app scope: the phone's own surface, nothing else.
public final class AppScreenCapture: NSObject, @unchecked Sendable {
    public var sink: AppFrameSink?
    public var onFailure: ((CaptureError) -> Void)?

    private let recorder = RPScreenRecorder.shared()
    public private(set) var running = false

    public override init() {
        super.init()
    }

    public var available: Bool { recorder.isAvailable }
    public var busy: Bool { recorder.isRecording }

    public func start() throws {
        guard recorder.isAvailable else { throw CaptureError.recorderUnavailable }
        guard !recorder.isRecording else { throw CaptureError.recorderBusy }
        running = true
        recorder.startCapture(handler: { [weak self] sampleBuffer, type, error in
            guard let self, self.running else { return }
            if let error {
                self.onFailure?(.recorderFailed(error.localizedDescription))
                return
            }
            // Only the screen itself: a microphone buffer belongs to the microphone, which this
            // prototype has no consumer for, and that is why it never asks the user for one.
            guard type == .video, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            self.sink?.receive(pixelBuffer: pixelBuffer, at: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        }, completionHandler: { [weak self] error in
            guard let self else { return }
            if let error {
                self.running = false
                self.onFailure?(.recorderFailed(error.localizedDescription))
            }
        })
    }

    public func stop() {
        guard running else { return }
        running = false
        recorder.stopCapture { [weak self] error in
            if let error { self?.onFailure?(.recorderFailed(error.localizedDescription)) }
        }
    }
}
