#include "PagedVectorInput.hpp"

#include <cmath>
#include <cstdint>

namespace margelo::nitro::narsil {

namespace {
jsi::Object objectOf(jsi::Runtime& runtime, const jsi::Value& value) {
  if (!value.isObject()) throwInvalid("The paged metadata must be an object");
  return value.getObject(runtime);
}
jsi::Array arrayOf(jsi::Runtime& runtime, const jsi::Value& value) {
  auto object = objectOf(runtime, value);
  if (!object.isArray(runtime)) throwInvalid("The paged files and graph parts must be arrays");
  auto array = object.getArray(runtime);
  if (array.size(runtime) > UINT32_MAX) throwInvalid("The paged field has too many parts");
  return array;
}
}

void PagedVectorInput::prepare(jsi::Runtime& runtime, const jsi::Value& value) {
  auto object = objectOf(runtime, value);
  _field.dimension = pagedWhole(object.getProperty(runtime, "dimension"));
  _field.metric = pagedWhole(object.getProperty(runtime, "metric"));
  _field.total = pagedWhole(object.getProperty(runtime, "total"));
  _field.max_layer = pagedWhole(object.getProperty(runtime, "maxLayer"));
  auto entry = object.getProperty(runtime, "entryPoint");
  _field.has_entry_point = !entry.isNull();
  if (_field.has_entry_point) _field.entry_point = pagedWhole(entry);
  auto codes = object.getProperty(runtime, "codes");
  if (!codes.isNull()) {
    auto code = objectOf(runtime, codes);
    _field.bits = pagedWhole(code.getProperty(runtime, "bits"));
    if (_field.bits == 0) throwInvalid("The quantised field needs a code width");
    _centroid.prepare(runtime, 0, code.getProperty(runtime, "centroid"));
  }
  auto files = arrayOf(runtime, object.getProperty(runtime, "files"));
  auto parts = arrayOf(runtime, object.getProperty(runtime, "graphParts"));
  _files.reserve(files.size(runtime));
  _parts.reserve(parts.size(runtime));
  for (size_t at = 0; at < files.size(runtime); at++) {
    auto source = objectOf(runtime, files.getValueAtIndex(runtime, at));
    auto file = std::make_unique<File>();
    file->value.first = pagedWhole(source.getProperty(runtime, "first"));
    file->value.count = pagedWhole(source.getProperty(runtime, "count"));
    auto dead = source.getProperty(runtime, "dead");
    auto records = source.getProperty(runtime, "records");
    file->hasDead = !dead.isNull();
    file->hasRecords = !records.isNull();
    if (file->hasDead) file->dead.prepare(runtime, 0, dead);
    file->vectors.prepare(runtime, source.getProperty(runtime, "vectors"));
    if (file->hasRecords) file->records.prepare(runtime, records);
    _files.push_back(std::move(file));
  }
  for (size_t at = 0; at < parts.size(runtime); at++) {
    auto source = objectOf(runtime, parts.getValueAtIndex(runtime, at));
    auto part = std::make_unique<Part>();
    part->value.first = pagedWhole(source.getProperty(runtime, "first"));
    part->value.count = pagedWhole(source.getProperty(runtime, "count"));
    part->regions.prepare(runtime, 0, source.getProperty(runtime, "levels"));
    part->regions.prepare(runtime, 1, source.getProperty(runtime, "nodeOffsets"));
    part->neighbours.prepare(runtime, source.getProperty(runtime, "neighbours"));
    _parts.push_back(std::move(part));
  }
}

narsil_paged_vector_field PagedVectorInput::read(jsi::Runtime& runtime) {
  _fileValues.resize(_files.size());
  _partValues.resize(_parts.size());
  for (size_t at = 0; at < _files.size(); at++) {
    auto& file = *_files[at];
    if (file.hasDead) {
      auto dead = file.dead.read<const uint8_t>(runtime, 0, "The vector deletion bits");
      if (dead.length == 0) throwInvalid("The vector deletion bits are empty");
      file.value.dead = dead.data;
      file.value.dead_bytes = dead.length;
    }
    file.value.vectors = file.vectors.read(runtime);
    if (file.hasRecords) {
      file.record = file.records.read(runtime);
      file.value.records = &file.record;
    }
    _fileValues[at] = file.value;
  }
  for (size_t at = 0; at < _parts.size(); at++) {
    auto& part = *_parts[at];
    auto levels = part.regions.read<const uint8_t>(runtime, 0, "The graph levels");
    auto offsets = part.regions.read<const uint32_t>(runtime, 1, "The graph node offsets");
    part.value.levels = levels.data;
    part.value.level_count = levels.length;
    part.value.node_offsets = offsets.data;
    part.value.offset_count = offsets.length;
    part.value.neighbours = part.neighbours.read(runtime);
    _partValues[at] = part.value;
  }
  if (_field.bits != 0) {
    auto centroid = _centroid.read<const float>(runtime, 0, "The quantisation centroid");
    _field.centroid = centroid.data;
    _field.centroid_count = centroid.length;
  }
  _field.files = _fileValues.data();
  _field.file_count = _fileValues.size();
  _field.parts = _partValues.data();
  _field.part_count = _partValues.size();
  return _field;
}

std::vector<PagedFile> PagedVectorInput::filesHeld() const {
  std::vector<PagedFile> files;
  for (const auto& file : _files) {
    files.push_back(file->vectors.file);
    if (file->hasRecords) files.push_back(file->records.file);
  }
  for (const auto& part : _parts) files.push_back(part->neighbours.file);
  return files;
}

void PagedQueryInput::prepare(jsi::Runtime& runtime, const jsi::Value& value) {
  auto object = objectOf(runtime, value);
  _request.k = pagedWhole(object.getProperty(runtime, "k"));
  _request.ef = pagedWhole(object.getProperty(runtime, "ef"));
  _request.rescore_depth = pagedWhole(object.getProperty(runtime, "rescoreDepth"));
  auto explicitWindow = object.getProperty(runtime, "explicitRescoreWindow");
  auto floor = object.getProperty(runtime, "minSimilarity");
  if (!explicitWindow.isBool() || !floor.isNumber()) throwInvalid("The paged search settings have invalid types");
  _request.explicit_rescore_window = explicitWindow.getBool();
  _request.min_similarity = floor.getNumber();
  _regions.prepare(runtime, 0, object.getProperty(runtime, "query"));
  auto accepted = object.getProperty(runtime, "accepted");
  auto excluded = object.getProperty(runtime, "excluded");
  _accepted = !accepted.isNull();
  _excluded = !excluded.isNull();
  if (_accepted) _regions.prepare(runtime, 1, accepted);
  if (_excluded) _regions.prepare(runtime, 2, excluded);
}

narsil_paged_vector_request PagedQueryInput::read(jsi::Runtime& runtime) {
  auto query = _regions.read<const float>(runtime, 0, "The query vector");
  _request.query = query.data;
  _request.query_count = query.length;
  if (_accepted) {
    auto bits = _regions.read<const uint32_t>(runtime, 1, "The accepted vector bits");
    if (bits.length == 0) throwInvalid("The accepted vector bits are empty");
    _request.accepted = bits.data;
    _request.accepted_words = bits.length;
  }
  if (_excluded) {
    auto bits = _regions.read<const uint32_t>(runtime, 2, "The excluded vector bits");
    if (bits.length == 0) throwInvalid("The excluded vector bits are empty");
    _request.excluded = bits.data;
    _request.excluded_words = bits.length;
  }
  return _request;
}

}
