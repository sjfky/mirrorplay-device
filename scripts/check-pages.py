#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 mirrorplay contributors
# SPDX-License-Identifier: AGPL-3.0-only
# Turn the inline module script of a page into a file node can syntax-check, by rewriting the
# absolute import specifiers the relay serves (/src/..., /web/...) onto the real files.
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def extract(page: Path) -> str:
    html = page.read_text()
    scripts = re.findall(r'<script type="module">(.*?)</script>', html, re.S)
    if not scripts:
        # icon.html is markup only — it exists so Chromium can rasterise the icon at any size. A page
        # with no script must not fail the checker; a script page with a *typo'd* opener must, which is
        # why the distinction is made by name rather than by "any html without a script is fine".
        if page.name in SCRIPTLESS_PAGES:
            return None
        raise SystemExit(f'{page.name}: expected a module script and found none')
    return '\n'.join(scripts)

SCRIPTLESS_PAGES = {'icon.html'}


def rewrite(script: str) -> str:
    def specifier(match: re.Match) -> str:
        path = match.group(1)
        target = ROOT / ('src' + path) if path.startswith('/web/') else ROOT / path.lstrip('/')
        if not target.exists():
            raise SystemExit(f'import target does not exist: {path}')
        return f"'file://{target}'"
    return re.sub(r"'(/(?:src|web)/[^']+)'", specifier, script)

def main() -> int:
    pages = [ROOT / 'src' / 'web' / name for name in sys.argv[1:]] or sorted((ROOT / 'src' / 'web').glob('*.html'))
    failures = 0
    for page in pages:
        raw = extract(page)
        if raw is None:
            print(f'– {page.name} (no module script, markup only)')
            continue
        script = rewrite(raw)
        with tempfile.NamedTemporaryFile('w', suffix='.mjs', delete=False) as handle:
            handle.write(script)
            probe = Path(handle.name)
        result = subprocess.run(['node', '--check', str(probe)], capture_output=True, text=True)
        probe.unlink()
        if result.returncode:
            failures += 1
            print(f'✖ {page.name}')
            print(result.stderr.strip()[:1200])
        else:
            print(f'✔ {page.name}')
    return 1 if failures else 0

if __name__ == '__main__':
    sys.exit(main())
