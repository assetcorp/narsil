from __future__ import annotations


class NarsilError(Exception):
    """The error that a Narsil operation raises when the engine refuses or fails the call.

    ``code`` holds the error code from the Narsil specification, such as ``"INDEX_NOT_FOUND"`` or
    ``"DOC_VALIDATION_FAILED"``, and ``message`` describes the failure. When a Python adapter, tokenizer, or plugin
    raises another exception, the caller receives a ``NarsilError`` whose message holds that exception's type and
    text. When the Python code raises a ``NarsilError``, the caller receives that code and message unchanged.
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
