from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest

from tests.servers import ForwardingProxy, NodeProcess, free_port

SECURED_API_KEY = "narsil-client-test-key"
SECURED_MAX_IMPORT_BYTES = 4096


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="session")
def server_url() -> Iterator[str]:
    node = NodeProcess({})
    node.start()
    yield node.url
    node.stop()


@pytest.fixture(scope="session")
def secured_server_url() -> Iterator[str]:
    node = NodeProcess({"apiKey": SECURED_API_KEY, "maxImportBytes": SECURED_MAX_IMPORT_BYTES})
    node.start()
    yield node.url
    node.stop()


@pytest.fixture(scope="session")
def proxy_to_nowhere_url() -> Iterator[str]:
    proxy = ForwardingProxy(free_port())
    yield proxy.url
    proxy.close()


@pytest.fixture
def index_name() -> str:
    return f"py_{uuid.uuid4().hex[:12]}"
