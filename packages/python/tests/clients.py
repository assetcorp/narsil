from __future__ import annotations

import inspect
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from narsil_client import AsyncNarsilClient, NarsilClient

CLIENT_FORMS = ["sync", "async"]


async def settle(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


@asynccontextmanager
async def open_client(form: str, url: str | list[str], **options: Any) -> AsyncIterator[Any]:
    if form == "sync":
        with NarsilClient(url, **options) as client:
            yield client
    else:
        async with AsyncNarsilClient(url, **options) as client:
            yield client
