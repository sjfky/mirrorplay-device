// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// base64 that runs the same way in Node and in a browser, because the protocol modules are shared
// between the relay and the receiver page. `config` fields on the wire (avcC, AudioSpecificConfig)
// are base64 of the raw record bytes.

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== 'undefined') return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
  let text = '';
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text);
}

export function fromBase64(text) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
  const decoded = atob(text);
  const out = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}
