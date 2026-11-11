from __future__ import annotations

import atexit
import threading
import traceback
import weakref
from typing import Any

from narsil import _native

_live_engines: weakref.WeakSet[Narsil] = weakref.WeakSet()
_live_engines_lock = threading.Lock()


class Narsil(_native.Narsil):
    """A Narsil engine that holds its indexes inside this Python process.

    Every method releases the interpreter lock while the engine works, so other Python threads can carry on, and
    several threads can call one engine at once. Pass ``config`` as a dict with the engine settings of the Narsil
    specification, such as ``{"durability": {"directory": "./data"}}``. The engine shuts down when the ``with``
    block that holds it ends, when the program calls :meth:`shutdown`, or when the interpreter exits, and a durable
    engine flushes its logs to the disk as it shuts down.
    """

    __slots__ = ()

    def __init__(self, config: Any = None) -> None:
        with _live_engines_lock:
            _live_engines.add(self)


def _shut_down_live_engines() -> None:
    with _live_engines_lock:
        engines = list(_live_engines)
    for engine in engines:
        try:
            engine.shutdown()
        except Exception as error:
            traceback.print_exception(error)


atexit.register(_shut_down_live_engines)
