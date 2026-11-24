// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Where the pairing token comes from: the URL wins, then what this browser remembered, then the
// default the relay was started with. A car browser usually gets the link once and keeps it.

const KEY = 'mirrorplay.token';
export const DEFAULT_TOKEN = 'mirrorplay';

export function rememberToken(token) {
  try {
    if (token) localStorage.setItem(KEY, token);
  } catch {
    /* private mode keeps the token for this visit only */
  }
  return token;
}

export function relayToken(params = new URLSearchParams(location.search)) {
  const fromUrl = params.get('token');
  if (fromUrl) {
    try {
      localStorage.setItem(KEY, fromUrl);
    } catch {
      /* private mode: the URL is enough for this visit */
    }
    return fromUrl;
  }
  try {
    return localStorage.getItem(KEY) ?? DEFAULT_TOKEN;
  } catch {
    return DEFAULT_TOKEN;
  }
}
