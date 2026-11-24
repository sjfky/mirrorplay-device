// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Byte-level parity for the H.264 container work: the avcC record built from the encoder's parameter
// sets, the Annex B → AVCC reframe, and the picture size read out of an SPS. Fixtures come from
// `scripts/ios-fixtures.mjs`, which writes them with this repository's own JavaScript modules, so an
// iPhone and a browser tab put the same bytes on the wire for the same picture.

import Foundation
import XCTest
@testable import MirrorplayH264
@testable import MirrorplayWire

// See testFixturesArePresent in WireFormatFixtureTests: a path that does not resolve would skip this
// whole target instead of failing it, so the walk is spelled out level by level.
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

private struct Manifest: Decodable {
    let codec: String
    let size: [Int]
    let fps: Int
    let encoder: String
    let avcC: String
}

private func manifest() throws -> Manifest {
    try JSONDecoder().decode(Manifest.self, from: fixture("manifest.json"))
}

final class H264FixtureTests: XCTestCase {
    func testFixturesArePresent() {
        let missing = ["manifest.json", "sps.bin", "pps.bin", "avcC.bin", "key-annexb.bin", "key-avcc.bin", "delta-avcc.bin"]
            .filter { !FileManager.default.fileExists(atPath: fixturesDirectory.appendingPathComponent($0).path) }
        XCTAssertTrue(missing.isEmpty, "missing fixtures: \(missing.joined(separator: ", ")) — run `npm run fixtures:ios` in the repository root")
    }
    func testRecordBuiltFromParameterSetsIsTheFixtureRecord() throws {
        let sps = try fixture("sps.bin")
        let pps = try fixture("pps.bin")
        let expected = try fixture("avcC.bin")
        let record = try AvcC(sps: sps, pps: pps)

        XCTAssertEqual([UInt8](record.bytes), [UInt8](expected), "the record a receiver configures a decoder from must be identical")
        XCTAssertEqual(record.bytes.count, expected.count)
        XCTAssertEqual(record.nalLengthSize, 4, "the wire carries four-byte NAL lengths")
        XCTAssertEqual(record.bytes.first, 1, "configuration version")
        XCTAssertEqual([UInt8](record.bytes)[5] & 0x1f, 1, "one SPS")
        XCTAssertEqual(record.bytes[record.bytes.count - pps.count - 3], 1, "one PPS")
        XCTAssertEqual(Data(hex: try manifest().avcC), record.bytes, "and the manifest agrees with the bytes")
    }

    func testCodecStringAndGeometryComeOutOfTheSPSnotTheRequest() throws {
        let record = try AvcC(sps: fixture("sps.bin"), pps: fixture("pps.bin"))
        let expected = try manifest()
        XCTAssertEqual(record.codecString, expected.codec)
        XCTAssertEqual(record.width, expected.size[0])
        XCTAssertEqual(record.height, expected.size[1])

        // The same record read back the way a receiver reads it: same string, same size.
        let reparsed = try AvcC(record: record.bytes)
        XCTAssertEqual(reparsed.codecString, record.codecString)
        XCTAssertEqual(reparsed.width, record.width)
        XCTAssertEqual(reparsed.height, record.height)
    }

    func testAnnexBReframeProducesTheFixturePayload() throws {
        let converted = try annexBToAvcc(fixture("key-annexb.bin"))
        XCTAssertEqual([UInt8](converted), [UInt8](try fixture("key-avcc.bin")), "lengths replace start codes, and nothing else changes")
        XCTAssertEqual(converted.count, try fixture("key-annexb.bin").count, "four-byte start codes and four-byte lengths are the same size")

        let units = try avccUnits(converted)
        XCTAssertGreaterThanOrEqual(units.count, 3, "a native IDR arrives as parameter sets plus the slice")
        XCTAssertEqual(units.first.map { nalType($0) }, 7, "SPS first")
        XCTAssertEqual(nalType(units[units.count - 1]), 5, "and the IDR slice last")
        XCTAssertTrue(isKeyFrame(units: units))
        XCTAssertFalse(isKeyFrame(units: try avccUnits(fixture("delta-avcc.bin"))), "a P picture is not a start point")
    }

    func testFramesRoundTripBetweenTheTwoContainers() throws {
        let avcc = try fixture("key-avcc.bin")
        let annexB = try avccToAnnexB(avcc)
        XCTAssertEqual([UInt8](try annexBToAvcc(annexB)), [UInt8](avcc), "there and back again, byte for byte")
        let rebuilt = try avccUnits(avcc).reduce(into: [UInt8]()) { partial, unit in
            partial.append(contentsOf: [0, 0, 0, 1])
            partial.append(contentsOf: [UInt8](unit))
        }
        XCTAssertEqual(rebuilt, [UInt8](annexB), "the two framings hold the same units in the same order")
    }

    func testParameterSetsAreFoundInEitherContainer() throws {
        let fromAnnexB = try parameterSets(accessUnit: fixture("key-annexb.bin"), annexB: true)
        let fromAvcc = try parameterSets(accessUnit: fixture("key-avcc.bin"), annexB: false)
        XCTAssertEqual([UInt8](fromAnnexB.sps), [UInt8](fromAvcc.sps))
        XCTAssertEqual([UInt8](fromAnnexB.pps), [UInt8](fromAvcc.pps))
        XCTAssertEqual([UInt8](fromAnnexB.sps), [UInt8](try fixture("sps.bin")))

        // A delta-only picture has no parameter sets, and pretending otherwise would break a viewer
        // that joined mid-GOP.
        XCTAssertThrowsError(try parameterSets(accessUnit: fixture("delta-avcc.bin"), annexB: false)) { error in
            guard case H264Error.missingParameterSets = error else { return XCTFail("expected missingParameterSets, got \(error)") }
        }
    }

    func testRecordsThatLieAreRefused() throws {
        var record = [UInt8](try fixture("avcC.bin"))
        record[0] = 2
        XCTAssertThrowsError(try AvcC(record: Data(record)), "an unknown configuration version")
        record[0] = 1

        record[4] = 0xfe // lengthSizeMinusOne is reserved at 2
        XCTAssertThrowsError(try AvcC(record: Data(record)), "a reserved length field")
        record[4] = 0xfd // two-byte lengths: legal H.264, useless on this wire
        XCTAssertThrowsError(try AvcC(record: Data(record)), "the wire demands four-byte NAL lengths")

        XCTAssertThrowsError(try AvcC(record: Data([1, 0x42, 0xc0, 0x1f])), "a truncated record")
        XCTAssertThrowsError(try annexBUnits(Data([1, 2, 3, 0, 0, 1, 0x41])), "bytes before the first start code")
        XCTAssertThrowsError(try avccUnits(Data([0, 0, 0, 9, 0x41])), "a NAL longer than what follows it")
        XCTAssertThrowsError(try avccUnits(Data([0, 0, 0, 0])), "a zero-length NAL")
    }

    func testDimensionsReadFromTheReferenceSpsMatchTheencode() throws {
        let dimensions = try SPS.dimensions(fixture("sps.bin"))
        XCTAssertEqual(dimensions.width, 1280)
        XCTAssertEqual(dimensions.height, 720)
        XCTAssertTrue(try manifest().encoder.contains("libx264"), "the reference stream is a real encode, not hand-written bytes")
    }

    func testAnEmulatedZeroPairIsSkippedTheSameWayEverywhere() throws {
        // 00 00 03 is the emulation-prevention triple: a reader that forgets it reads a shifted SPS
        // and gets a wrong size, which is the kind of bug that only appears with one encoder.
        let sps = try fixture("sps.bin")
        let direct = try SPS.dimensions(sps)
        var reader = BitReader(sps, startingAt: 1)
        _ = reader.read(8)
        XCTAssertGreaterThanOrEqual(reader.consumedBits, 8, "the walk consumes the bits it is asked for")
        XCTAssertEqual(direct.width, 1280)
    }
}

private extension Data {
    /// The manifest keeps the record as hex, because a JSON file with raw bytes in it is a mistake
    /// waiting to be mangled by an editor.
    init(hex: String) {
        let digits = hex.filter { !$0.isWhitespace && $0 != "_" }
        var bytes: [UInt8] = []
        var index = digits.startIndex
        while index < digits.endIndex {
            let next = digits.index(index, offsetBy: 2, limitedBy: digits.endIndex) ?? digits.endIndex
            bytes.append(UInt8(digits[index..<next], radix: 16) ?? 0)
            index = next
        }
        self.init(bytes)
    }
}
