// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// The device side of the projection socket: what an iPhone says, and what it listens for.
//
// The introduction a device makes is short. It says hello with the display it has, announces one
// video format, then pushes access units; the relay answers with start (begin), keyframe (produce an
// IDR now, because a viewer joined or fell behind), pause, view (the head unit's geometry), display
// settings, session phases, and the touch and key envelopes a head unit produced.
//
// Everything here reconnects, because a car sleeps: the socket dies without saying anything, and the
// only honest behaviour is to come back and introduce itself again.

import Foundation

/// Something the relay told this device.
public enum DeviceEvent: Sendable {
    case connected
    case disconnected
    case started(StartInstruction)
    case keyframeRequested
    case paused(Bool)
    case view(ViewInstruction)
    case displaySettings(DisplaySettingsInstruction)
    case session(SessionState)
    case touch([TouchContact])
    case key(code: UInt16, down: Bool)
    case relayError(code: String, message: String)
    case failed(String)
}

public struct RelayEndpoint: Equatable, Sendable {
    public var host: String
    public var port: Int?
    public var tls: Bool
    public var token: String

    public init(host: String, port: Int? = nil, tls: Bool = false, token: String) {
        self.host = host; self.port = port; self.tls = tls; self.token = token
    }

    /// The device socket, with the pairing token in the query. A WebSocket cannot prompt for a
    /// password, so in a prototype a token in the URL is what the pairing step can look like.
    public func socketURL(path: String = "/input-wire") -> URL? {
        var components = URLComponents()
        components.scheme = tls ? "wss" : "ws"
        components.host = host
        components.port = port
        components.path = path
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url
    }

    public func httpURL(path: String) -> URL? {
        var components = URLComponents()
        components.scheme = tls ? "https" : "http"
        components.host = host
        components.port = port
        components.path = path
        return components.url
    }
}

public final class DeviceConnection: @unchecked Sendable {
    public let endpoint: RelayEndpoint
    public var events: ((DeviceEvent) -> Void)?
    /// Answers the socket opening with the messages that introduce this device: hello, then the
    /// format the encoder is about to produce. Called again on every reconnect, because a relay that
    /// restarted knows nothing about us.
    public var introduction: (() -> [ControlMessage])?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var sequence: [WireKind: UInt32] = [:]
    private var wanted = false

    public init(endpoint: RelayEndpoint) {
        self.endpoint = endpoint
    }

    public var isConnected: Bool { task?.state == .running }

    public func start() {
        guard let url = endpoint.socketURL() else {
            events?(.failed(DeviceError.badEndpoint(host: endpoint.host).description))
            return
        }
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        let made = URLSession(configuration: configuration)
        self.session = made
        let task = made.webSocketTask(with: url)
        self.task = task
        wanted = true
        task.resume()
        receiveNext()
        events?(.connected)
        for message in introduction?() ?? [] { send(message) }
    }

    public func stop() {
        wanted = false
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.finishTasksAndInvalidate()
        session = nil
        events?(.disconnected)
    }

    // MARK: outbound

    public func send(_ message: ControlMessage) {
        let encoded: Data
        do {
            encoded = try MessageCodec.encode(message, direction: .deviceToRelay)
        } catch {
            // An outgoing message the codec refuses is a bug in this file, not a network problem.
            events?(.failed("\(error)"))
            return
        }
        task?.send(.string(String(decoding: encoded, as: UTF8.self))) { [weak self] error in
            if let error, self?.wanted == true { self?.events?(.failed(error.localizedDescription)) }
        }
    }

    /// One finished access unit, AVCC framed, as the wire requires for every kind of source.
    public func sendSample(
        _ avcc: Data,
        presentationTimeUs: Int64,
        isKeyFrame: Bool,
        isRunStart: Bool = false,
        kind: WireKind = .video,
        stream: UInt8 = 0
    ) {
        var flags: WireFlags = isKeyFrame ? .keyframe : []
        if isRunStart { flags.insert(.gap) }
        let header = WireHeader(
            kind: kind,
            stream: stream,
            flags: flags,
            sequence: next(sequenceFor: kind),
            ptsUs: presentationTimeUs,
            senderClockUs: Self.nowUs()
        )
        task?.send(.data(wireMessage(header, avcc))) { [weak self] error in
            if let error, self?.wanted == true { self?.events?(.failed(error.localizedDescription)) }
        }
    }

    private func next(sequenceFor kind: WireKind) -> UInt32 {
        let value = sequence[kind] ?? 0
        sequence[kind] = (value + 1) % 0x1_0000_0000
        return value
    }

    /// Microseconds since the Unix epoch. A receiver compares its own clock to this one, which is
    /// what turns "how far behind live am I" into a subtraction instead of a guess.
    public static func nowUs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000_000) }

    // MARK: inbound

    private func receiveNext() {
        guard wanted, let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                guard self.wanted else { return }
                // A device that cannot read what arrived must say so rather than go quiet: a black
                // car screen with a silent phone is the worst possible failure mode.
                self.events?(.failed("socket: \(error.localizedDescription)"))
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleControl(text)
                case .data(let bytes):
                    self.handleEnvelope(bytes)
                @unknown default:
                    self.events?(.failed("unknown websocket frame kind"))
                }
                self.receiveNext()
            }
        }
    }

    private func handleControl(_ text: String) {
        let message: ControlMessage
        do {
            message = try MessageCodec.decode(text: text, direction: .relayToDevice)
        } catch {
            events?(.failed("unreadable from the relay: \(error), text was \(text.prefix(120))"))
            return
        }
        switch message {
        case .start(let start): events?(.started(start))
        case .keyframe: events?(.keyframeRequested)
        case .pause(_, let paused): events?(.paused(paused))
        case .view(let view): events?(.view(view))
        case .displaySettings(let settings): events?(.displaySettings(settings))
        case .session(let session): events?(.session(session))
        case .welcome: events?(.connected)
        case .error(let code, let message): events?(.relayError(code: code, message: message))
        case .pong(let times):
            // The clock exchange is the relay's own arithmetic; a device only needs the round trip.
            if let t0 = Int64(times.t0Us), let t2 = Int64(times.t2Us) {
                events?(.relayError(code: "rtt", message: "\((t2 - t0) / 1000) ms round trip"))
            }
        default:
            events?(.failed("the relay sent \(message.type), which a device does not handle"))
        }
    }

    private func handleEnvelope(_ bytes: Data) {
        do {
            let header = try readWireHeader(bytes)
            let payload = Data(bytes.dropFirst(wireHeaderSize))
            switch header.kind {
            case .touch: events?(.touch(try decodeTouch(payload)))
            case .key:
                let press = try decodeKey(payload)
                events?(.key(code: press.code, down: press.down))
            default:
                events?(.failed(DeviceError.unexpectedKind(kind: header.kind).description))
            }
        } catch {
            events?(.failed("bad envelope from the relay: \(error)"))
        }
    }
}

public enum DeviceError: Error, CustomStringConvertible {
    case badEndpoint(host: String)
    case unexpectedKind(kind: WireKind)
    case noRelay(String)
    case tokenRejected

    public var description: String {
        switch self {
        case .badEndpoint(let host): return "the relay address \(host) does not make a usable ws:// URL"
        case .unexpectedKind(let kind): return "a device receives touch and keys, not kind \(kind.rawValue)"
        case .noRelay(let detail): return "the relay did not answer: \(detail)"
        case .tokenRejected: return "the relay refused this pairing token"
        }
    }
}

/// A cheap question to ask before a phone commits to a capture session: is anything listening at
/// that address at all. The pairing token is only verified when the socket opens (the relay answers
/// the upgrade with 401 otherwise), so this proves reachability and nothing more — which is exactly
/// what it claims.
public enum RelayProbe {
    public struct Info: Decodable {
        public let name: String
        public let version: String
        public let clockUs: String
    }

    public static func version(_ endpoint: RelayEndpoint, timeout: TimeInterval = 3) async -> Result<Info, Error> {
        guard let url = endpoint.httpURL(path: "/version") else { return .failure(DeviceError.badEndpoint(host: endpoint.host)) }
        let made = URLSession(configuration: .default)
        defer { made.invalidateAndCancel() }
        let request = URLRequest(url: url, timeoutInterval: timeout)
        do {
            let (data, response) = try await made.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failure(DeviceError.noRelay(url.absoluteString)) }
            guard http.statusCode == 200 else {
                return .failure(http.statusCode == 401 ? DeviceError.tokenRejected : DeviceError.noRelay("HTTP \(http.statusCode)"))
            }
            return .success(try JSONDecoder().decode(Info.self, from: data))
        } catch {
            return .failure(error)
        }
    }
}
