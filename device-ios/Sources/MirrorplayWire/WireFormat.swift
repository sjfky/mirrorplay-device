// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// The projection wire format, Swift side.
//
// A message is a 24-byte little-endian header followed by its payload:
//
//   0  kind    u8   1 video  2 audio  3 microphone  16 touch  17 key
//   1  stream  u8   audio/microphone stream index; 0 for video, touch and key
//   2  flags   u8   bit0 key frame, bit1 discontinuity (the viewer must flush and wait)
//   3          u8   reserved, always zero
//   4  sequence u32 per-kind counter
//   8  ptsUs     i64 presentation time, microseconds
//   16 senderClockUs i64 sender clock at the moment the message was produced
//
// Video payloads are AVCC access units: 4-byte big-endian length + NAL, repeated. Touch payloads
// are a count byte plus six bytes per contact. Key payloads are three bytes.
//
// Every rule here is mirrored from `src/protocol/binary.js` in this repository, and
// `Tests/MirrorplayWireTests/FixtureTests.swift` asserts this file against byte fixtures generated
// by that same JavaScript. Two implementations that only agree in prose are two implementations that
// will disagree on the first car that powers down oddly.

import Foundation

public enum WireKind: UInt8, Sendable {
    case video = 1
    case audio = 2
    case microphone = 3
    case touch = 16
    case key = 17
}

/// A key frame the viewer can start from, and a discontinuity it must flush for.
public struct WireFlags: OptionSet, Sendable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue = rawValue }
    public static let keyframe = WireFlags(rawValue: 1 << 0)
    public static let gap = WireFlags(rawValue: 1 << 1)
    public static let none = WireFlags([])
}

public enum KeyCode: UInt16, CaseIterable, Sendable {
    case home = 0, back = 1, select = 2
    case knobLeft = 3, knobRight = 4, knobUp = 5, knobDown = 6
    case playPause = 7, next = 8, previous = 9, voice = 10
}

public struct WireHeader: Sendable, Equatable {
    public var kind: WireKind
    public var stream: UInt8
    public var flags: WireFlags
    public var sequence: UInt32
    public var ptsUs: Int64
    public var senderClockUs: Int64

    public init(kind: WireKind, stream: UInt8 = 0, flags: WireFlags = .none, sequence: UInt32 = 0, ptsUs: Int64 = 0, senderClockUs: Int64 = 0) {
        self.kind = kind
        self.stream = stream
        self.flags = flags
        self.sequence = sequence
        self.ptsUs = ptsUs
        self.senderClockUs = senderClockUs
    }
}

public struct TouchContact: Sendable, Equatable {
    /// 0…9, the slot the head unit reports this finger in.
    public var id: UInt8
    public var pressed: Bool
    /// Picture coordinates, the letterbox already removed: 0 is the left/top edge of the video.
    public var x: Double
    public var y: Double

    public init(id: UInt8, pressed: Bool, x: Double, y: Double) {
        self.id = id
        self.pressed = pressed
        self.x = x
        self.y = y
    }
}

public enum WireError: Error, CustomStringConvertible {
    case truncatedHeader
    case reservedByteNotEmpty
    case unknownKind(UInt8)
    case unknownFlags(UInt8)
    case touchLength(expected: Int, found: Int)
    case tooManyContacts(Int)
    case duplicateContact(UInt8)
    case contactIdOutOfRange(UInt8)
    case coordinateOutOfRange(id: UInt8, x: Double, y: Double)
    case keyPayloadLength(Int)
    case unknownKey(UInt16)

    public var description: String {
        switch self {
        case .truncatedHeader: return "header is shorter than 24 bytes"
        case .reservedByteNotEmpty: return "the reserved header byte must be zero"
        case .unknownKind(let v): return "unknown message kind \(v)"
        case .unknownFlags(let v): return "unknown header flags \(v)"
        case .touchLength(let expected, let found): return "touch payload should be \(expected) bytes, found \(found)"
        case .tooManyContacts(let n): return "\(n) contacts, and the wire carries ten at most"
        case .duplicateContact(let id): return "two contacts share id \(id)"
        case .contactIdOutOfRange(let id): return "contact id \(id) is outside 0…9"
        case .coordinateOutOfRange(let id, let x, let y): return "contact \(id) is outside the picture (x=\(x), y=\(y))"
        case .keyPayloadLength(let n): return "a key payload is three bytes, found \(n)"
        case .unknownKey(let v): return "unknown key code \(v)"
        }
    }
}

public let wireHeaderSize = 24
public let wireMaxContacts = 10

private func le16(_ value: UInt16) -> [UInt8] { [UInt8(value & 0xff), UInt8(value >> 8)] }
private func le32(_ value: UInt32) -> [UInt8] { [UInt8(value & 0xff), UInt8((value >> 8) & 0xff), UInt8((value >> 16) & 0xff), UInt8(value >> 24)] }
private func le64(_ value: Int64) -> [UInt8] {
    var pattern = value.littleEndian
    return withUnsafeBytes(of: &pattern) { Array($0) }
}

public func wireHeaderBytes(_ header: WireHeader) -> Data {
    var bytes: [UInt8] = [header.kind.rawValue, header.stream, header.flags.rawValue, 0]
    bytes.append(contentsOf: le32(header.sequence))
    bytes.append(contentsOf: le64(header.ptsUs))
    bytes.append(contentsOf: le64(header.senderClockUs))
    return Data(bytes)
}

/// Header plus payload, one message, ready for `URLSessionWebSocketTask`'s `.data` message.
public func wireMessage(_ header: WireHeader, _ payload: Data) -> Data {
    var out = wireHeaderBytes(header)
    out.append(payload)
    return out
}

public func readWireHeader(_ data: Data) throws -> WireHeader {
    guard data.count >= wireHeaderSize else { throw WireError.truncatedHeader }
    let bytes = [UInt8](data.prefix(wireHeaderSize))
    guard bytes[3] == 0 else { throw WireError.reservedByteNotEmpty }
    guard let kind = WireKind(rawValue: bytes[0]) else { throw WireError.unknownKind(bytes[0]) }
    guard bytes[2] & 0xfc == 0 else { throw WireError.unknownFlags(bytes[2]) }
    let sequence = UInt32(bytes[4]) | UInt32(bytes[5]) << 8 | UInt32(bytes[6]) << 16 | UInt32(bytes[7]) << 24
    let pts = readInt64(bytes, from: 8)
    let clock = readInt64(bytes, from: 16)
    return WireHeader(kind: kind, stream: bytes[1], flags: WireFlags(rawValue: bytes[2]), sequence: sequence, ptsUs: pts, senderClockUs: clock)
}

private func readInt64(_ bytes: [UInt8], from index: Int) -> Int64 {
    var accumulator: UInt64 = 0
    for offset in 0..<8 { accumulator |= UInt64(bytes[index + offset]) << (8 * UInt64(offset)) }
    return Int64(bitPattern: accumulator)
}

private func readUInt16(_ bytes: [UInt8], at index: Int) -> UInt16 {
    UInt16(bytes[index]) | UInt16(bytes[index + 1]) << 8
}

public func encodeTouch(_ contacts: [TouchContact]) throws -> Data {
    guard contacts.count <= wireMaxContacts else { throw WireError.tooManyContacts(contacts.count) }
    var seen = Set<UInt8>()
    var bytes: [UInt8] = [UInt8(contacts.count)]
    for contact in contacts {
        guard contact.id <= 9 else { throw WireError.contactIdOutOfRange(contact.id) }
        guard seen.insert(contact.id).inserted else { throw WireError.duplicateContact(contact.id) }
        guard contact.x >= 0, contact.x <= 1, contact.y >= 0, contact.y <= 1 else {
            throw WireError.coordinateOutOfRange(id: contact.id, x: contact.x, y: contact.y)
        }
        let quantisedX = UInt16((contact.x * 65535).rounded())
        let quantisedY = UInt16((contact.y * 65535).rounded())
        bytes.append(contact.id)
        bytes.append(contact.pressed ? 1 : 0)
        bytes.append(contentsOf: le16(quantisedX))
        bytes.append(contentsOf: le16(quantisedY))
    }
    return Data(bytes)
}

public func decodeTouch(_ data: Data) throws -> [TouchContact] {
    let bytes = [UInt8](data)
    guard !bytes.isEmpty else { throw WireError.touchLength(expected: 1 + 0, found: 0) }
    let count = Int(bytes[0])
    guard count <= wireMaxContacts else { throw WireError.tooManyContacts(count) }
    guard bytes.count == 1 + count * 6 else { throw WireError.touchLength(expected: 1 + count * 6, found: bytes.count) }
    var seen = Set<UInt8>()
    var contacts: [TouchContact] = []
    for index in 0..<count {
        let offset = 1 + index * 6
        let id = bytes[offset]
        guard id <= 9 else { throw WireError.contactIdOutOfRange(id) }
        guard seen.insert(id).inserted else { throw WireError.duplicateContact(id) }
        guard bytes[offset + 1] <= 1 else { throw WireError.unknownFlags(bytes[offset + 1]) }
        contacts.append(TouchContact(
            id: id,
            pressed: bytes[offset + 1] == 1,
            x: Double(readUInt16(bytes, at: offset + 2)) / 65535,
            y: Double(readUInt16(bytes, at: offset + 4)) / 65535
        ))
    }
    return contacts
}

public func encodeKey(_ code: KeyCode, down: Bool) -> Data {
    Data(le16(code.rawValue) + [down ? 1 : 0])
}

public func decodeKey(_ data: Data) throws -> (code: UInt16, down: Bool) {
    let bytes = [UInt8](data)
    guard bytes.count == 3 else { throw WireError.keyPayloadLength(bytes.count) }
    let code = readUInt16(bytes, at: 0)
    guard KeyCode.allCases.contains(where: { $0.rawValue == code }) else { throw WireError.unknownKey(code) }
    guard bytes[2] <= 1 else { throw WireError.unknownFlags(bytes[2]) }
    return (code, bytes[2] == 1)
}
