from __future__ import annotations

import httpx

POOL_CONNECTIONS = 256
"""Largest concurrency the throughput load generator may drive against one engine.

A driver keeps a single client and the load generator issues one in-flight request
per worker, so the connection pool must be at least as large as the configured
concurrency or workers would serialize on a connection. Keep-alive is set to the
same value so a localhost run reuses connections instead of paying a fresh TCP
handshake per request, which would otherwise dominate a sub-millisecond engine
response and make the harness, not the engine, the thing being timed. The
throughput config rejects any concurrency above this ceiling."""


def build_client(
    base_url: str, *, headers: dict[str, str] | None = None, timeout: float = 120.0
) -> httpx.Client:
    """One shared HTTP client per driver, sized so concurrent load reuses pooled
    keep-alive connections. The same client is safe to call from many threads, so
    the serial and concurrent measurements drive the engine through it identically."""

    limits = httpx.Limits(max_connections=POOL_CONNECTIONS, max_keepalive_connections=POOL_CONNECTIONS)
    return httpx.Client(base_url=base_url, timeout=timeout, headers=headers, limits=limits)
