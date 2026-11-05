from __future__ import annotations

import heapq
import itertools
import socket
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Mapping
from typing import Final

import httpx

from narsil_client._failures import Deadline

TIMEOUT_PHASES: Final = ("connect", "read", "write", "pool")
COMPACT_AFTER_CANCELLED: Final = 256
HTTP1_VERSIONS: Final = frozenset({"HTTP/1.0", "HTTP/1.1"})


class LiveTimeouts(Mapping[str, float | None]):
    def __init__(self, deadline: Deadline) -> None:
        self._deadline = deadline

    def __getitem__(self, phase: str) -> float | None:
        if phase not in TIMEOUT_PHASES:
            raise KeyError(phase)
        return self._deadline.wait_seconds()

    def __iter__(self) -> Iterator[str]:
        return iter(TIMEOUT_PHASES)

    def __len__(self) -> int:
        return len(TIMEOUT_PHASES)


def deadline_checked(chunks: Iterable[bytes], deadline: Deadline) -> Iterator[bytes]:
    for chunk in chunks:
        deadline.check()
        yield chunk


class Alarm:
    __slots__ = ("action", "cancelled", "when")

    def __init__(self, when: float, action: Callable[[], None]) -> None:
        self.when = when
        self.action = action
        self.cancelled = False


class Watchdog:
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._alarms: list[tuple[float, int, Alarm]] = []
        self._sequence = itertools.count()
        self._cancelled = 0
        self._thread: threading.Thread | None = None

    def schedule(self, delay: float, action: Callable[[], None]) -> Alarm:
        alarm = Alarm(time.monotonic() + delay, action)
        with self._condition:
            heapq.heappush(self._alarms, (alarm.when, next(self._sequence), alarm))
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._watch, name="narsil-client-deadlines", daemon=True)
                self._thread.start()
            elif self._alarms[0][2] is alarm:
                self._condition.notify()
        return alarm

    def cancel(self, alarm: Alarm) -> None:
        with self._condition:
            if alarm.cancelled:
                return
            alarm.cancelled = True
            self._cancelled += 1
            if self._cancelled >= COMPACT_AFTER_CANCELLED and self._cancelled * 2 >= len(self._alarms):
                self._alarms = [entry for entry in self._alarms if not entry[2].cancelled]
                heapq.heapify(self._alarms)
                self._cancelled = 0

    def _next_due(self) -> Alarm:
        with self._condition:
            while True:
                while self._alarms and self._alarms[0][2].cancelled:
                    heapq.heappop(self._alarms)
                    self._cancelled = max(self._cancelled - 1, 0)
                if not self._alarms:
                    self._condition.wait()
                    continue
                wait = self._alarms[0][0] - time.monotonic()
                if wait <= 0:
                    due = heapq.heappop(self._alarms)[2]
                    due.cancelled = True
                    return due
                self._condition.wait(wait)

    def _watch(self) -> None:
        while True:
            self._next_due().action()


WATCHDOG: Final = Watchdog()


def _http1_socket(response: httpx.Response) -> socket.socket | None:
    if response.http_version not in HTTP1_VERSIONS:
        return None
    stream = response.extensions.get("network_stream")
    get_extra_info = getattr(stream, "get_extra_info", None)
    if not callable(get_extra_info):
        return None
    found = get_extra_info("socket")
    return found if isinstance(found, socket.socket) else None


class StallGuard:
    def __init__(self, response: httpx.Response, deadline: Deadline) -> None:
        self._lock = threading.Lock()
        self._finished = False
        self._alarm: Alarm | None = None
        remaining = deadline.remaining()
        target = _http1_socket(response)
        if remaining is None or target is None:
            return
        self._target = target
        self._alarm = WATCHDOG.schedule(remaining, self._cut)

    def _cut(self) -> None:
        with self._lock:
            if self._finished:
                return
            self._finished = True
            try:
                socket.socket.shutdown(self._target, socket.SHUT_RDWR)
            except OSError:
                return

    def stop(self) -> None:
        with self._lock:
            self._finished = True
        if self._alarm is not None:
            WATCHDOG.cancel(self._alarm)
