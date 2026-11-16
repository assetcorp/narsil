from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from narsil import Narsil

READER_HOLDS_AFTER_THE_SNAPSHOT_STARTS_SECONDS = 1.0
HOLDING_READER = "\n".join(
    [
        "import sys",
        "held = open(sys.argv[1], 'rb')",
        "print('held', flush=True)",
        "sys.stdin.readline()",
        "held.close()",
    ]
)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows alone refuses to replace a file that a reader holds open")
def test_a_snapshot_to_a_path_saves_once_another_program_closes_the_file_that_it_held_open(
    engine: Narsil, index_name: str, tmp_path: Path
) -> None:
    engine.create_index(index_name, {"schema": {"title": "string"}})
    engine.insert(index_name, {"title": "first ledger"}, "first")
    target = tmp_path / "ledgers.nrsl"
    engine.snapshot(index_name, target)
    engine.insert(index_name, {"title": "second ledger"}, "second")

    reader = subprocess.Popen(
        [sys.executable, "-c", HOLDING_READER, str(target)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert reader.stdin is not None
    assert reader.stdout is not None
    holding = reader.stdin
    release_requested_at: list[float] = []

    def release() -> None:
        release_requested_at.append(time.monotonic())
        holding.close()

    timer = threading.Timer(READER_HOLDS_AFTER_THE_SNAPSHOT_STARTS_SECONDS, release)
    try:
        assert reader.stdout.readline().strip() == "held", "the outside reader exited before it held the snapshot"
        timer.start()
        engine.snapshot(index_name, target)
        saved_at = time.monotonic()
    finally:
        timer.cancel()
        if timer.is_alive():
            timer.join()
        if not holding.closed:
            holding.close()
        reader.wait()

    assert reader.returncode == 0
    assert release_requested_at, "the snapshot saved before the outside reader was asked to close the file"
    assert saved_at > release_requested_at[0]
    engine.restore(f"{index_name}_copy", target)
    assert engine.get(f"{index_name}_copy", "first") == {"title": "first ledger"}
    assert engine.get(f"{index_name}_copy", "second") == {"title": "second ledger"}
