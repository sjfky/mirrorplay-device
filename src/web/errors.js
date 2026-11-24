// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Every page installs this so an uncaught error is visible to the browser check instead of silently
// killing a decode loop.

window.__errors ??= [];
addEventListener('error', (event) => window.__errors.push(String(event.message ?? event.error)));
addEventListener('unhandledrejection', (event) => window.__errors.push(`rejection: ${event.reason}`));
