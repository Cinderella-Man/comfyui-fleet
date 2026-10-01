# Development

Run these commands from the repository root with Python 3.12+ and a current
Node.js release. See [the glossary](../CONTEXT.md) for project terminology.

## Tests and checks

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r tests/requirements.lock
.venv/bin/python -m pytest -q
node --test tests/frontend.test.mjs
.venv/bin/ruff check fleet tests tools __init__.py
.venv/bin/ruff format --check fleet tests tools __init__.py
node --check web/fleet.js
node --check web/panel.js
node --check web/preparation.js
node --check web/progress.js
```

For the browser and end-to-end suites, install Playwright and Chromium:

```sh
npm install --prefix .browser-tests --no-save --package-lock=false playwright@1.62.1
node .browser-tests/node_modules/playwright/cli.js install chromium
FLEET_PLAYWRIGHT_MODULE="$PWD/.browser-tests/node_modules/playwright" node --test tests/browser.test.mjs tests/e2e.test.mjs
```

The end-to-end fixture uses `.venv/bin/python`; set `FLEET_PYTHON` to override it.
All suites use temporary state and simulated ComfyUI workers. They do not
connect to your configured workers or require GPUs.

Before a release, smoke test with real ComfyUI workers: submit jobs, check
collected results and workflow loading, reorder and cancel work, and restart
the controller with jobs queued.

## Build a release archive

```sh
python3 tools/package.py
```

This writes `dist/ComfyUI-Fleet-0.1.0.tar.gz` and a SHA-256 manifest. Extract the
archive inside the controller's `custom_nodes` directory to install it.

The packager includes an explicit list of runtime files and user guides.
Tests and development tools stay out of the archive. When adding files, update
the repository's `.gitignore` allowlist and, if needed, `tools/package.py`.
Keep deployment data, credentials and test outputs out of the repository.
