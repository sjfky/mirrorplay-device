// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// The JSON control messages of the projection protocol, Swift side. Text frames carry these; binary
// frames carry the envelope in WireFormat.swift. Both travel on the same WebSocket.
//
//   device → relay   hello, video-format, audio-format, restart
//   relay → device   welcome, session, start, keyframe, view, display-settings, pause, pong, error
//
// 64-bit values are decimal strings: JSON numbers lose precision above 2^53 and a clock reading is
// worth more than a tidy number.
//
// An unknown `type` is an error rather than a catch-all case, so a relay that starts speaking
// something new is noticed on the first message instead of being quietly ignored. Mirrors
// `src/protocol/json.js`; FixtureTests.swift asserts these shapes against messages that module wrote.

import Foundation

// MARK: - pieces

public struct SafeAreaValue: Codable, Equatable, Sendable {
    public var top: Int
    public var right: Int
    public var bottom: Int
    public var left: Int
    public init(top: Int = 0, right: Int = 0, bottom: Int = 0, left: Int = 0) {
        self.top = top; self.right = right; self.bottom = bottom; self.left = left
    }
}

public struct SizeValue: Codable, Equatable, Sendable {
    public var width: Int
    public var height: Int
    public init(width: Int, height: Int) { self.width = width; self.height = height }
}

public struct DisplayReport: Codable, Equatable, Sendable {
    public var screen: Int
    public var width: Int
    public var height: Int
    public var dpr: Double
    public var refreshHz: Double
    public var safeArea: SafeAreaValue
    public var viewport: SizeValue?
    public var fullscreen: Bool?
    public var fullscreenPreferred: Bool?

    public init(screen: Int = 0, width: Int, height: Int, dpr: Double, refreshHz: Double, safeArea: SafeAreaValue = SafeAreaValue(),
                viewport: SizeValue? = nil, fullscreen: Bool? = nil, fullscreenPreferred: Bool? = nil) {
        self.screen = screen; self.width = width; self.height = height; self.dpr = dpr; self.refreshHz = refreshHz
        self.safeArea = safeArea; self.viewport = viewport; self.fullscreen = fullscreen; self.fullscreenPreferred = fullscreenPreferred
    }
}

public struct DecoderReport: Codable, Equatable, Sendable {
    public var codecString: String
    public var hardware: Bool
    public init(codecString: String, hardware: Bool) { self.codecString = codecString; self.hardware = hardware }
}

public enum AudioCodec: String, Codable, Sendable, CaseIterable {
    case aacLC = "AAC_LC"
    case opus = "OPUS"
    case pcm = "PCM_S16LE"
}

public enum VideoCodecName: String, Codable, Equatable, Sendable {
    case h264 = "H264"
    case h265 = "H265"
}

public struct VideoFormatRecord: Codable, Equatable, Sendable {
    public var codec: VideoCodecName
    public var codecString: String
    /// base64 of the decoder configuration record: avcC for H.264, hvcC for HEVC.
    public var config: String
    public var width: Int
    public var height: Int
    public var fpsHint: Double?

    public init(codec: VideoCodecName = .h264, codecString: String, config: String, width: Int, height: Int, fpsHint: Double? = nil) {
        self.codec = codec; self.codecString = codecString; self.config = config; self.width = width; self.height = height; self.fpsHint = fpsHint
    }
}

public struct AudioFormatRecord: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Equatable, Sendable {
        case media = "MEDIA", alert = "ALERT", voice = "VOICE", telephony = "TELEPHONY", other = "OTHER"
    }

    public var role: Role
    public var codec: AudioCodec
    public var sampleRate: Int
    public var channels: Int
    public var config: String?
}

public struct SessionState: Codable, Equatable, Sendable {
    public enum Phase: String, Codable, Equatable, Sendable {
        case connecting = "CONNECTING", active = "ACTIVE", reconnecting = "RECONNECTING", ended = "ENDED"
    }

    public var id: String
    public var phase: Phase
    public var reason: String?

    public init(id: String, phase: Phase, reason: String? = nil) {
        self.id = id; self.phase = phase; self.reason = reason
    }
}

public struct RelayIdentity: Codable, Equatable, Sendable {
    public var name: String
    public var version: String
}

public enum DisplayResolution: String, Codable, Equatable, Sendable {
    case auto, native
    case p1080 = "1080p"
    case p720 = "720p"
    case screen
}

public enum FrameRatePreference: String, Codable, Equatable, Sendable, CaseIterable {
    case auto = "AUTO"
    case fps30 = "FPS_30", fps35 = "FPS_35", fps40 = "FPS_40", fps45 = "FPS_45"
    case fps50 = "FPS_50", fps55 = "FPS_55", fps60 = "FPS_60"
}

public struct ViewAreaValue: Codable, Equatable, Sendable {
    public var x: Int
    public var y: Int
    public var width: Int
    public var height: Int
    public var canvasWidth: Int
    public var canvasHeight: Int
}

// MARK: - messages

public struct HelloMessage: Codable, Equatable, Sendable {
    public var type: String = "hello"
    public var version: Int = 0
    public var token: String
    public var decoders: [DecoderReport]
    public var displays: [DisplayReport]
    public var maxTouchContacts: Int
    public var audio: [AudioCodec]
    public var microphone: Bool
    public var playback: String?
    public var videoCodec: String?
    /// What this input calls itself, so the relay's operator page can name it.
    public var source: String?
}

public struct WelcomeMessage: Codable, Equatable, Sendable {
    public var type: String = "welcome"
    public var version: Int
    public var clientId: String
    public var session: SessionState
    /// The project the wire format comes from, not a socket address.
    public var sourceUrl: String
    public var attribution: String
    public var projectUrl: String
    public var relay: RelayIdentity?
    public var receiverBuild: String?
    public var features: [String]?
}

public struct StartInstruction: Codable, Equatable, Sendable {
    public var type: String = "start"
    public var videoFormat: VideoFormatRecord?
    public var audioFormat: AudioFormatRecord?
    public var scene: String?
}

public struct ViewInstruction: Codable, Equatable, Sendable {
    public var type: String = "view"
    public var displays: [DisplayReport]
    public var viewArea: ViewAreaValue?
    public var videoCodec: String?
}

public struct DisplaySettingsInstruction: Codable, Equatable, Sendable {
    public var type: String = "display-settings"
    public var resolution: DisplayResolution
    public var screenWidth: Int
    public var videoCodec: String?
    public var frameRate: FrameRatePreference?
}

public struct PongTimes: Codable, Equatable, Sendable {
    public var type: String = "pong"
    public var t0Us: String
    public var t1Us: String
    public var t2Us: String
}

/// One control message, either direction. The payload structs carry their own `type`, so encoding an
/// envelope writes exactly the fields the shape declares and nothing else.
public enum ControlMessage: Equatable, Sendable {
    case hello(HelloMessage)
    case welcome(WelcomeMessage)
    case session(SessionState)
    case videoFormat(screen: Int, format: VideoFormatRecord?)
    case audioFormat(stream: Int, format: AudioFormatRecord?)
    case start(StartInstruction)
    case view(ViewInstruction)
    case keyframe(screen: Int)
    case displaySettings(DisplaySettingsInstruction)
    case pause(screen: Int, paused: Bool)
    case ping(t0Us: String)
    case pong(PongTimes)
    case error(code: String, message: String)
    case restart

    public var type: String {
        switch self {
        case .hello: return "hello"
        case .welcome: return "welcome"
        case .session: return "session"
        case .videoFormat: return "video-format"
        case .audioFormat: return "audio-format"
        case .start: return "start"
        case .view: return "view"
        case .keyframe: return "keyframe"
        case .displaySettings: return "display-settings"
        case .pause: return "pause"
        case .ping: return "ping"
        case .pong: return "pong"
        case .error: return "error"
        case .restart: return "restart"
        }
    }
}

public enum ProtocolError: Error, CustomStringConvertible {
    case notAnObject
    case missingTypeField
    case unknownType(String)
    case wrongDirection(type: String, direction: MessageDirection)
    case malformed(type: String, underlying: String)

    public var description: String {
        switch self {
        case .notAnObject: return "a control message must be a JSON object"
        case .missingTypeField: return "a control message needs a type"
        case .unknownType(let type): return "unknown message type \(type)"
        case .wrongDirection(let type, let direction): return "\(type) is not a \( direction.name) message"
        case .malformed(let type, let reason): return "malformed \(type) message: \(reason)"
        }
    }
}

public enum MessageDirection: Sendable {
    case deviceToRelay
    case relayToDevice

    public var name: String {
        switch self {
        case .deviceToRelay: return "device-to-relay"
        case .relayToDevice: return "relay-to-device"
        }
    }

    /// What each side may send, mirroring `DIRECTIONS` in the JavaScript module.
    public func allows(_ type: String) -> Bool {
        switch self {
        case .deviceToRelay:
            return ["hello", "video-format", "audio-format", "restart", "ping", "pong", "error"].contains(type)
        case .relayToDevice:
            return ["welcome", "start", "keyframe", "view", "display-settings", "pause", "session", "ping", "pong", "error"].contains(type)
        }
    }
}

// MARK: - coding

extension ControlMessage: Codable {
    private enum CodingKeys: String, CodingKey { case type, session, screen, format, stream, paused, t0Us, code, message }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.type) else { throw ProtocolError.missingTypeField }
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "hello":
            self = .hello(try HelloMessage(from: decoder).require(type: type))
        case "welcome":
            self = .welcome(try WelcomeMessage(from: decoder).require(type: type))
        case "session":
            self = .session(try container.decode(SessionState.self, forKey: .session))
        case "video-format":
            self = .videoFormat(screen: try container.decode(Int.self, forKey: .screen),
                                format: try container.decodeIfPresent(VideoFormatRecord.self, forKey: .format))
        case "audio-format":
            self = .audioFormat(stream: try container.decode(Int.self, forKey: .stream),
                                format: try container.decodeIfPresent(AudioFormatRecord.self, forKey: .format))
        case "start":
            self = .start(try StartInstruction(from: decoder).require(type: type))
        case "view":
            self = .view(try ViewInstruction(from: decoder).require(type: type))
        case "display-settings":
            self = .displaySettings(try DisplaySettingsInstruction(from: decoder).require(type: type))
        case "keyframe":
            self = .keyframe(screen: try container.decode(Int.self, forKey: .screen))
        case "pause":
            self = .pause(screen: try container.decode(Int.self, forKey: .screen),
                          paused: try container.decode(Bool.self, forKey: .paused))
        case "ping":
            self = .ping(t0Us: try container.decode(String.self, forKey: .t0Us))
        case "pong":
            self = .pong(try PongTimes(from: decoder).require(type: type))
        case "error":
            self = .error(code: try container.decode(String.self, forKey: .code),
                          message: try container.decode(String.self, forKey: .message))
        case "restart":
            self = .restart
        default:
            throw ProtocolError.unknownType(type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .hello(let hello): try hello.encode(to: encoder)
        case .welcome(let welcome): try welcome.encode(to: encoder)
        case .session(let session):
            try container.encode("session", forKey: .type)
            try container.encode(session, forKey: .session)
        case .videoFormat(let screen, let format):
            try container.encode("video-format", forKey: .type)
            try container.encode(screen, forKey: .screen)
            try container.encode(format, forKey: .format)
        case .audioFormat(let stream, let format):
            try container.encode("audio-format", forKey: .type)
            try container.encode(stream, forKey: .stream)
            try container.encode(format, forKey: .format)
        case .start(let start): try start.encode(to: encoder)
        case .view(let view): try view.encode(to: encoder)
        case .displaySettings(let settings): try settings.encode(to: encoder)
        case .keyframe(let screen):
            try container.encode("keyframe", forKey: .type)
            try container.encode(screen, forKey: .screen)
        case .pause(let screen, let paused):
            try container.encode("pause", forKey: .type)
            try container.encode(screen, forKey: .screen)
            try container.encode(paused, forKey: .paused)
        case .ping(let t0Us):
            try container.encode("ping", forKey: .type)
            try container.encode(t0Us, forKey: .t0Us)
        case .pong(let times): try times.encode(to: encoder)
        case .error(let code, let message):
            try container.encode("error", forKey: .type)
            try container.encode(code, forKey: .code)
            try container.encode(message, forKey: .message)
        case .restart:
            try container.encode("restart", forKey: .type)
        }
    }
}

private protocol TypedCodable: Codable { var type: String { get } }

extension TypedCodable {
    /// A payload decoded from a message whose `type` we already switched on must agree about it.
    func require(type: String) throws -> Self {
        guard self.type == type else { throw ProtocolError.malformed(type: type, underlying: "expected type \(self.type)") }
        return self
    }
}

extension HelloMessage: TypedCodable {}
extension WelcomeMessage: TypedCodable {}
extension StartInstruction: TypedCodable {}
extension ViewInstruction: TypedCodable {}
extension DisplaySettingsInstruction: TypedCodable {}
extension PongTimes: TypedCodable {}

public enum MessageCodec {
    public static func encode(_ message: ControlMessage, direction: MessageDirection? = nil) throws -> Data {
        if let direction, !direction.allows(message.type) {
            throw ProtocolError.wrongDirection(type: message.type, direction: direction)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(message)
    }

    public static func encodeString(_ message: ControlMessage, direction: MessageDirection? = nil) throws -> String {
        String(decoding: try encode(message, direction: direction), as: UTF8.self)
    }

    public static func decode(_ data: Data, direction: MessageDirection? = nil) throws -> ControlMessage {
        let message: ControlMessage
        do {
            message = try JSONDecoder().decode(ControlMessage.self, from: data)
        } catch let error as ProtocolError {
            throw error
        } catch {
            // A JSON shape that did not fit any variant: say which type was at fault when we can.
            if let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let type = object["type"] as? String {
                throw ProtocolError.malformed(type: type, underlying: String(describing: error))
            }
            throw ProtocolError.notAnObject
        }
        if let direction, !direction.allows(message.type) {
            throw ProtocolError.wrongDirection(type: message.type, direction: direction)
        }
        return message
    }

    public static func decode(text: String, direction: MessageDirection? = nil) throws -> ControlMessage {
        try decode(Data(text.utf8), direction: direction)
    }
}
