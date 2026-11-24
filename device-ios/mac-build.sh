#!/bin/sh
# SPDX-FileCopyrightText: 2026 mirrorplay contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# The part that can only happen on a Mac: generate the project, build it for a device, archive it,
# and export an installable .ipa. Run from the repository root:
#
#   device-ios/mac-build.sh                     # unsigned .xcarchive + a build for your own device
#   TEAM_ID=ABCDE12345 device-ios/mac-build.sh   # signed, installable .ipa
#
# Without a Team ID nothing is signed, and an unsigned .ipa installs on no phone — that is stated
# rather than hidden, because the honest deliverable here is a buildable project plus the one command
# that turns it into an artifact once the credentials exist.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
team=${TEAM_ID:-}

say() { printf '\n\033[36m== %s\033[0m\n' "$1"; }

say 'byte fixtures in, protocol tests out (the parity check between Swift and the relay)'
(cd "$root" && npm ci --silent 2>/dev/null || npm install --silent)
(cd "$root" && npm run fixtures:ios)
(cd "$here" && swift test)

say 'xcodegen'
command -v xcodegen >/dev/null || { echo 'xcodegen missing: brew install xcodegen'; exit 3; }
(cd "$here" && xcodegen generate)

project="$here/mirrorplay-device.xcodeproj"
archive="$here/build/mirrorplay-device.xcarchive"

if [ -n "$team" ]; then
  say "archive (signed, team $team)"
  xcodebuild -project "$project" -scheme mirrorplay-device \
    -configuration Release -destination 'generic/platform=iOS' \
    -archivePath "$archive" DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic \
    clean build archive
else
  say 'archive (unsigned: code signing identities are not in this build)'
  xcodebuild -project "$project" -scheme mirrorplay-device \
    -configuration Release -destination 'generic/platform=iOS' \
    -archivePath "$archive" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    clean build archive
fi

say 'export'
mkdir -p "$here/build"
if [ -n "$team" ]; then
  cat > "$here/build/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>development</string>
  <key>teamID</key><string>$team</string>
  <key>signingStyle</key><string>automatic</string>
  <key>compileBitcode</key><false/>
  <key>stripSwiftSymbols</key><true/>
</dict></plist>
PLIST
  xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$here/build/ExportOptions.plist" -exportPath "$here/build/ipa"
  ls -l "$here/build/ipa"
  echo 'installable .ipa exported. The device has to be in the profile (Xcode → Settings → Accounts → Manage Certificates, or a profile listing its UDID) or the install is refused.'
else
  # No identity means no signed export: exportArchive refuses. The archive is still the useful
  # handover, and so is a properly shaped unsigned container for the signing step you already have
  # (SideStore, AltStore, Sideloadly, or codesign on any Mac).
  echo "no TEAM_ID: no signed export."
  app="$archive/Products/Applications/mirrorplay-device.app"
  if [ -d "$app" ]; then
    sh "$here/package-ipa.sh" "$app" "$here/build/mirrorplay-unsigned.ipa"
  else
    echo "  expected the built bundle inside the archive at $app — check the archive log"
    exit 4
  fi
  echo "Archive: $archive (open it in Xcode's Organizer to distribute, or set TEAM_ID and re-run)."
fi
