#!/bin/sh
# SPDX-FileCopyrightText: 2026 mirrorplay contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Put an .app bundle that some Apple toolchain already produced into the container shape iOS calls an
# .ipa: a zip whose only top-level entry is Payload/.
#
#   device-ios/package-ipa.sh path/to/mirrorplay-device.app [out.ipa]
#
# What this does NOT do: compile, link, or sign. None of those can be done honestly on Linux — the iOS
# toolchain and SDK are Apple-platform software, and a signature needs a signing identity that does not
# exist here. What this DOES give you is the correct container for a signing step you already have:
# SideStore, AltStore and Sideloadly take an unsigned Payload archive and hand back something a phone
# installs, and codesign + exportArchive on any Mac do the same with a certificate.
#
# The bundle checks below use real Mach-O and fat-archive magics, and read the plist only through a
# reader that has been *proven* to answer sensibly, because a helper's usage text handed back as a
# bundle identifier produces an .ipa that names a file nobody signed.

set -eu

PLIST_KEYS="CFBundleExecutable CFBundleIdentifier CFBundleShortVersionString CFBundleVersion"

usage() { echo "usage: $(basename "$0") <path/to/App.app> [out.ipa]" >&2; exit 2; }

app=${1:-}
out=${2:-mirrorplay-unsigned.ipa}
[ -n "$app" ] || usage
[ -d "$app" ] || { echo "no such .app bundle: $app" >&2; exit 2; }
plist=$app/Info.plist
[ -f "$plist" ] || { echo "$app has no Info.plist; that is not an app bundle" >&2; exit 2; }

# A plist value is one short token. Anything else — a colon, a space, a line of prose — is a tool
# complaining at us rather than metadata, and it must never be used as a filename.
is_plausible() {
  # Empty, or too long to be a bundle name, or carrying anything a plist token never contains (spaces,
  # colons, punctuation) — that is a tool's complaint, not metadata.
  case $1 in
    '') return 1 ;;
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  [ ${#1} -le 128 ] || return 1
  return 0
}

read_with_plutil() {
  # `-extract … raw` is Apple's plutil. The one that ships inside the Swift toolchain on Linux does not
  # have it; probing behaviour instead of existence is what keeps this script honest on both.
  plutil -extract "$1" raw -o - "$plist" 2>/dev/null | head -n 1
}

read_with_python() {
  python3 -c '
import plistlib, sys
with open(sys.argv[1], "rb") as handle:
    value = plistlib.load(handle).get(sys.argv[2], "")
sys.stdout.write(str(value) if isinstance(value, (str, int, float)) else "")
' "$plist" "$1" 2>/dev/null | head -n 1
}

reader=""
read_key() {
  value=""
  if [ -n "$reader" ]; then
    case $reader in
      plutil) value=$(read_with_plutil "$1") ;;
      python3) value=$(read_with_python "$1") ;;
    esac
    # The first successful read tells us whether this reader is the Apple one. If it answers with
    # usage text, fall over to python3 and say so — silently believing a lie is the worse failure.
    if ! is_plausible "$value"; then
      if [ "$reader" = plutil ] && command -v python3 >/dev/null 2>&1; then
        echo "note: plutil here does not understand -extract; reading Info.plist with python3 instead" >&2
        reader=python3
        value=$(read_with_python "$1")
      else
        value=""
      fi
    fi
  fi
  printf '%s' "$value"
}

pick_reader() {
  # Probe by behaviour, and say out loud which reader was chosen and why: a reader that answers with
  # prose is the failure this script was written to avoid, and hiding the switch would leave somebody
  # debugging an .ipa whose identifier is a sentence.
  if command -v plutil >/dev/null 2>&1; then
    probe=$(read_with_plutil CFBundleIdentifier)
    if is_plausible "$probe"; then
      reader=plutil
      return
    fi
    if command -v python3 >/dev/null 2>&1; then
      echo "note: plutil here does not understand -extract; reading Info.plist with python3 instead" >&2
      reader=python3
      return
    fi
    echo "note: plutil here does not understand -extract, and there is no fallback reader" >&2
  fi
  if command -v python3 >/dev/null 2>&1 && is_plausible "$(read_with_python CFBundleIdentifier)"; then
    reader=python3
    return
  fi
  reader=""
}

pick_reader

executable=$(read_key CFBundleExecutable)
identifier=$(read_key CFBundleIdentifier)
version=$(read_key CFBundleShortVersionString)
[ -n "$version" ] || version=$(read_key CFBundleVersion)

if [ -z "$executable" ]; then
  if [ -z "$reader" ]; then
    echo "neither Apple's plutil nor python3 with plistlib can read $plist; the bundle cannot be verified here" >&2
    echo "  install python3 (or run this on a Mac) rather than letting an unverifiable bundle through" >&2
    exit 3
  fi
  echo "Info.plist has no CFBundleExecutable — a build product always does" >&2
  exit 1
fi

binary=$app/$executable
[ -f "$binary" ] || { echo "Info.plist names a file that is not in the bundle: $executable" >&2; exit 1; }

# The first four bytes of a real iOS binary: 64-bit Mach-O either byte order, 32-bit (no arm64 device
# can load it), or a fat container of several architectures.
magic=$(od -An -tx1 -N4 "$binary" | tr -d ' \n')
case $magic in
  cffaedfe|feedfacf) kind="64-bit Mach-O" ;;
  cafebabe|bebaface) kind="fat archive" ;;
  cefaedfe|feedface) kind="32-bit Mach-O (no arm64 iOS device can load this)" ;;
  *) echo "$binary does not begin with a Mach-O magic (read 0x$magic) — this is not a compiled iOS binary" >&2; exit 1 ;;
esac

printf 'bundle: %s  executable: %s (%s)  version: %s\n' \
  "${identifier:-unknown}" "$executable" "$kind" "${version:-unset}"

# lipo is the only tool that reads a fat header honestly; file(1) calls 0xcafebabe Java class data, and
# saying that about an app binary would be a wrong answer rather than a missing one.
if command -v lipo >/dev/null 2>&1; then
  printf '  slices: %s\n' "$(lipo -archs "$binary" 2>/dev/null || echo unreadable)"
elif [ "$kind" != "fat archive" ] && command -v file >/dev/null 2>&1; then
  printf '  file: %s\n' "$(file -b "$binary" | cut -c1-120)"
fi

if command -v codesign >/dev/null 2>&1; then
  if codesign -dv "$binary" >/dev/null 2>&1; then
    echo "signature: present — this script copies the bundle and re-signs nothing"
  else
    echo "signature: none (expected for something that just came out of a build)"
  fi
fi

case $out in
  /*) ;;
  *) out=$PWD/$out ;;
esac
command -v zip >/dev/null 2>&1 || { echo "zip is required to write a Payload archive" >&2; exit 3; }

stage=$(mktemp -d)
cleanup() { [ -n "${stage:-}" ] && rm -rf "$stage"; }
trap cleanup EXIT INT TERM

mkdir -p "$stage/Payload"
cp -R "$app" "$stage/Payload/"
name=$(basename "$app")
rm -f "$out"
( cd "$stage" && zip -qryX "$out" Payload )

# A container with anything beside Payload/ is not an .ipa, so the archive is inspected before the
# script claims to have produced one.
tops=$(unzip -Z1 "$out" 2>/dev/null | sed -n 's#^\([^/]*\)/.*#\1#p' | sort -u | tr '\n' ' ')
if [ -n "$tops" ] && [ "$tops" != "Payload " ]; then
  echo "the archive must hold exactly one Payload/ directory; this one holds: $tops" >&2
  rm -f "$out"
  exit 1
fi

printf 'wrote %s\n' "$out"
printf '  payload: Payload/%s  size: %s\n' "$name" "$(du -h "$out" | cut -f1)"
printf '  unsigned. Hand it to whatever signs for you (SideStore/AltStore/Sideloadly, or codesign on a\n'
printf '  Mac). Without a signature an iPhone refuses it, and that refusal is the signing step, not\n'
printf '  this container.\n'
