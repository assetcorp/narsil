"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from narsil_client._exchange import Exchange, json_body, path_segment
from narsil_client._streams import ResponseStream
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import OkResponse, SyncSetting


class SyncOperations(SyncOperationsBase):
    """These methods call the Sync routes of a Narsil server."""

    def update_sync(
        self,
        name: str,
        body: SyncSetting | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Replace the device sync setting of an index.

        `PUT /indexes/{name}/sync`

        Args:
            name: The name of the index.
            body: The device sync setting of one index, which SyncOperations.updateSync takes.
                Turn sync on only for an index whose every document belongs to one user,
                because every device that syncs the index receives the whole index. Create
                one index for each user, and leave sync off for a public index or for an
                index that holds the data of several users.
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
                    method="PUT",
                    path=f"/indexes/{path_segment(name)}/sync",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    def sync_snapshot(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ResponseStream:
        """Download the published snapshot of an index with device sync on, whole or as one
        byte range.

        `GET /indexes/{name}/sync/snapshot`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
            HTTP 206: The server answered with the byte range that the request asked for.
        """
        return self._transport.stream(
            Exchange(
                method="GET",
                path=f"/indexes/{path_segment(name)}/sync/snapshot",
                carries_corpus=True,
                timeout_ms=timeout_ms,
                headers=headers,
                max_response_bytes=max_response_bytes,
            ),
        )
