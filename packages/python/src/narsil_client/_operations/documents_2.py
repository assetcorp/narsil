"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, Literal, cast

from narsil_client._exchange import Exchange, json_body, path_segment, query_value
from narsil_client._model import OPEN_ENUM
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import DocumentBody, DocumentExistsResponse, DocumentIdResponse, DocumentRemovedResponse


class DocumentsOperations2(SyncOperationsBase):
    """These methods call the Documents routes of a Narsil server."""

    def update(
        self,
        name: str,
        id: str,
        body: DocumentBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentIdResponse:
        """Update one existing document.

        `PATCH /indexes/{name}/documents/{id}`

        Args:
            name: The name of the index.
            id: The id of the document.
            body: The body of `PUT` and of `PATCH /indexes/{name}/documents/{id}`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            DocumentIdResponse,
            self._transport.json(
                Exchange(
                    method="PATCH",
                    path=f"/indexes/{path_segment(name)}/documents/{path_segment(id)}",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: DocumentIdResponse},
            ),
        )

    def remove(
        self,
        name: str,
        id: str,
        *,
        wait: Annotated[Literal["true", "false"], OPEN_ENUM] | None = None,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentRemovedResponse:
        """Remove one document.

        `DELETE /indexes/{name}/documents/{id}`

        Args:
            name: The name of the index.
            id: The id of the document.
            wait: Under `true`, the server answers only once every worker copy has applied the
                removal.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            DocumentRemovedResponse,
            self._transport.json(
                Exchange(
                    method="DELETE",
                    path=f"/indexes/{path_segment(name)}/documents/{path_segment(id)}",
                    query={"wait": query_value(wait)},
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: DocumentRemovedResponse},
            ),
        )

    def has(
        self,
        name: str,
        id: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentExistsResponse:
        """Report whether an index holds a document with the id.

        `GET /indexes/{name}/documents/{id}/_exists`

        Args:
            name: The name of the index.
            id: The id of the document.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            DocumentExistsResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/documents/{path_segment(id)}/_exists",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: DocumentExistsResponse},
            ),
        )
