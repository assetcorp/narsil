from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel

from generator.identifiers import python_identifier
from generator.ir import AliasDef, Api, Definition, FieldDef, ModelDef
from generator.python_types import Rendered, is_recursive, render_type, strongly_connected
from generator.text import GENERATED_MODULE_DOCSTRING, docstring

MODEL_PACKAGE = "narsil_client.models"
MODEL_FILE_LINE_BUDGET = 300
RESERVED_FIELD_NAMES = frozenset(name for name in dir(BaseModel) if not name.startswith("_"))
TYPING_ORDER = ("Annotated", "Any", "Literal", "TypeAlias")


@dataclass
class Block:
    exported: list[str]
    lines: list[str]
    rendered: Rendered


@dataclass
class ModelFile:
    module: str
    blocks: list[Block] = field(default_factory=list)

    @property
    def exported(self) -> list[str]:
        return [name for block in self.blocks for name in block.exported]

    @property
    def line_count(self) -> int:
        return sum(len(block.lines) + 2 for block in self.blocks)


def field_lines(model_field: FieldDef, out: Rendered) -> list[str]:
    attribute = python_identifier(model_field.json_name, RESERVED_FIELD_NAMES)
    annotation = render_type(model_field.type, out)
    aliased = attribute != model_field.json_name
    if model_field.required:
        default = f' = Field(alias="{model_field.json_name}")' if aliased else ""
    else:
        if not annotation.endswith("| None") and annotation not in ("Any", "None"):
            annotation += " | None"
        default = f' = Field(default=None, alias="{model_field.json_name}")' if aliased else " = None"
    if aliased:
        out.typing_names.add("Field")
    return [f"    {attribute}: {annotation}{default}", *docstring([model_field.description], "    ")]


def model_lines(model: ModelDef, out: Rendered) -> list[str]:
    lines = [f"class {model.name}(ApiModel):"]
    lines.extend(docstring([model.description], "    "))
    if model.fields:
        if len(lines) > 1:
            lines.append("")
        for model_field in model.fields:
            lines.extend(field_lines(model_field, out))
    elif len(lines) == 1:
        lines.append("    pass")
    return lines


def alias_lines(alias: AliasDef, out: Rendered, recursive_group: frozenset[str]) -> list[str]:
    if recursive_group:
        value = render_type(alias.type, out)
        out.typing_names.add("TypeAliasType")
        quote = "'" if '"' in value else '"'
        lines = [f'{alias.name} = TypeAliasType("{alias.name}", {quote}{value}{quote})']
    else:
        value = render_type(alias.type, out)
        out.typing_names.add("TypeAlias")
        lines = [f"{alias.name}: TypeAlias = {value}"]
    return lines + docstring([alias.description], "")


def build_blocks(api: Api) -> list[Block]:
    definitions = api.definitions
    blocks: list[Block] = []
    for group in strongly_connected(definitions):
        recursive = frozenset(group) if is_recursive(group, definitions) else frozenset()
        out = Rendered("")
        lines: list[str] = []
        ordered = sorted(group, key=lambda name: isinstance(definitions[name], AliasDef))
        for name in ordered:
            definition: Definition = definitions[name]
            if lines:
                lines.extend(["", ""])
            if isinstance(definition, ModelDef):
                lines.extend(model_lines(definition, out))
            else:
                lines.extend(alias_lines(definition, out, recursive))
        blocks.append(Block(ordered, lines, out))
    return blocks


def pack(blocks: list[Block]) -> list[ModelFile]:
    files: list[ModelFile] = []
    current = ModelFile(module="_part_01")
    for block in blocks:
        if current.blocks and current.line_count + len(block.lines) > MODEL_FILE_LINE_BUDGET:
            files.append(current)
            current = ModelFile(module=f"_part_{len(files) + 1:02d}")
        current.blocks.append(block)
    if current.blocks:
        files.append(current)
    return files


def render_file(model_file: ModelFile, home: dict[str, str]) -> str:
    typing_names: set[str] = set()
    used: set[str] = set()
    open_enum = False
    for block in model_file.blocks:
        typing_names |= block.rendered.typing_names
        used |= block.rendered.model_names
        open_enum = open_enum or block.rendered.uses_open_enum
    local = set(model_file.exported)
    header = [GENERATED_MODULE_DOCSTRING, "", "from __future__ import annotations", ""]
    standard = sorted(name for name in typing_names if name in TYPING_ORDER)
    if standard:
        header.append(f"from typing import {', '.join(standard)}")
        header.append("")
    if "Field" in typing_names:
        header.append("from pydantic import Field")
    if "TypeAliasType" in typing_names:
        header.append("from typing_extensions import TypeAliasType")
    header.append("")
    model_imports = ["ApiModel"] + (["OPEN_ENUM"] if open_enum else [])
    header.append(f"from narsil_client._model import {', '.join(sorted(model_imports, key=str.lower))}")
    by_module: dict[str, list[str]] = {}
    for name in sorted(used - local):
        by_module.setdefault(home[name], []).append(name)
    header.extend(
        f"from {MODEL_PACKAGE}.{module} import {', '.join(by_module[module])}" for module in sorted(by_module)
    )
    body: list[str] = []
    for block in model_file.blocks:
        body.extend(["", "", *block.lines])
    return "\n".join([*header, *body]) + "\n"


def render_index(files: list[ModelFile]) -> str:
    lines: list[str] = [GENERATED_MODULE_DOCSTRING, ""]
    every: list[str] = []
    for model_file in files:
        exported = sorted(model_file.exported)
        every.extend(exported)
        lines.append(f"from {MODEL_PACKAGE}.{model_file.module} import {', '.join(exported)}")
    lines.append("")
    lines.append("__all__ = [" + ", ".join(f'"{name}"' for name in sorted(every)) + "]")
    return "\n".join(lines) + "\n"


def render_models(api: Api) -> dict[str, str]:
    files = pack(build_blocks(api))
    home = {name: model_file.module for model_file in files for name in model_file.exported}
    output = {f"{model_file.module}.py": render_file(model_file, home) for model_file in files}
    output["__init__.py"] = render_index(files)
    return output
