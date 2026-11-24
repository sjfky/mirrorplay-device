// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Byte-level parity with `src/protocol/binary.js`, asserted against the fixtures that
// `scripts/ios-fixtures.mjs` writes from that module. This is not a test of Swift syntax: it is the
// guard that an iPhone and the relay do not have a quiet disagreement about where the reserved byte
// sits, what a contact costs in precision, or which messages a device is even allowed to send.
//
// Run `node scripts/ios-fixtures.mjs` in the repository root first; without the fixtures these tests
// skip rather than pass vacuously.

import Foundation
import XCTest
@testable import MirrorplayWire

// #filePath is this file's own path, so three levels have to go before Fixtures is a sibling:
// Tests/<target>/<this file>, Tests, device-ios. Getting it wrong does not fail anything — every test
// just skips, which is how a byte-parity suite stops being one. testFixturesArePresent fails loudly
// if the directory ever stops resolving.
private let fixturesDirectory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // Tests/<target>
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // device-ios
    .appendingPathComponent("Fixtures")

private func fixture(_ name: String) throws -> Data {
    let url = fixturesDirectory.appendingPathComponent(name)
    guard let data = try? Data(contentsOf: url) else {
        throw XCTSkip("missing fixture \(url.path); run `node scripts/ios-fixtures.mjs` in the repository root")
    }
    return data
}

/// The parts of manifest.json these tests care about. Unknown keys are left undecoded on purpose: a
/// fixture growing a field must not break the parity checks that already exist.
private struct Manifest: Decodable {
    struct Envelope: Decodable {
        let kind: UInt8
        let stream: UInt8
        let flags: UInt8
        let sequence: UInt32
        let ptsUs: Int64
        let senderClockUs: Int64
    }

    struct Contact: Decodable { let id: UInt8; let pressed: Bool; let x: Double; let y: Double }
    struct KeyPress: Decodable { let code: UInt16; let down: Bool }

    struct VideoFormatMessage: Decodable {
        let type: String
        let screen: Int
        let format: Format
        struct Format: Decodable {
            let codec: String
            let codecString: String
            let config: String
            let width: Int
            let height: Int
        }
    }

    struct Messages: Decodable {
        // The device's hello carries displays and decoders the relay only reads, so it is kept as
        // raw JSON here and only the fields with protocol meaning are pulled out.
        let hello: [String: AnyCodable]
        let videoFormat: VideoFormatMessage
    }

    let codec: String
    let size: [Int]
    let fps: Int
    let encoder: String
    let avcC: String
    let envelope: Envelope
    let touch: [Contact]
    let key: KeyPress
    let messages: Messages
}

private struct AnyCodable: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { value = NSNull() }
        else if let string = try? container.decode(String.self) { value = string }
        else if let number = try? container.decode(Double.self) { value = number }
        else if let boolean = try? container.decode(Bool.self) { value = boolean }
        else if let object = try? container.decode([String: AnyCodable].self) { value = object }
        else if let array = try? container.decode([AnyCodable].self) { value = array }
        else { value = NSNull() }
    }

    var string: String? { value as? String }
    var int: Int? { (value as? Double).map { Int($0) } }
}

private func manifest() throws -> Manifest {
    try JSONDecoder().decode(Manifest.self, from: fixture("manifest.json"))
}

final class WireFormatFixtureTests: XCTestCase {
    private static let required = ["manifest.json", "sps.bin", "pps.bin", "avcC.bin", "key-annexb.bin", "key-avcc.bin", "delta-avcc.bin", "key-envelope.bin", "touch.bin", "key.bin"]

    /// This suite exists to prove that Swift and JavaScript put the same bytes on the wire. If the
    /// fixtures are missing, nothing was proved, so that has to be a failure rather than a wall of
    /// grey skip marks: a suite that skips its way to green is worse than no suite at all.
    func testFixturesArePresent() {
        let missing = WireFormatFixtureTests.required.filter {
            !FileManager.default.fileExists(atPath: fixturesDirectory.appendingPathComponent($0).path)
        }
        XCTAssertTrue(missing.isEmpty, "missing fixtures: \(missing.joined(separator: ", ")) — run `npm run fixtures:ios` in the repository root")
    }
    func testHeaderIsTwentyFourBytesAndRoundTrips() throws {
        let envelope = try fixture("key-envelope.bin")
        XCTAssertGreaterThanOrEqual(envelope.count, wireHeaderSize)
        let header = try readWireHeader(envelope)
        XCTAssertEqual(Data([UInt8](wireHeaderBytes(header))), envelope.prefix(wireHeaderSize), "read then write must give the same 24 bytes back")
        let avcc = try fixture("key-avcc.bin")
        XCTAssertEqual(envelope.count, wireHeaderSize + avcc.count, "an envelope is a header plus exactly one access unit")
    }

    func testTheManifestAndTheBytesDescribeTheSameEnvelope() throws {
        let manifest = try manifest()
        let envelope = try fixture("key-envelope.bin")
        let avcc = try fixture("key-avcc.bin")
        let header = try readWireHeader(envelope)
        XCTAssertEqual(header.kind, .video)
        XCTAssertEqual(header.kind.rawValue, manifest.envelope.kind)
        XCTAssertEqual(header.stream, manifest.envelope.stream)
        XCTAssertEqual(header.flags, [.keyframe, .gap], "the first frame of a run is both a start point and a discontinuity")
        XCTAssertEqual(header.flags.rawValue, manifest.envelope.flags)
        XCTAssertEqual(header.sequence, manifest.envelope.sequence)
        XCTAssertEqual(header.ptsUs, manifest.envelope.ptsUs)
        XCTAssertEqual(header.senderClockUs, manifest.envelope.senderClockUs)
        XCTAssertEqual([UInt8](envelope.dropFirst(wireHeaderSize)), [UInt8](avcc), "and the payload went through unchanged")
    }

    func testTouchPayloadIsTheSameNineteenBytes() throws {
        let manifest = try manifest()
        let contacts = manifest.touch.map { TouchContact(id: $0.id, pressed: $0.pressed, x: $0.x, y: $0.y) }
        let expected = Array(try fixture("touch.bin").suffix(1 + contacts.count * 6))
        let encoded = try encodeTouch(contacts)
        XCTAssertEqual([UInt8](encoded), expected, "same contacts, same bytes; a different rounding mode would show up here")
        XCTAssertEqual(encoded.count, 1 + contacts.count * 6)

        let decoded = try decodeTouch(encoded)
        XCTAssertEqual(decoded.count, contacts.count)
        for (index, contact) in decoded.enumerated() {
            XCTAssertEqual(contact.id, contacts[index].id)
            XCTAssertEqual(contact.pressed, contacts[index].pressed)
            // Sixteen bits is the whole promise: within one quantum of what was sent, and the same
            // quantum the relay's own codec chose.
            XCTAssertEqual(contact.x, contacts[index].x, accuracy: 1.0 / 65535.0)
            XCTAssertEqual(contact.y, contacts[index].y, accuracy: 1.0 / 65535.0)
            XCTAssertEqual(UInt16((contact.x * 65535).rounded()), UInt16((contacts[index].x * 65535).rounded()))
        }
    }

    func testTouchRejectsWhatTheRelayWouldReject() {
        let contact = TouchContact(id: 0, pressed: true, x: 0.5, y: 0.5)
        XCTAssertThrowsError(try encodeTouch(Array(repeating: contact, count: wireMaxContacts + 1)))
        XCTAssertThrowsError(try encodeTouch([contact, contact]))
        XCTAssertThrowsError(try encodeTouch([TouchContact(id: 0, pressed: true, x: 1.2, y: 0)]))
        XCTAssertThrowsError(try decodeTouch(Data([2, 0, 1, 0, 0, 0, 0])))
        XCTAssertEqual(try decodeTouch(Data([0])).count, 0, "an empty set is a valid message: every finger lifted")
    }

    func testKeyPayloadIsThreeBytesAndFailsOtherwise() throws {
        let manifest = try manifest()
        let fixturePayload = Array(try fixture("key.bin").suffix(3))
        let code = try XCTUnwrap(KeyCode(rawValue: manifest.key.code))
        XCTAssertEqual([UInt8](encodeKey(code, down: manifest.key.down)), fixturePayload)

        let decoded = try decodeKey(Data(fixturePayload))
        XCTAssertEqual(decoded.code, manifest.key.code)
        XCTAssertEqual(decoded.down, manifest.key.down)
        XCTAssertThrowsError(try decodeKey(Data([99, 0, 1])), "an unknown code is a protocol error, not a no-op")
        XCTAssertThrowsError(try decodeKey(Data([1, 0])), "a truncated payload must not be guessed at")
        XCTAssertThrowsError(try decodeKey(Data([1, 0, 2])), "a down flag is one bit wide")
    }

    func testHeadersWithImpossibleBytesAreRefused() throws {
        let base = try readWireHeader(fixture("key-envelope.bin"))
        var bytes = [UInt8](wireHeaderBytes(base))

        bytes[0] = 99
        XCTAssertThrowsError(try readWireHeader(Data(bytes)), "unknown kind")
        bytes[0] = WireKind.video.rawValue

        bytes[3] = 1
        XCTAssertThrowsError(try readWireHeader(Data(bytes)), "the reserved byte is not ours to use")
        bytes[3] = 0

        bytes[2] = 4
        XCTAssertThrowsError(try readWireHeader(Data(bytes)), "only two flags exist")
        bytes[2] = base.flags.rawValue

        bytes[0] = WireKind.microphone.rawValue
        let mic = try readWireHeader(Data(bytes))
        XCTAssertEqual(mic.kind, .microphone, "the kind exists on the wire even though this build has no consumer for it")
    }

    func testDirectionsMatchTheRelaysVocabulary() throws {
        let manifest = try manifest()
        XCTAssertEqual(manifest.messages.videoFormat.type, "video-format")
        XCTAssertTrue(MessageDirection.deviceToRelay.allows("hello"))
        XCTAssertTrue(MessageDirection.deviceToRelay.allows("video-format"))
        XCTAssertTrue(MessageDirection.deviceToRelay.allows("restart"))
        XCTAssertFalse(MessageDirection.deviceToRelay.allows("keyframe"), "only a viewer asks for a key frame")
        XCTAssertFalse(MessageDirection.deviceToRelay.allows("welcome"), "the relay does not receive its own message")
        XCTAssertTrue(MessageDirection.relayToDevice.allows("start"))
        XCTAssertTrue(MessageDirection.relayToDevice.allows("view"))
        XCTAssertFalse(MessageDirection.relayToDevice.allows("video-format"), "a device is told to start, it does not receive its own announcement")
    }

    func testTheAnnouncedFormatDecodesIntoThisVocabulary() throws {
        let manifest = try manifest()
        let record = manifest.messages.videoFormat.format
        XCTAssertEqual(record.codec, "H264")
        XCTAssertEqual(record.codecString, manifest.codec)
        XCTAssertEqual(record.width, manifest.size[0])
        XCTAssertEqual(record.height, manifest.size[1])
        XCTAssertEqual(record.config, Data(base64Encoded: record.config).map { $0.base64EncodedString() }, "base64 of itself, i.e. valid base64")
        XCTAssertEqual(manifest.messages.hello["source"]?.string, "mirrorplay iOS device")

        // The same record read back as a Swift message, then written again: nothing in the round trip
        // may change, because the relay will hash these bytes against its own state.
        let data = try MessageCodec.encode(.videoFormat(screen: 0, format: VideoFormatRecord(
            codec: .h264, codecString: record.codecString, config: record.config, width: record.width, height: record.height, fpsHint: Double(manifest.fps)
        )), direction: .deviceToRelay)
        let decoded = try MessageCodec.decode(data, direction: .deviceToRelay)
        guard case .videoFormat(let screen, let format) = decoded else { return XCTFail("decoded as \(decoded)") }
        XCTAssertEqual(screen, 0)
        XCTAssertEqual(format?.codecString, record.codecString)
        XCTAssertEqual(format?.config, record.config)
        XCTAssertEqual(format?.width, record.width)
    }

    func testUnknownMessageTypesAreRefusedLoudly() {
        XCTAssertThrowsError(try MessageCodec.decode(Data(#"{"type":"telepathy"}"#.utf8)))
        XCTAssertThrowsError(try MessageCodec.decode(Data("not json".utf8)))
        XCTAssertThrowsError(try MessageCodec.decode(Data(#"{"screen":0}"#.utf8)), "a message without a type is not a message")
        // A keyframe message arriving where only device traffic belongs must be refused by direction.
        XCTAssertThrowsError(try MessageCodec.encode(.keyframe(screen: 0), direction: .deviceToRelay))
    }

}
