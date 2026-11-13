import json
import hashlib
import math
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path

MANIFEST_FILE = "manifest.json"
KEYWORD_DOCUMENTS_FILE = "keyword-documents.jsonl"
KEYWORD_QUERIES_FILE = "keyword-queries.jsonl"
VECTOR_DOCUMENTS_FILE = "vector-documents.jsonl"
VECTOR_DOCUMENT_VECTORS_FILE = "vector-documents.f32"
VECTOR_QUERIES_FILE = "vector-queries.jsonl"
VECTOR_QUERY_VECTORS_FILE = "vector-queries.f32"
WORKLOAD_FORMAT = 1
MAX_JSON_BYTES = 268_435_456
TEXT_FIELDS = ("title", "body")


class UnusableInput(Exception):
    pass


def refuse_constant(name: str) -> float:
    raise UnusableInput(f"JSON holds {name}, which no finite number spells")


def read_json(path: Path) -> object:
    if path.stat().st_size > MAX_JSON_BYTES:
        raise UnusableInput(f"{path} is larger than {MAX_JSON_BYTES} bytes")
    try:
        return json.loads(path.read_text("utf-8"), parse_constant=refuse_constant)
    except json.JSONDecodeError as error:
        raise UnusableInput(f"{path} is not valid JSON: {error}") from error


def read_json_lines(path: Path) -> list[dict]:
    if path.stat().st_size > MAX_JSON_BYTES:
        raise UnusableInput(f"{path} is larger than {MAX_JSON_BYTES} bytes")
    rows = []
    for number, line in enumerate(path.read_text("utf-8").split("\n"), start=1):
        if not line:
            continue
        try:
            row = json.loads(line, parse_constant=refuse_constant)
        except json.JSONDecodeError as error:
            raise UnusableInput(f"line {number} of {path} is not valid JSON: {error}") from error
        if not isinstance(row, dict) or not all(isinstance(value, str) for value in row.values()):
            raise UnusableInput(f"line {number} of {path} is not an object of strings")
        rows.append(row)
    return rows


def read_vectors(path: Path, rows: int, dimension: int) -> list[array]:
    flat = array("f")
    with path.open("rb") as stream:
        try:
            flat.fromfile(stream, rows * dimension)
        except EOFError as error:
            raise UnusableInput(f"{path} holds fewer than {rows} vectors of {dimension} components") from error
        if stream.read(1):
            raise UnusableInput(f"{path} holds more than {rows} vectors of {dimension} components")
    if sys.byteorder != "little":
        flat.byteswap()
    vectors = [flat[row * dimension : (row + 1) * dimension] for row in range(rows)]
    for vector in vectors:
        if not all(math.isfinite(value) for value in vector):
            raise UnusableInput(f"{path} holds a component that is not finite")
    return vectors


@dataclass(frozen=True)
class Workload:
    directory: Path
    manifest: dict
    keyword_documents: list[dict]
    keyword_queries: list[str]
    vector_documents: list[dict]
    vector_document_vectors: list[array]
    vector_queries: list[dict]
    vector_query_vectors: list[array]

    @property
    def settings(self) -> dict:
        return self.manifest["settings"]


def positive_count(node: dict, key: str) -> int:
    value = node.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise UnusableInput(f"the workload manifest needs a positive whole {key}")
    return value


def load_workload(directory: Path) -> Workload:
    manifest = read_json(directory / MANIFEST_FILE)
    if not isinstance(manifest, dict) or manifest.get("format") != WORKLOAD_FORMAT:
        raise UnusableInput(f"the workload manifest must declare format {WORKLOAD_FORMAT}")
    keyword = manifest.get("keyword")
    vector = manifest.get("vector")
    if not isinstance(keyword, dict) or not isinstance(vector, dict) or not isinstance(manifest.get("settings"), dict):
        raise UnusableInput("the workload manifest needs keyword, vector, and settings objects")
    for name in (KEYWORD_DOCUMENTS_FILE, KEYWORD_QUERIES_FILE, VECTOR_DOCUMENTS_FILE, VECTOR_DOCUMENT_VECTORS_FILE, VECTOR_QUERIES_FILE, VECTOR_QUERY_VECTORS_FILE):
        with (directory / name).open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != manifest.get('sha256', {}).get(name):
            raise UnusableInput(f"workload file {name} has a different sha256 from its manifest")
    settings = manifest['settings']
    for key, required in {'language': 'english', 'metric': 'cosine', 'quantization': 'none', 'limit': 10, 'recallDepth': 100, 'hybridLegDepth': 11}.items():
        if settings.get(key) != required:
            raise UnusableInput(f"the benchmark requires {key} {required}")
    dimension = positive_count(vector, "dimension")
    keyword_documents = read_json_lines(directory / KEYWORD_DOCUMENTS_FILE)
    keyword_queries = [row["text"] for row in read_json_lines(directory / KEYWORD_QUERIES_FILE)]
    vector_documents = read_json_lines(directory / VECTOR_DOCUMENTS_FILE)
    vector_queries = read_json_lines(directory / VECTOR_QUERIES_FILE)
    for documents in (keyword_documents, vector_documents):
        identifiers = [document['id'] for document in documents]
        if any(not identifier for identifier in identifiers) or len(set(identifiers)) != len(identifiers):
            raise UnusableInput('the corpus needs distinct non-empty document IDs')
        if any(not all(field in document for field in TEXT_FIELDS) for document in documents):
            raise UnusableInput('every document needs title and body strings')
    if len(keyword_documents) != positive_count(keyword, "documents"):
        raise UnusableInput("the keyword corpus holds another number of documents than the manifest records")
    if len(keyword_queries) != positive_count(keyword, "queries"):
        raise UnusableInput("the keyword queries number differently from the manifest")
    if len(vector_documents) != positive_count(vector, "documents"):
        raise UnusableInput("the vector corpus holds another number of documents than the manifest records")
    if len(vector_queries) != positive_count(vector, "queries"):
        raise UnusableInput("the vector queries number differently from the manifest")
    return Workload(
        directory=directory,
        manifest=manifest,
        keyword_documents=keyword_documents,
        keyword_queries=keyword_queries,
        vector_documents=vector_documents,
        vector_document_vectors=read_vectors(
            directory / VECTOR_DOCUMENT_VECTORS_FILE, len(vector_documents), dimension
        ),
        vector_queries=vector_queries,
        vector_query_vectors=read_vectors(directory / VECTOR_QUERY_VECTORS_FILE, len(vector_queries), dimension),
    )
