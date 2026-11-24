// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Page chrome shared by the receiver, device and admin pages: a rolling note list and a key/value
// table. DOM only, no protocol knowledge, so every page keeps its own meaning and this stays boring.

export function createPanel({ log, table, limit = 30 } = {}) {
  const notes = [];
  const stamp = () => new Date().toLocaleTimeString([], { hour12: false });
  return {
    log(text) {
      if (!log) return text;
      notes.unshift(`${stamp()} ${text}`);
      if (notes.length > limit) notes.length = limit;
      log.textContent = notes.join('\n');
      return text;
    },
    stats(values) {
      if (!table) return;
      const rows = Object.entries(values);
      table.replaceChildren(
        ...rows.map(([key, value]) => {
          const row = document.createElement('tr');
          const name = document.createElement('td');
          const cell = document.createElement('td');
          name.className = 'dim';
          cell.className = 'mono';
          name.textContent = key;
          cell.textContent = value === null || value === undefined ? '—' : String(value);
          row.append(name, cell);
          return row;
        }),
      );
    },
  };
}

/** Milliseconds with the unit the car browser needs, and no false precision. */
export const ms = (value, digits = 1) => (value === null || value === undefined ? '—' : `${Number(value).toFixed(digits)} ms`);
export const kbytes = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;
