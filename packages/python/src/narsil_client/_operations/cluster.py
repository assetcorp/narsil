"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from narsil_client._exchange import Exchange, json_body, path_segment
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import (
    BackupListResponse,
    ClusterAllocationResponse,
    ClusterHealth,
    ClusterTopologyResponse,
    CreateBackupBody,
    ReplicationFactorBody,
    ReplicationFactorResponse,
    RestoreBackupBody,
    TaskRecord,
)


class ClusterOperations(SyncOperationsBase):
    """These methods call the Cluster routes of a Narsil server."""

    def get_cluster_topology(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ClusterTopologyResponse:
        """Report the nodes of the cluster and the controller.

        `GET /cluster`

        Args:
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            ClusterTopologyResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/cluster",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ClusterTopologyResponse},
            ),
        )

    def get_cluster_health(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ClusterHealth:
        """Report a green, yellow, or red status for the cluster and each index.

        `GET /cluster/health`

        Args:
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            ClusterHealth,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/cluster/health",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ClusterHealth},
            ),
        )

    def get_metrics(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> str:
        """Report the replication and coordinator figures in the Prometheus text format.

        `GET /metrics`

        Args:
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return self._transport.text(
            Exchange(
                method="GET",
                path="/metrics",
                timeout_ms=timeout_ms,
                headers=headers,
                max_response_bytes=max_response_bytes,
            ),
        )

    def get_index_allocation(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ClusterAllocationResponse:
        """Report how the cluster has placed the partitions of an index.

        `GET /indexes/{name}/cluster`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            ClusterAllocationResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/cluster",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ClusterAllocationResponse},
            ),
        )

    def set_replication_factor(
        self,
        name: str,
        body: ReplicationFactorBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ReplicationFactorResponse:
        """Change how many replicas each partition of an index keeps.

        `PUT /indexes/{name}/replication-factor`

        Args:
            name: The name of the index.
            body: The body that `PUT /indexes/{name}/replication-factor` takes.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            ReplicationFactorResponse,
            self._transport.json(
                Exchange(
                    method="PUT",
                    path=f"/indexes/{path_segment(name)}/replication-factor",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ReplicationFactorResponse},
            ),
        )

    def create_backup(
        self,
        name: str,
        body: CreateBackupBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Back up an index to the store outside the cluster, as a task.

        `POST /indexes/{name}/backups`

        Args:
            name: The name of the index.
            body: The body of `POST /indexes/{name}/backups`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/backups",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )

    def list_backups(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> BackupListResponse:
        """List the backups in the store outside the cluster.

        `GET /backups`

        Args:
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            BackupListResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/backups",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: BackupListResponse},
            ),
        )

    def restore_backup(
        self,
        backup: str,
        body: RestoreBackupBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Restore a backup as a new index, as a task.

        `POST /backups/{backup}/_restore`

        Args:
            backup: The name of the backup.
            body: The body of `POST /backups/{backup}/_restore`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/backups/{path_segment(backup)}/_restore",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )

    def delete_backup(
        self,
        backup: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Delete a backup and the files that no other backup lists, as a task.

        `DELETE /backups/{backup}`

        Args:
            backup: The name of the backup.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            self._transport.json(
                Exchange(
                    method="DELETE",
                    path=f"/backups/{path_segment(backup)}",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )
