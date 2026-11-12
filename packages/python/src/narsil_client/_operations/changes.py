"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from narsil_client._exchange import Exchange, json_body, path_segment
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import ChangesSetting, ChangesStatus, OkResponse


class ChangesOperations(SyncOperationsBase):
    """These methods call the Changes routes of a Narsil server."""

    def get_changes(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ChangesStatus:
        """Report the change capture setting of an index and its epoch.

        `GET /indexes/{name}/changes`

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
            ChangesStatus,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/changes",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ChangesStatus},
            ),
        )

    def update_changes(
        self,
        name: str,
        body: ChangesSetting | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Replace the change capture setting of an index.

        `PUT /indexes/{name}/changes`

        Args:
            name: The name of the index.
            body: The change capture setting of one index, which
                ChangesOperations.updateChanges takes. A subscriber receives the documents
                of the whole index, so decide which callers may follow an index before you
                turn capture on. A filter only chooses which changes a subscriber receives,
                and it grants no access.
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
                    path=f"/indexes/{path_segment(name)}/changes",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )
