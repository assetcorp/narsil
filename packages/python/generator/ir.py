from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from generator.identifiers import pascal

SCHEMA_PREFIX = "#/components/schemas/"
HTTP_METHODS = ("get", "put", "post", "patch", "delete")
BINARY_FORMAT = "binary"
REPEATABLE_EXTENSION = "x-narsil-repeatable"
JSON_CONTENT = "application/json"
UNION_KEYWORDS = ("anyOf", "oneOf")


@dataclass(frozen=True)
class Prim:
    kind: str


@dataclass(frozen=True)
class Lit:
    values: tuple[str | int | float | bool, ...]


@dataclass(frozen=True)
class ListOf:
    item: TypeRef


@dataclass(frozen=True)
class TupleOf:
    item: TypeRef
    size: int


@dataclass(frozen=True)
class MapOf:
    value: TypeRef


@dataclass(frozen=True)
class Ref:
    name: str


@dataclass(frozen=True)
class UnionOf:
    options: tuple[TypeRef, ...]


@dataclass(frozen=True)
class Nullable:
    inner: TypeRef


TypeRef = Prim | Lit | ListOf | TupleOf | MapOf | Ref | UnionOf | Nullable

STRING = Prim("str")
NUMBER = Prim("number")
BOOLEAN = Prim("bool")
NULL = Prim("null")
ANY = Prim("any")
OPEN_OBJECT = Prim("open_object")


@dataclass(frozen=True)
class FieldDef:
    json_name: str
    type: TypeRef
    required: bool
    description: str


@dataclass(frozen=True)
class ModelDef:
    name: str
    description: str
    fields: tuple[FieldDef, ...]


@dataclass(frozen=True)
class AliasDef:
    name: str
    description: str
    type: TypeRef


Definition = ModelDef | AliasDef


@dataclass(frozen=True)
class Param:
    json_name: str
    location: str
    required: bool
    type: TypeRef
    description: str
    comma_joined: bool


@dataclass(frozen=True)
class Body:
    kind: str
    content_type: str
    type: TypeRef | None
    required: bool
    description: str


@dataclass(frozen=True)
class Answer:
    status: int
    kind: str
    content_type: str
    type: TypeRef | None
    description: str


@dataclass(frozen=True)
class Operation:
    operation_id: str
    method: str
    path: str
    tag: str
    summary: str
    params: tuple[Param, ...]
    body: Body | None
    answers: tuple[Answer, ...]
    repeatable: bool

    @property
    def carries_corpus(self) -> bool:
        if self.body is not None and self.body.kind == "binary":
            return True
        return any(answer.kind == "binary" for answer in self.answers)


@dataclass
class Api:
    definitions: dict[str, Definition] = field(default_factory=dict)
    operations: list[Operation] = field(default_factory=list)


class SpecError(Exception):
    pass


def _description(schema: dict[str, Any]) -> str:
    text = schema.get("description", "")
    return " ".join(text.split()) if isinstance(text, str) else ""


class _Builder:
    def __init__(self, document: dict[str, Any]) -> None:
        components = document.get("components", {})
        self.schemas: dict[str, Any] = components.get("schemas", {})
        self.responses: dict[str, Any] = components.get("responses", {})
        self.api = Api()

    def define(self, name: str, definition: Definition) -> None:
        if name in self.api.definitions:
            raise SpecError(f"Two schemas would both become the type {name}")
        self.api.definitions[name] = definition

    def ref_name(self, ref: str) -> str:
        if not ref.startswith(SCHEMA_PREFIX):
            raise SpecError(f"The generator reads only component schema references, and found {ref}")
        name = ref[len(SCHEMA_PREFIX) :]
        if name not in self.schemas:
            raise SpecError(f"The file holds no schema for the reference {ref}")
        return name

    def is_model(self, schema: dict[str, Any]) -> bool:
        if "properties" not in schema:
            return False
        extra = schema.get("additionalProperties")
        return extra is not True and extra != {}

    def top_level(self, name: str, schema: dict[str, Any]) -> None:
        if self.is_model(schema):
            self.model(name, schema)
            return
        self.define(name, AliasDef(name, _description(schema), self.convert(schema, name)))

    def model(self, name: str, schema: dict[str, Any], where: str = "") -> Ref:
        required = set(schema.get("required", []))
        fields = tuple(
            FieldDef(
                json_name=key,
                type=self.convert(value, name + pascal(key), f"the `{key}` field of `{name}`"),
                required=key in required,
                description=_description(value),
            )
            for key, value in schema["properties"].items()
        )
        description = _description(schema) or (f"The shape of {where}." if where else "")
        self.define(name, ModelDef(name, description, fields))
        return Ref(name)

    def union(self, options: list[dict[str, Any]], hint: str, where: str = "") -> TypeRef:
        nullable = any(option.get("type") == "null" for option in options)
        rest = [option for option in options if option.get("type") != "null"]
        objects = [option for option in rest if self.is_model(option)]
        converted: list[TypeRef] = []
        for position, option in enumerate(rest):
            if self.is_model(option):
                suffix = "Object" if len(objects) == 1 else f"Variant{position + 1}"
                converted.append(self.convert(option, hint + suffix, f"one form of {where or f'`{hint}`'}"))
            else:
                converted.append(self.convert(option, hint, where))
        if not converted:
            return NULL
        merged: TypeRef = converted[0] if len(converted) == 1 else UnionOf(tuple(converted))
        return Nullable(merged) if nullable else merged

    def convert(self, schema: Any, hint: str, where: str = "") -> TypeRef:
        if schema is True or schema == {}:
            return ANY
        if not isinstance(schema, dict):
            raise SpecError(f"The schema for {hint} is not an object")
        if "$ref" in schema:
            return Ref(self.ref_name(schema["$ref"]))
        for union_keyword in UNION_KEYWORDS:
            if union_keyword in schema:
                return self.union(schema[union_keyword], hint, where)
        if "allOf" in schema:
            raise SpecError(f"The schema for {hint} uses allOf, which this generator does not read")
        if "const" in schema:
            return Lit((schema["const"],))
        if "enum" in schema:
            return Lit(tuple(schema["enum"]))
        kind = schema.get("type")
        if kind == "string":
            return STRING
        if kind in ("number", "integer"):
            return NUMBER
        if kind == "boolean":
            return BOOLEAN
        if kind == "null":
            return NULL
        if kind == "array":
            item = self.convert(schema.get("items", True), hint + "Item", f"one item of {where or f'`{hint}`'}")
            size = schema.get("minItems")
            if isinstance(size, int) and size == schema.get("maxItems") and size > 0:
                return TupleOf(item, size)
            return ListOf(item)
        if kind == "object" or "properties" in schema or "additionalProperties" in schema:
            if self.is_model(schema):
                return self.model(hint, schema, where)
            extra = schema.get("additionalProperties")
            if isinstance(extra, dict) and extra:
                return MapOf(self.convert(extra, hint + "Value", f"each value of {where or f'`{hint}`'}"))
            return OPEN_OBJECT
        if kind is None:
            return ANY
        raise SpecError(f"The schema for {hint} has type {kind!r}, which this generator does not read")

    def content(self, content: dict[str, Any], hint: str) -> tuple[str, str, TypeRef | None]:
        if len(content) != 1:
            raise SpecError(f"{hint} offers {len(content)} content types, and the generator reads exactly one")
        content_type, media = next(iter(content.items()))
        schema = media.get("schema", {})
        if schema.get("format") == BINARY_FORMAT:
            return "binary", content_type, None
        if content_type.split(";")[0].strip() == JSON_CONTENT:
            return "json", content_type, self.convert(schema, hint)
        if schema.get("type") == "string":
            return "text", content_type, None
        raise SpecError(f"{hint} sends {content_type}, which the generator cannot map to a type")

    def answers(self, operation_id: str, responses: dict[str, Any]) -> tuple[Answer, ...]:
        found: list[Answer] = []
        for status, response in responses.items():
            if status == "default":
                continue
            if "$ref" in response:
                response = self.responses[response["$ref"].rsplit("/", 1)[-1]]
            hint = pascal(operation_id) + "Response" + status
            content = response.get("content")
            description = _description(response)
            if not content:
                found.append(Answer(int(status), "empty", "", None, description))
                continue
            kind, content_type, typed = self.content(content, hint)
            found.append(Answer(int(status), kind, content_type, typed, description))
        if not any(200 <= answer.status < 300 for answer in found):
            raise SpecError(f"Operation {operation_id} documents no successful response")
        return tuple(found)

    def operation(self, path: str, method: str, raw: dict[str, Any], shared: list[Any]) -> Operation:
        operation_id = raw.get("operationId")
        if not isinstance(operation_id, str) or not operation_id:
            raise SpecError(f"{method.upper()} {path} has no operationId, so it would have no method")
        params = tuple(
            Param(
                json_name=param["name"],
                location=param["in"],
                required=bool(param.get("required", False)),
                type=self.convert(param.get("schema", {}), pascal(operation_id) + pascal(param["name"])),
                description=_description(param),
                comma_joined=param.get("explode") is False,
            )
            for param in [*shared, *raw.get("parameters", [])]
        )
        for param in params:
            if param.location not in ("path", "query"):
                raise SpecError(f"Operation {operation_id} takes a {param.location} parameter, which is not read")
        body = None
        if "requestBody" in raw:
            request = raw["requestBody"]
            kind, content_type, typed = self.content(request["content"], pascal(operation_id) + "Body")
            body = Body(kind, content_type, typed, bool(request.get("required", False)), _description(request))
        tags = raw.get("tags") or ["Default"]
        return Operation(
            operation_id=operation_id,
            method=method.upper(),
            path=path,
            tag=tags[0],
            summary=" ".join(str(raw.get("summary", "")).split()),
            params=params,
            body=body,
            answers=self.answers(operation_id, raw.get("responses", {})),
            repeatable=bool(raw.get(REPEATABLE_EXTENSION, False)),
        )


def build_api(document: dict[str, Any]) -> Api:
    builder = _Builder(document)
    for name, schema in builder.schemas.items():
        builder.top_level(name, schema)
    seen: set[str] = set()
    for path, item in document.get("paths", {}).items():
        shared = item.get("parameters", [])
        for method in HTTP_METHODS:
            if method not in item:
                continue
            operation = builder.operation(path, method, item[method], shared)
            if operation.operation_id in seen:
                raise SpecError(f"Two operations share the operationId {operation.operation_id}")
            seen.add(operation.operation_id)
            builder.api.operations.append(operation)
    return builder.api
