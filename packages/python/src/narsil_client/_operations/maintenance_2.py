"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from narsil_client._exchange import Exchange, Upload, json_body, path_segment
from narsil_client._streams import ResponseStream
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import BM25Params, OkResponse, PartitionConfig, SynonymSetBody, TaskRecord


class MaintenanceOperations2(SyncOperationsBase):
    """These methods call the Maintenance routes of a Narsil server."""

    def update_partition_config(
        self,
        name: str,
        body: PartitionConfig | Mapping[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Change the partition settings of an index.

        `POST /indexes/{name}/partition-config`

        Args:
            name: The name of the index.
            body: How many partitions an index opens with, and how many documents it accepts.
                An index opens with `maxPartitions` partitions and keeps that count until
                Narsil.rebalance changes it, because the engine adds no partition on its
                own. Set `watermark` to learn through the `partitionWatermark` event when an
                index fills its capacity.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            OkResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/partition-config",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    def get_synonyms(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> SynonymSetBody:
        """Read the synonym set of an index.

        `GET /indexes/{name}/synonyms`

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
            SynonymSetBody,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/synonyms",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: SynonymSetBody},
            ),
        )

    def update_synonyms(
        self,
        name: str,
        body: SynonymSetBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Replace the synonym set of an index.

        `POST /indexes/{name}/synonyms`

        Args:
            name: The name of the index.
            body: The body of `GET /indexes/{name}/synonyms`, and the body that `POST
                /indexes/{name}/synonyms` takes.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            OkResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/synonyms",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    def update_bm25(
        self,
        name: str,
        body: BM25Params | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Replace the BM25 setting of an index.

        `POST /indexes/{name}/bm25`

        Args:
            name: The name of the index.
            body: BM25 tuning for an index or for one search. Both parameters default to the
                values the literature settles on, so change them only once you have measured
                relevance on your own corpus. For each field, the engine takes the first
                value that is set among the search's value for the field, the search's
                value, the index's value for the field, the index's value, and the default.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            OkResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/bm25",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    def restore(
        self,
        name: str,
        body: Upload,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Restore an index from a snapshot archive, as a task.

        `POST /indexes/{name}/restore`

        Args:
            name: The name of the index.
            body: The client sends these bytes as `application/x-tar`.
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
                    path=f"/indexes/{path_segment(name)}/restore",
                    body=body,
                    content_type="application/x-tar",
                    carries_corpus=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )

    def export_documents(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ResponseStream:
        """Stream a document export of an index.

        `GET /indexes/{name}/export`

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
        return self._transport.stream(
            Exchange(
                method="GET",
                path=f"/indexes/{path_segment(name)}/export",
                carries_corpus=True,
                timeout_ms=timeout_ms,
                headers=headers,
                max_response_bytes=max_response_bytes,
            ),
        )

    def import_document_export(
        self,
        name: str,
        body: Upload,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Import a document export, as a task.

        `POST /indexes/{name}/import`

        Args:
            name: The name of the index.
            body: The client sends these bytes as `application/x-ndjson`.
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
                    path=f"/indexes/{path_segment(name)}/import",
                    body=body,
                    content_type="application/x-ndjson",
                    carries_corpus=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )
