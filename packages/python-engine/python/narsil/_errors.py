from __future__ import annotations


class NarsilError(Exception):
    """The error that every Narsil operation raises.

    ``code`` holds the error code from the Narsil specification, such as ``"INDEX_NOT_FOUND"`` or
    ``"DOC_VALIDATION_FAILED"``, and ``message`` holds the text that explains it. An exception that a Python
    adapter, tokenizer, or plugin raises reaches the caller as a ``NarsilError`` whose message names the
    exception's type and text, unless that code raised a ``NarsilError`` itself, in which case its code and
    message reach the caller unchanged.
    """

    code: str
    message: str

    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message)
        self.code = code
        self.message = message

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def __repr__(self) -> str:
        return f"NarsilError({self.code!r}, {self.message!r})"

    def __reduce__(self) -> tuple[type[NarsilError], tuple[str, str]]:
        return (NarsilError, (self.code, self.message))
