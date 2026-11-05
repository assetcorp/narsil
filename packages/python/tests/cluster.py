from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from tests.servers import NodeProcess, free_port

ETCD_ENDPOINT_VARIABLE = "NARSIL_ETCD_ENDPOINT"
NODE_COUNT = 3
PARTITION_COUNT = 3
REPLICATION_FACTOR = 1
HEARTBEAT_TTL_SECONDS = 5
CONTROLLER_LEASE_TTL_MS = 5_000
STANDBY_RETRY_MS = 1_000
WAIT_FOR_SERVING_MS = 30_000


def etcd_endpoint() -> str:
    endpoint = os.environ.get(ETCD_ENDPOINT_VARIABLE, "")
    if endpoint == "":
        pytest.skip(f"The cluster test needs a running etcd at {ETCD_ENDPOINT_VARIABLE}")
    return endpoint


@contextmanager
def running_cluster(directory: Path) -> Iterator[list[NodeProcess]]:
    endpoint = etcd_endpoint()
    key_prefix = f"_narsil_python_client_{uuid.uuid4().hex}"
    nodes = [
        NodeProcess(
            {
                "mode": "cluster",
                "etcdEndpoints": [endpoint],
                "keyPrefix": key_prefix,
                "heartbeatTtlSeconds": HEARTBEAT_TTL_SECONDS,
                "nodeId": f"python-client-node-{slot}",
                "httpPort": free_port(),
                "transportPort": free_port(),
                "directory": str(directory / f"node-{slot}"),
                "backupDirectory": str(directory / "backups"),
                "controllerLeaseTtlMs": CONTROLLER_LEASE_TTL_MS,
                "standbyRetryMs": STANDBY_RETRY_MS,
                "partitionCount": PARTITION_COUNT,
                "replicationFactor": REPLICATION_FACTOR,
                "waitForServingMs": WAIT_FOR_SERVING_MS,
            }
        )
        for slot in range(NODE_COUNT)
    ]
    try:
        for node in nodes:
            node.start()
        yield nodes
    finally:
        for node in nodes:
            node.stop()
