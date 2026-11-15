from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path

from .config import BenchmarkConfig, EngineConfig
from .types import EngineError

IDENTITY_FILENAME = "identity.json"


def _harness_digest() -> str:
    root = Path(__file__).resolve().parents[1]
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def bind_checkpoints(
    directory: Path,
    build_identity: dict | None,
    image_digest: str | None,
    config: BenchmarkConfig,
    engine: EngineConfig,
    vector_profile: str,
    share_vector_index: bool,
) -> None:
    if not image_digest and not (build_identity or {}).get("version"):
        raise EngineError("checkpoint identity needs the engine version or image digest; check the engine connection")
    identity = {
        "build_identity": build_identity,
        "image_digest": image_digest,
        "harness_sha256": _harness_digest(),
        "config": asdict(config),
        "engine": asdict(engine),
        "vector_profile": vector_profile,
        "share_vector_index": share_vector_index,
    }
    encoded = json.dumps(identity, sort_keys=True)
    expected = json.loads(encoded)
    path = directory / IDENTITY_FILENAME
    directory.mkdir(parents=True, exist_ok=True)
    if not path.exists() and any(directory.glob("*.json")):
        raise EngineError(f"checkpoints in {directory} have no build identity; choose a new BENCH_RUN_ID")
    try:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        try:
            recorded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise EngineError(f"checkpoint identity at {path} is unreadable; choose a new BENCH_RUN_ID") from error
        if recorded != expected:
            raise EngineError(
                f"checkpoint identity at {path} differs from this engine build, harness, or configuration; "
                "choose a new BENCH_RUN_ID"
            )
