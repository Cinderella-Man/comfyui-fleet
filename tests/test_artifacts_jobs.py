import asyncio
import json
import os
import uuid
import weakref

import pytest

from fleet.artifacts import Artifacts, publish, read_regular
from fleet.jobs import merged_jobs
from fleet.validation import worker_url, file_reference
from test_ledger import batch, admit
from test_ledger import history


@pytest.fixture
def artifacts(tmp_path):
    roots = {kind: tmp_path / kind for kind in ("input", "output", "temp")}
    for p in roots.values():
        p.mkdir()
    return Artifacts(tmp_path / "state", roots)


def test_fifo_input_is_rejected_without_waiting_for_a_writer(tmp_path):
    os.mkfifo(tmp_path / "not-an-image")
    with pytest.raises(ValueError, match="ordinary file"):
        read_regular(tmp_path, "not-an-image")


def test_snapshot_survives_original_change_and_rewrites_only_standard_reference(artifacts):
    source = artifacts.roots["input"] / "mask.png"
    source.write_bytes(b"first immutable bytes")
    graph = {
        "1": {"class_type": "LoadImageMask", "inputs": {"image": "mask.png", "channel": "red"}},
        "2": {"class_type": "Text", "inputs": {"text": "mask.png"}},
    }
    assets = artifacts.snapshot(graph)
    source.write_bytes(b"changed")

    class Remote:
        async def upload(self, url, name, subfolder, data):
            assert data == b"first immutable bytes"
            return {"name": name, "subfolder": subfolder, "type": "input"}

    result = asyncio.run(
        artifacts.prepare(
            {"graph": graph, "assets": assets, "worker_url": "http://127.0.0.1:8188"}, Remote()
        )
    )
    assert result["1"]["inputs"]["channel"] == "red"
    assert result["2"] == graph["2"]
    assert result["1"]["inputs"]["image"] != graph["1"]["inputs"]["image"]
    assert graph["1"]["inputs"]["image"] == "mask.png"


def test_output_collision_100_images_and_byte_identical_retry(artifacts):
    refs = [{"filename": "same.png", "subfolder": str(i), "type": "output"} for i in range(100)]
    row = {
        "id": str(uuid.uuid4()),
        "remote_id": str(uuid.uuid4()),
        "worker_url": "http://127.0.0.1:8188",
        "history": {"outputs": {"9": {"images": refs, "text": ["keep metadata"]}}},
    }

    class Remote:
        async def download(self, url, ref):
            return ("bytes:" + ref["subfolder"]).encode()

    result = asyncio.run(artifacts.collect(row, Remote()))
    assert not (artifacts.output / row["id"] / "fleet-manifest.json").exists()
    assert len(result["9"]["images"]) == 100
    assert result["9"]["text"] == ["keep metadata"]
    assert asyncio.run(artifacts.collect(row, Remote())) == result
    for i, ref in enumerate(result["9"]["images"]):
        assert read_regular(artifacts.output / row["id"], ref["filename"]) == f"bytes:{i}".encode()


def test_collection_releases_each_file_buffer_before_downloading_the_next(artifacts):
    row = {
        "id": str(uuid.uuid4()),
        "remote_id": str(uuid.uuid4()),
        "worker_url": "http://127.0.0.1:8188",
        "history": {
            "outputs": {
                "1": {
                    "images": [
                        {"filename": "one.png"},
                        {"filename": "two.png"},
                    ]
                }
            }
        },
    }

    class Payload(bytearray):
        pass

    class Remote:
        previous = None

        async def download(self, url, ref):
            assert self.previous is None or self.previous() is None
            data = Payload(ref["filename"].encode())
            self.previous = weakref.ref(data)
            return data

    remote = Remote()
    outputs = asyncio.run(artifacts.collect(row, remote))
    assert remote.previous() is None
    assert len(outputs["1"]["images"]) == 2


@pytest.mark.parametrize("layout", ["flat", "batch"])
def test_shared_output_folders_keep_jobs_branches_and_batches_distinct(artifacts, layout):
    artifacts.output_layout = layout
    batch_id = str(uuid.uuid4())
    rows = [
        {
            "id": str(uuid.uuid4()),
            "batch_id": batch_id if i < 2 else str(uuid.uuid4()),
            "remote_id": str(uuid.uuid4()),
            "worker_url": f"http://127.0.0.{i + 1}:8188",
            "history": {
                "outputs": {
                    "9": {
                        "images": [
                            {"filename": "same.png", "subfolder": branch} for branch in ("a", "b")
                        ]
                    }
                }
            },
        }
        for i in range(3)
    ]

    class Remote:
        async def download(self, url, ref):
            return (url + "/" + ref["subfolder"]).encode()

    paths = set()
    for row in rows:
        output = asyncio.run(artifacts.collect(row, Remote()))
        for ref in output["9"]["images"]:
            expected = "fleet" if layout == "flat" else f"fleet/batch-{row['batch_id']}"
            assert ref["subfolder"] == expected
            path = artifacts.roots["output"] / ref["subfolder"] / ref["filename"]
            paths.add(path)
            assert path.read_bytes().startswith(row["worker_url"].encode())
        assert asyncio.run(artifacts.collect(row, Remote())) == output
    assert len(paths) == 6
    assert len(list(artifacts.output.iterdir())) == (6 if layout == "flat" else 2)


@pytest.mark.parametrize("layout", ["flat", "batch", "job"])
def test_partial_collection_keeps_its_layout_after_reconfiguration(artifacts, layout):
    artifacts.output_layout = layout
    row = {
        "id": str(uuid.uuid4()),
        "batch_id": str(uuid.uuid4()),
        "remote_id": str(uuid.uuid4()),
        "worker_url": "http://127.0.0.1:8188",
        "history": {
            "outputs": {"9": {"images": [{"filename": "one.png"}, {"filename": "two.png"}]}}
        },
    }

    class Remote:
        fail = True

        async def download(self, url, ref):
            if self.fail and ref["filename"] == "two.png":
                raise OSError("Interrupted transfer")
            return ref["filename"].encode()

    remote = Remote()
    with pytest.raises(OSError, match="Interrupted"):
        asyncio.run(artifacts.collect(row, remote))
    first = next(artifacts.output.rglob("*.png"))
    restarted = Artifacts(
        artifacts.blobs.parent,
        artifacts.roots,
        output_layout="flat" if layout != "flat" else "batch",
    )
    remote.fail = False
    output = asyncio.run(restarted.collect(row, remote))
    assert len(list(artifacts.output.rglob("*.png"))) == 2
    assert first.read_bytes() == b"one.png"
    for ref in output["9"]["images"]:
        assert (artifacts.roots["output"] / ref["subfolder"]) == first.parent


@pytest.mark.parametrize("layout", ["flat", "batch"])
def test_shared_output_long_names_and_conflicts(artifacts, layout):
    artifacts.output_layout = layout
    row = {
        "id": str(uuid.uuid4()),
        "batch_id": str(uuid.uuid4()),
        "remote_id": str(uuid.uuid4()),
        "worker_url": "http://127.0.0.1:8188",
        "history": {"outputs": {"9": {"images": [{"filename": "x" * 230 + ".png"}]}}},
    }

    class Remote:
        data = b"original bytes"

        async def download(self, url, ref):
            return self.data

    remote = Remote()
    ref = asyncio.run(artifacts.collect(row, remote))["9"]["images"][0]
    assert len(ref["filename"].encode()) <= 240
    assert ref["filename"].endswith(".png")
    # A normal-length conflicting result must fail without overwriting.
    row["history"]["outputs"]["9"]["images"][0]["filename"] = "one.png"
    ref = asyncio.run(artifacts.collect(row, remote))["9"]["images"][0]
    remote.data = b"different bytes"
    with pytest.raises(ValueError, match="refusing to overwrite"):
        asyncio.run(artifacts.collect(row, remote))
    assert (
        read_regular(artifacts.roots["output"], ref["subfolder"] + "/" + ref["filename"])
        == b"original bytes"
    )


def test_unknown_output_layout_rejected_before_creating_storage(tmp_path):
    with pytest.raises(ValueError, match="FLEET_OUTPUT_LAYOUT"):
        Artifacts(tmp_path / "state", {"output": tmp_path / "output"}, output_layout="typo")
    assert not (tmp_path / "state").exists()


def test_collection_retry_preserves_legacy_manifest_and_rejects_conflicting_identity(artifacts):
    row = {
        "id": str(uuid.uuid4()),
        "remote_id": str(uuid.uuid4()),
        "worker_url": "http://127.0.0.1:8188",
        "history": {"outputs": {"9": {"images": [{"filename": "one.png"}]}}},
    }
    destination = artifacts.output / row["id"]
    output = {
        "9": {
            "images": [
                {
                    "filename": "0001-one.png",
                    "subfolder": f"fleet/{row['id']}",
                    "type": "output",
                }
            ]
        }
    }
    original = json.dumps(
        {"run_id": row["id"], "remote_id": row["remote_id"], "outputs": output}, indent=2
    ).encode()
    publish(destination, "0001-one.png", b"image")
    publish(destination, "fleet-manifest.json", original)

    class Remote:
        async def download(self, url, ref):
            return b"image"

    assert asyncio.run(artifacts.collect(row, Remote())) == output
    assert read_regular(destination, "fleet-manifest.json") == original
    with pytest.raises(ValueError, match="refusing to overwrite"):
        asyncio.run(artifacts.collect({**row, "remote_id": str(uuid.uuid4())}, Remote()))
    assert read_regular(destination, "fleet-manifest.json") == original


def test_symlinks_traversal_and_nonidentical_publication_rejected(artifacts, tmp_path):
    (artifacts.roots["input"] / "linked").symlink_to(tmp_path, target_is_directory=True)
    (tmp_path / "private").write_text("private")
    with pytest.raises(OSError):
        read_regular(artifacts.roots["input"], "linked/private")
    with pytest.raises(ValueError):
        read_regular(artifacts.roots["input"], "../private")
    publish(artifacts.blobs, "one", b"one")
    with pytest.raises(ValueError):
        publish(artifacts.blobs, "one", b"two")
    assert read_regular(artifacts.blobs, "one") == b"one"


def test_snapshot_cleanup_preserves_live_inputs_originals_and_outputs(artifacts):
    original = artifacts.roots["input"] / "original.png"
    original.write_bytes(b"original")
    output = artifacts.output / "saved.png"
    output.write_bytes(b"saved result")
    publish(artifacts.blobs, "a" * 64, b"live")
    publish(artifacts.blobs, "b" * 64, b"finished")
    (artifacts.blobs / ("c" * 64)).symlink_to(original)
    (artifacts.blobs / f".{uuid.uuid4()}.part").write_bytes(b"interrupted snapshot")
    artifacts.prune_inputs({"a" * 64})
    assert [p.name for p in artifacts.blobs.iterdir()] == ["a" * 64]
    assert original.read_bytes() == b"original"
    assert output.read_bytes() == b"saved result"


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254",
        "http://8.8.8.8",
        "http://localhost:8188",
        "http://127.0.0.1:8188/x",
        "http://user:pass@127.0.0.1",
        "http://127.0.0.1/?x=1",
    ],
)
def test_unapproved_endpoint_forms_rejected(url):
    with pytest.raises(ValueError):
        worker_url(url)


@pytest.mark.parametrize(
    "ref",
    [
        {"filename": "../x"},
        {"filename": "x", "subfolder": "a/../b"},
        {"filename": "x", "type": "secret"},
    ],
)
def test_unsafe_worker_paths_rejected(ref):
    with pytest.raises(ValueError):
        file_reference(ref)


def test_merge_filters_duplicate_self_worker_records_before_pagination(ledger):
    admit(ledger, batch(2))
    owned = ledger.claim("a")
    local = [
        {"id": owned["remote_id"], "status": "pending", "create_time": 1},
        {"id": str(uuid.uuid4()), "status": "completed", "create_time": 2},
    ]
    merged = merged_jobs(ledger.jobs(), local, {"limit": "1", "offset": "2"})
    assert merged["pagination"]["total"] == 3
    assert len(merged["jobs"]) == 1
    assert merged["jobs"][0]["id"] == local[1]["id"]


def test_cleared_history_does_not_reappear_under_the_self_workers_remote_id(ledger):
    admit(ledger, batch(1))
    row = ledger.claim("a")
    ledger.begin_submit(row["id"])
    ledger.finish(row["id"], history())
    ledger.collected(row["id"], {})
    ledger.prune()
    ledger.action(row["id"], "hide")
    local = [{"id": row["remote_id"], "status": "completed", "create_time": 1}]
    assert merged_jobs(ledger.jobs(), local, {})["jobs"] == []
    assert ledger.state()["jobs"] == []
    assert ledger.job(row["id"]) is None
    assert ledger.db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
