from __future__ import annotations

import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

from narsil import Narsil

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_ROOT = PACKAGE_ROOT.parent.parent
CONFORMANCE_ROOT = REPOSITORY_ROOT / "packages" / "conformance"
PREPARED_REFERENCE_VARIABLE = "NARSIL_TYPESCRIPT_REFERENCE"


@pytest.fixture
def engine() -> Iterator[Narsil]:
    with Narsil() as opened:
        yield opened


@pytest.fixture
def index_name() -> str:
    return f"py_{uuid.uuid4().hex[:12]}"
