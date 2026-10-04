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
node --check web/editing.js
node --check web/details.js
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
the controller with jobs queued. For batch editing, also verify source restoration,
Run blocking, tab switching, draft recovery, Save and Discard. The 0.2.0 editing
flow was smoke tested on ComfyUI 0.38.0 / frontend 1.53.6 using isolated state and
a CPU EmptyImage → SaveImage workflow.

For native generation-control regressions, start a disposable ComfyUI instance
with this checkout installed, then run:

```sh
FLEET_NATIVE_URL=http://127.0.0.1:18190 FLEET_PLAYWRIGHT_MODULE="$PWD/.browser-tests/node_modules/playwright" node --test tests/native.test.mjs
```

This test changes workflow tabs and the control timing setting in that test
instance. It covers increment, decrement, fixed and randomize, before/after
generation, and promoted subgraph controls across serialization and reload.
It does not execute GPU jobs. It was verified on ComfyUI 0.38.0 / frontend 1.53.6.
The Edit batch dialog was also smoke tested on that native frontend with a
100→200 resize and restoration of the previous workflow's unsaved changes.

## ADR verification

| Decision | Coverage |
| --- | --- |
| [0001: Edit queued workflows](adr/0001-edit-queued-jobs-within-their-batch.md) | Authored-source restoration, queued-only save, native tabs and Run blocking: `test_editing.py`, `e2e.test.mjs`. |
| [0002: Hold the queue while editing](adr/0002-editing-holds-the-queue-at-the-edited-batch.md) | Earlier/later ordering, all front-insertion routes, draft recovery and stale-writer rejection: `test_editing.py`, `e2e.test.mjs`. |
| [0003: Shared prepared revisions](adr/0003-share-prepared-job-data-within-batch-revisions.md) | Arbitrary JSON reconstruction, revision lifetime, input retention and atomic migration: `test_editing.py`, `test_upgrade.py`, `test_http_controller.py`. |
| [0004: Resize without replay](adr/0004-resize-batches-without-replaying-prepared-work.md) | 100→500 growth, shrink-to-floor, unchanged existing jobs, idempotent retry, dialog recovery, inline rename and native seed continuation: `test_editing.py`, `test_http_controller.py`, `e2e.test.mjs`, `native.test.mjs`. |
| [0005: Drop missing jobs](adr/0005-drop-missing-jobs-after-node-restarts.md) | Missing acknowledged/unacknowledged jobs, network failures, cancellation and restart recovery: `test_ledger.py`, `test_http_controller.py`, `e2e.test.mjs`. |

## Build a release archive

```sh
python3 tools/package.py
```

This writes `dist/ComfyUI-Fleet-0.2.0.tar.gz` and a SHA-256 manifest. Extract the
archive inside the controller's `custom_nodes` directory to install it.

The packager includes an explicit list of runtime files and user guides.
Tests and development tools stay out of the archive. When adding files, update
the repository's `.gitignore` allowlist and, if needed, `tools/package.py`.
Keep deployment data, credentials and test outputs out of the repository.
