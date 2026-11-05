from __future__ import annotations

from dataclasses import dataclass

from generator.identifiers import pascal, python_identifier, snake
from generator.ir import Answer, Api, ModelDef, Operation, Param, Ref
from generator.python_types import Rendered, render_type
from generator.text import GENERATED_MODULE_DOCSTRING, docstring, ensure_sentence, wrap

OPERATIONS_FILE_LINE_BUDGET = 330
ARG_WIDTH = 76
RESERVED_METHOD_NAMES = frozenset({"close_connections", "self"})
RESERVED_PARAMETER_NAMES = frozenset({"self", "body", "timeout_ms", "headers", "max_response_bytes"})
BODY_FALLBACK = "The route reads this JSON body."
OPTION_DOCS = [
    "timeout_ms: The client waits this many milliseconds for each try of this request, in place of the",
    "    client's setting, and 0 waits for as long as the server takes.",
    "headers: The client adds these headers to this request, replacing any of the same name.",
    "max_response_bytes: The client stops reading the answer past this many bytes, in place of the",
    "    client's setting, and 0 reads whatever the server sends.",
]


@dataclass(frozen=True)
class Flavour:
    package: str
    base: str
    transport_module: str
    def_keyword: str
    await_keyword: str
    stream: str
    upload: str


SYNC = Flavour("_operations", "SyncOperationsBase", "_sync_transport", "def", "", "ResponseStream", "Upload")
ASYNC = Flavour(
    "_async_operations",
    "AsyncOperationsBase",
    "_async_transport",
    "async def",
    "await ",
    "AsyncResponseStream",
    "AsyncUpload",
)


@dataclass
class MethodText:
    lines: list[str]
    rendered: Rendered
    helpers: set[str]


def _param_name(param: Param) -> str:
    return python_identifier(param.json_name, RESERVED_PARAMETER_NAMES)


def _path_expression(operation: Operation) -> str:
    path = operation.path
    for param in operation.params:
        if param.location == "path":
            path = path.replace("{" + param.json_name + "}", "{path_segment(" + _param_name(param) + ")}")
    return f'f"{path}"' if "{" in path else f'"{path}"'


def _query_expression(operation: Operation) -> str | None:
    entries = []
    for param in operation.params:
        if param.location != "query":
            continue
        helper = "query_list" if param.comma_joined else "query_value"
        entries.append(f'"{param.json_name}": {helper}({_param_name(param)})')
    return "{" + ", ".join(entries) + "}" if entries else None


def _answer_type(answers: list[Answer], out: Rendered) -> tuple[str, str]:
    json_answers = [answer for answer in answers if answer.kind == "json" and answer.type is not None]
    mapping = ", ".join(f"{answer.status}: {render_type(answer.type, out)}" for answer in json_answers if answer.type)
    types: list[str] = []
    for answer in json_answers:
        if answer.type is None:
            continue
        rendered = render_type(answer.type, out)
        if rendered not in types:
            types.append(rendered)
    if any(answer.kind == "empty" for answer in answers):
        types.append("None")
    return "{" + mapping + "}", " | ".join(types)


def _body_parameter(operation: Operation, api: Api, out: Rendered, flavour: Flavour) -> tuple[str, str, str]:
    body = operation.body
    if body is None:
        return "", "", ""
    if body.kind == "binary":
        annotation = flavour.upload
        description = f"The client sends these bytes as `{body.content_type}`."
    else:
        annotation = render_type(body.type, out) if body.type is not None else "Any"
        description = body.description or BODY_FALLBACK
        if isinstance(body.type, Ref):
            target = api.definitions.get(body.type.name)
            if isinstance(target, ModelDef):
                out.typing_names.add("Mapping")
                out.typing_names.add("Any")
                annotation = f"{annotation} | Mapping[str, Any]"
                description = body.description or target.description or BODY_FALLBACK
    if not body.required:
        annotation += " | None = None"
    return f"body: {annotation},", ensure_sentence(description), body.kind


def method_text(operation: Operation, api: Api, flavour: Flavour) -> MethodText:
    out = Rendered("")
    name = python_identifier(operation.operation_id, RESERVED_METHOD_NAMES)
    path_params = [param for param in operation.params if param.location == "path"]
    query_params = [param for param in operation.params if param.location == "query"]
    signature = [f"    {flavour.def_keyword} {name}(", "        self,"]
    args_doc: list[str] = []
    for param in path_params:
        signature.append(f"        {_param_name(param)}: str,")
        args_doc.append(f"{_param_name(param)}: {ensure_sentence(param.description)}")
    body_line, body_doc, body_kind = _body_parameter(operation, api, out, flavour)
    if body_line:
        signature.append(f"        {body_line}")
        args_doc.append(f"body: {body_doc}")
    signature.append("        *,")
    for param in query_params:
        annotation = render_type(param.type, out)
        default = "" if param.required else " | None = None"
        signature.append(f"        {_param_name(param)}: {annotation}{default},")
        args_doc.append(f"{_param_name(param)}: {ensure_sentence(param.description)}")
    signature.extend(
        [
            "        timeout_ms: int | None = None,",
            "        headers: Mapping[str, str] | None = None,",
            "        max_response_bytes: int | None = None,",
        ]
    )
    out.typing_names.add("Mapping")
    kinds = {answer.kind for answer in operation.answers if 200 <= answer.status < 300}
    if "binary" in kinds:
        reader, returns = "stream", flavour.stream
    elif "text" in kinds:
        reader, returns = "text", "str"
    elif "json" in kinds:
        reader = "json"
        mapping, returns = _answer_type(list(operation.answers), out)
    else:
        reader, returns = "empty", "None"
    signature.append(f"    ) -> {returns}:")
    args_block: list[str] = []
    for entry in args_doc:
        args_block.extend(_wrap_arg(entry))
    args_block.extend(OPTION_DOCS)
    returns_doc = [
        f"HTTP {answer.status}: {ensure_sentence(answer.description)}"
        for answer in operation.answers
        if answer.description
    ]
    doc = docstring(
        [
            ensure_sentence(operation.summary),
            f"`{operation.method} {operation.path}`",
            ["Args:", *[f"    {line}" for line in args_block]],
            ["Returns:", *[f"    {line}" for line in returns_doc]] if returns_doc else "",
        ],
        "        ",
    )
    opening = f"{flavour.await_keyword}self._transport.{reader}("
    if reader == "json":
        out.typing_names.add("cast")
        opening = f"cast({returns}, {opening}"
    call = [
        f"        return {opening}",
        "            Exchange(",
        f'                method="{operation.method}",',
        f"                path={_path_expression(operation)},",
    ]
    query = _query_expression(operation)
    if query is not None:
        call.append(f"                query={query},")
    if body_kind == "json":
        call.append("                body=json_body(body),")
    elif body_kind == "binary":
        call.append("                body=body,")
    if operation.body is not None:
        call.append(f'                content_type="{operation.body.content_type}",')
    if operation.repeatable:
        call.append("                repeatable=True,")
    if operation.carries_corpus:
        call.append("                carries_corpus=True,")
    call.extend(
        [
            "                timeout_ms=timeout_ms,",
            "                headers=headers,",
            "                max_response_bytes=max_response_bytes,",
            "            ),",
        ]
    )
    if reader == "json":
        call.append(f"            {mapping},")
        call.append("        ))")
    else:
        call.append("        )")
    helpers = {"Exchange"}
    if "path_segment(" in "".join(call):
        helpers.add("path_segment")
    if body_kind == "json":
        helpers.add("json_body")
    for param in query_params:
        helpers.add("query_list" if param.comma_joined else "query_value")
    if body_kind == "binary":
        helpers.add(flavour.upload)
    if reader == "stream":
        helpers.add(flavour.stream)
    return MethodText([*signature, *doc, *call], out, helpers)


def _wrap_arg(entry: str) -> list[str]:
    head, _, rest = entry.partition(": ")
    lines = wrap(rest, "", ARG_WIDTH)
    if not lines:
        return [f"{head}:"]
    return [f"{head}: {lines[0]}", *[f"    {line}" for line in lines[1:]]]


def _class_files(api: Api, flavour: Flavour) -> dict[str, tuple[str, str, list[MethodText]]]:
    files: dict[str, tuple[str, str, list[MethodText]]] = {}
    by_tag: dict[str, list[Operation]] = {}
    for operation in api.operations:
        by_tag.setdefault(operation.tag, []).append(operation)
    for tag, operations in by_tag.items():
        part = 1
        current: list[MethodText] = []
        size = 0
        for operation in operations:
            method = method_text(operation, api, flavour)
            if current and size + len(method.lines) > OPERATIONS_FILE_LINE_BUDGET:
                files[_module(tag, part)] = (tag, _class_name(tag, part), current)
                part += 1
                current, size = [], 0
            current.append(method)
            size += len(method.lines) + 1
        files[_module(tag, part)] = (tag, _class_name(tag, part), current)
    return files


def _module(tag: str, part: int) -> str:
    return snake(tag) if part == 1 else f"{snake(tag)}_{part}"


def _class_name(tag: str, part: int) -> str:
    return f"{pascal(tag)}Operations" if part == 1 else f"{pascal(tag)}Operations{part}"


def _render_class(tag: str, class_name: str, methods: list[MethodText], flavour: Flavour) -> str:
    typing_names: set[str] = set()
    models: set[str] = set()
    helpers: set[str] = set()
    for method in methods:
        typing_names |= method.rendered.typing_names
        models |= method.rendered.model_names
        helpers |= method.helpers
    lines = [GENERATED_MODULE_DOCSTRING, "", "from __future__ import annotations", ""]
    if "Mapping" in typing_names:
        lines.append("from collections.abc import Mapping")
    typing = sorted(name for name in typing_names if name in ("Annotated", "Any", "Literal", "cast"))
    if typing:
        lines.append(f"from typing import {', '.join(typing)}")
    lines.append("")
    if any(method.rendered.uses_open_enum for method in methods):
        lines.append("from narsil_client._model import OPEN_ENUM")
    exchange = sorted(helpers & {"Exchange", "json_body", "path_segment", "query_list", "query_value", flavour.upload})
    lines.append(f"from narsil_client._exchange import {', '.join(exchange)}")
    if flavour.stream in helpers:
        lines.append(f"from narsil_client._streams import {flavour.stream}")
    lines.append(f"from narsil_client.{flavour.transport_module} import {flavour.base}")
    if models:
        lines.append(f"from narsil_client.models import {', '.join(sorted(models))}")
    lines.extend(["", "", f"class {class_name}({flavour.base}):"])
    lines.extend(docstring([f"These methods call the {tag} routes of a Narsil server."], "    "))
    for method in methods:
        lines.append("")
        lines.extend(method.lines)
    return "\n".join(lines) + "\n"


def render_operations(api: Api, flavour: Flavour) -> dict[str, str]:
    output: dict[str, str] = {}
    classes: list[tuple[str, str]] = []
    for module, (tag, class_name, methods) in _class_files(api, flavour).items():
        output[f"{module}.py"] = _render_class(tag, class_name, methods, flavour)
        classes.append((module, class_name))
    combined = "AsyncOperations" if flavour is ASYNC else "Operations"
    index = [GENERATED_MODULE_DOCSTRING, ""]
    index.extend(f"from narsil_client.{flavour.package}.{module} import {name}" for module, name in sorted(classes))
    bases = ", ".join(name for _, name in classes)
    index.extend(["", "", f"class {combined}({bases}):"])
    index.extend(docstring(["These methods call every route of a Narsil server, one method for each route."], "    "))
    output["__init__.py"] = "\n".join(index) + "\n"
    return output
