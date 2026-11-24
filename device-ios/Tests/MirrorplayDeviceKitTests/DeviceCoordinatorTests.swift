// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Protocol-visible behaviour tests for the iOS device coordinator. These deliberately use fake
// pictures instead of real CMSampleBuffers: a Linux XCTest can decide whether the rules are right,
// while Apple SDK callbacks only decide whether the plumbing still compiles.

import Foundation
import XCTest
@testable import MirrorplayDeviceKit

final class DeviceCoordinatorTests: XCTestCase {
    func testIdlePicturesAreIgnoredUntilStart() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        let actions = coordinator.receivedPicture(delta(bytes: [9, 9]))
        XCTAssertEqual(actions, [])
        XCTAssertEqual(coordinator.phase, .idle)
    }

    func testConnectionOpenedWhileIdleOnlyReintroducesTheDevice() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        let actions = coordinator.connectionOpened()
        XCTAssertEqual(actions, [DeviceAction.sendHello])
        XCTAssertEqual(coordinator.phase, .pairing)
    }

    func testFirstKeyframeAnnouncesItsOwnFormatBeforeSendingTheSample() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        let start = coordinator.startRequested()
        XCTAssertEqual(start, [
            DeviceAction.startEncoder(coordinator.target),
            DeviceAction.startCapture(coordinator.target),
        ])
        XCTAssertEqual(coordinator.phase, .waitingForKeyFrame)

        let key = keyframe(bytes: [7, 4, 2], ptsUs: 100)
        let sent = coordinator.receivedPicture(key)
        XCTAssertEqual(sent, [
            DeviceAction.sendFormat(testFormat(coordinator), screen: 0),
            DeviceAction.sendSample(key, runId: 1, marksRunStart: true),
        ])
        XCTAssertEqual(coordinator.phase, .streaming)
        XCTAssertEqual(coordinator.announcedFormat, testFormat(coordinator))
    }

    func testDeltaBeforeFirstKeyframeIsDroppedRatherThanSentUnannounced() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        let stale = delta(bytes: [8, 1], ptsUs: 50)
        XCTAssertEqual(coordinator.receivedPicture(stale), [DeviceAction.dropStaleSample(stale)])
        XCTAssertEqual(coordinator.phase, .waitingForKeyFrame)
    }

    func testDuplicateStartWhileProducingDoesNotChurnTheEncoder() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe())
        XCTAssertEqual(coordinator.startRequested(), [])
    }

    func testKeyframeRequestIsForwardedOnlyWhileProducing() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        XCTAssertEqual(coordinator.keyframeRequested(), [])

        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe())
        XCTAssertEqual(coordinator.keyframeRequested(), [DeviceAction.requestKeyframe])

        _ = coordinator.setPaused(true)
        XCTAssertEqual(coordinator.keyframeRequested(), [])
    }

    func testPauseStopsCaptureAndResumeStartsANewRun() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe(ptsUs: 0))

        XCTAssertEqual(coordinator.setPaused(true), [DeviceAction.stopCapture])
        XCTAssertEqual(coordinator.phase, .paused)

        let lateDelta = delta(bytes: [5, 5], ptsUs: 75)
        XCTAssertEqual(coordinator.receivedPicture(lateDelta), [])

        let resume = coordinator.setPaused(false)
        XCTAssertEqual(resume, [
            DeviceAction.stopEncoder,
            DeviceAction.startEncoder(coordinator.target),
            DeviceAction.startCapture(coordinator.target),
        ])
        XCTAssertEqual(coordinator.phase, .waitingForKeyFrame)
        XCTAssertEqual(coordinator.runId, 2)

        let secondKey = keyframe(bytes: [8, 8], ptsUs: 200)
        let sent = coordinator.receivedPicture(secondKey)
        XCTAssertEqual(sent, [
            DeviceAction.sendFormat(testFormat(coordinator), screen: 0),
            DeviceAction.sendSample(secondKey, runId: 2, marksRunStart: true),
        ])
    }

    func testReconnectWhileStreamingReintroducesAndRequiresFreshAnnouncement() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe(ptsUs: 0))

        let opened = coordinator.connectionOpened()
        XCTAssertEqual(opened, [
            DeviceAction.sendHello,
            DeviceAction.requestKeyframe,
        ])
        XCTAssertEqual(coordinator.runId, 2)
        XCTAssertEqual(coordinator.announcedFormat, nil)

        let staleDelta = delta(bytes: [6, 6], ptsUs: 500)
        XCTAssertEqual(coordinator.receivedPicture(staleDelta), [DeviceAction.dropStaleSample(staleDelta)])

        let newKey = keyframe(bytes: [9, 1], ptsUs: 600)
        let sent = coordinator.receivedPicture(newKey)
        XCTAssertEqual(sent, [
            DeviceAction.sendFormat(testFormat(coordinator), screen: 0),
            DeviceAction.sendSample(newKey, runId: 2, marksRunStart: true),
        ])
    }

    func testRotationToTheSameDimensionsDoesNotRestart() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe(ptsUs: 0))

        XCTAssertEqual(coordinator.rotationChanged(width: 540, height: 960), [])
        XCTAssertEqual(coordinator.runId, 1)
    }

    func testResolutionChangeWhileStreamingRestartsOneMediaRun() {
        let initial = DeviceGeometry(width: 540, height: 960, fps: 30, bitrate: 2_400_000)
        let coordinator = DeviceCoordinator(target: initial)
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe(ptsUs: 0, geometry: initial))

        let rotated = DeviceGeometry(width: 720, height: 1280, fps: 30, bitrate: 2_400_000)
        let actions = coordinator.requestGeometry(rotated)
        XCTAssertEqual(actions, [
            DeviceAction.stopCapture,
            DeviceAction.stopEncoder,
            DeviceAction.startEncoder(rotated),
            DeviceAction.startCapture(rotated),
        ])
        XCTAssertEqual(coordinator.target, rotated)
        XCTAssertEqual(coordinator.runId, 2)
        XCTAssertEqual(coordinator.phase, .waitingForKeyFrame)

        let key = keyframe(bytes: [2, 3], ptsUs: 100, geometry: rotated, config: "rotatedConfig")
        let sent = coordinator.receivedPicture(key)
        XCTAssertEqual(sent, [
            DeviceAction.sendFormat(DeviceFormat(codecString: "avc1.42C01F", config: "rotatedConfig", width: 720, height: 1280), screen: 0),
            DeviceAction.sendSample(key, runId: 2, marksRunStart: true),
        ])
    }

    func testResolutionWhilePausedUpdatesTargetWithoutRestarting() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe(ptsUs: 0))
        _ = coordinator.setPaused(true)

        let landscape = DeviceGeometry(width: 960, height: 540, fps: 30, bitrate: 3_000_000)
        XCTAssertEqual(coordinator.requestGeometry(landscape), [])
        XCTAssertEqual(coordinator.target, landscape)
        XCTAssertEqual(coordinator.runId, 1)

        let resume = coordinator.setPaused(false)
        XCTAssertEqual(resume, [
            DeviceAction.stopEncoder,
            DeviceAction.startEncoder(landscape),
            DeviceAction.startCapture(landscape),
        ])
        XCTAssertEqual(coordinator.runId, 2)
    }

    func testSystemInterruptionStopsEncodingAndRecoveryUsesANewRun() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe(ptsUs: 0))

        XCTAssertEqual(coordinator.captureInterrupted(true), [
            DeviceAction.stopCapture,
            DeviceAction.stopEncoder,
        ])
        XCTAssertEqual(coordinator.phase, .interrupted)
        XCTAssertEqual(coordinator.receivedPicture(delta(bytes: [1, 2], ptsUs: 20)), [])

        let recovery = coordinator.captureInterrupted(false)
        XCTAssertEqual(recovery, [
            DeviceAction.startEncoder(coordinator.target),
            DeviceAction.startCapture(coordinator.target),
        ])
        XCTAssertEqual(coordinator.phase, .waitingForKeyFrame)
        XCTAssertEqual(coordinator.runId, 2)

        let key = keyframe(bytes: [3, 4], ptsUs: 100)
        let sent = coordinator.receivedPicture(key)
        XCTAssertEqual(sent, [
            DeviceAction.sendFormat(testFormat(coordinator), screen: 0),
            DeviceAction.sendSample(key, runId: 2, marksRunStart: true),
        ])
    }

    func testKeyframeWithoutParameterSetsFailsInsteadOfGuessingAFormat() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        let bad = DevicePicture(bytes: Data([1, 0]), ptsUs: 0, isKeyframe: true)
        XCTAssertEqual(coordinator.receivedPicture(bad), [
            DeviceAction.fail(reason: "encoder produced a key frame without parameter sets to announce"),
        ])
        XCTAssertEqual(coordinator.phase, .waitingForKeyFrame)
        XCTAssertEqual(coordinator.announcedFormat, nil)
    }

    func testLaterKeyframeWithoutInBandParameterSetsDoesNotReannounce() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe(ptsUs: 0))

        let laterKey = DevicePicture(bytes: Data([4, 5]), ptsUs: 20, isKeyframe: true)
        let sent = coordinator.receivedPicture(laterKey)
        XCTAssertEqual(sent, [DeviceAction.sendSample(laterKey, runId: 1, marksRunStart: false)])
        XCTAssertEqual(coordinator.announcedFormat, testFormat(coordinator))
    }

    func testFormatChangeOnAKeyframeReannouncesBeforeTheSample() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe(ptsUs: 0))

        let changed = DevicePicture(
            bytes: Data([11, 12]),
            ptsUs: 40,
            width: 540,
            height: 960,
            codecString: "avc1.4D401F",
            config: "changedConfig",
            isKeyframe: true
        )
        let sent = coordinator.receivedPicture(changed)
        XCTAssertEqual(sent, [
            DeviceAction.sendFormat(DeviceFormat(codecString: "avc1.4D401F", config: "changedConfig", width: 540, height: 960), screen: 0),
            DeviceAction.sendSample(changed, runId: 1, marksRunStart: false),
        ])
    }

    func testStopRequestedStopsProductionAndKeepsProtocolStateQuiet() {
        let coordinator = DeviceCoordinator(target: testGeometry())
        _ = coordinator.startRequested()
        _ = coordinator.receivedPicture(keyframe(ptsUs: 0))

        XCTAssertEqual(coordinator.stopRequested(), [DeviceAction.stopCapture, DeviceAction.stopEncoder])
        XCTAssertEqual(coordinator.phase, .stopped)
        XCTAssertEqual(coordinator.receivedPicture(keyframe(ptsUs: 10)), [])
    }
}

private func testGeometry() -> DeviceGeometry {
    DeviceGeometry(width: 540, height: 960, fps: 30, bitrate: 3_000_000)
}

private func testFormat(_ coordinator: DeviceCoordinator) -> DeviceFormat {
    DeviceFormat(codecString: "avc1.42C01F", config: "defaultConfig", width: coordinator.target.width, height: coordinator.target.height)
}

private func keyframe(
    bytes: [UInt8] = [1, 2, 3],
    ptsUs: Int64 = 0,
    geometry: DeviceGeometry? = nil,
    config: String? = nil
) -> DevicePicture {
    let geometry = geometry ?? testGeometry()
    return DevicePicture(
        bytes: Data(bytes),
        ptsUs: ptsUs,
        width: geometry.width,
        height: geometry.height,
        codecString: "avc1.42C01F",
        config: config ?? "defaultConfig",
        isKeyframe: true
    )
}

private func delta(bytes: [UInt8] = [4, 5], ptsUs: Int64 = 0) -> DevicePicture {
    DevicePicture(bytes: Data(bytes), ptsUs: ptsUs, isKeyframe: false)
}
