#pragma once

#include "FrozenSegmentRegions.hpp"
#include "narsil_segment_merge.h"

#include <optional>
#include <vector>

namespace margelo::nitro::narsil {

class KeywordMergeInput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The merge input must be an object");
    auto object = value.getObject(runtime);
    _documents = segmentUnsigned(object.getProperty(runtime, "documentCount"));
    auto growing = object.getProperty(runtime, "growing");
    _hasGrowing = !growing.isNull() && !growing.isUndefined();
    if (_hasGrowing) _growing.prepare(runtime, growing);
    else _terms.prepare(runtime, object.getProperty(runtime, "terms"));
    auto surfaces = object.getProperty(runtime, "surfaces");
    _hasSurfaces = !surfaces.isNull();
    if (_hasSurfaces) _surfaces.prepare(runtime, surfaces);
    auto spellings = object.getProperty(runtime, "spellings");
    _hasSpellings = !spellings.isNull();
    if (_hasSpellings) _spellings.prepare(runtime, spellings);
    _postings.prepare(runtime, value, {"payloadSlots", "postingOffsets", "postingDocuments", "postingFrequencies",
                                       "postingFields", "mapping", "fieldMapping"});
    auto offsets = object.getProperty(runtime, "positionOffsets");
    auto positions = object.getProperty(runtime, "positionValues");
    if (offsets.isNull() != positions.isNull()) throwInvalid("The merge positions must both be present or null");
    _hasPositions = !offsets.isNull();
    if (_hasPositions) {
      _positions.views.prepare(runtime, 0, offsets);
      _positions.views.prepare(runtime, 1, positions);
    }
    auto lengths = object.getProperty(runtime, "fieldLengths");
    if (!lengths.isObject() || !lengths.getObject(runtime).isArray(runtime)) throwInvalid("The field lengths must be an array");
    auto columns = lengths.getObject(runtime).getArray(runtime);
    size_t fields = columns.size(runtime);
    if (fields > static_cast<size_t>(UINT16_MAX) + 1) throwInvalid("The merge has too many fields");
    _lengths.emplace(fields);
    _present.resize(fields);
    _pointers.resize(fields);
    for (size_t at = 0; at < fields; at++) {
      auto column = columns.getValueAtIndex(runtime, at);
      _present[at] = !column.isNull();
      if (_present[at]) _lengths->prepare(runtime, at, column);
    }
  }

  narsil_keyword_merge_input read(jsi::Runtime& runtime) {
    narsil_keyword_merge_input input{};
    if (_hasGrowing) {
      _growingSegment = _growing.read(runtime);
      input.growing = &_growingSegment;
    } else input.terms = _terms.read(runtime, 1);
    if (input.terms.count == SIZE_MAX) throwInvalid("The merge has too many terms");
    if (_hasGrowing) {
      input.payload_slots = _postings.read<const uint32_t>(runtime, 0).data;
      input.posting_offsets = _postings.read<const uint32_t>(runtime, 1).data;
    } else {
      input.payload_slots = _postings.read<const uint32_t>(runtime, 0, input.terms.count).data;
      input.posting_offsets = _postings.read<const uint32_t>(runtime, 1, input.terms.count + 1).data;
    }
    auto documents = _postings.read<const uint32_t>(runtime, 2);
    input.posting_documents = documents.data;
    input.posting_count = documents.length;
    input.posting_frequencies = _postings.read<const uint16_t>(runtime, 3, documents.length).data;
    input.posting_fields = _postings.read<const uint16_t>(runtime, 4, documents.length).data;
    input.mapping = _postings.read<const uint32_t>(runtime, 5, _documents).data;
    input.field_mapping = _postings.read<const uint16_t>(runtime, 6, _pointers.size()).data;
    input.document_count = _documents;
    input.field_count = static_cast<uint32_t>(_pointers.size());
    for (size_t at = 0; at < _pointers.size(); at++) {
      if (!_present[at]) continue;
      auto lengths = _lengths->read<const uint32_t>(runtime, at, "The field lengths");
      if (lengths.length != _documents) throwInvalid("The field lengths have the wrong capacity");
      _pointers[at] = lengths.data;
    }
    input.field_lengths = _pointers.data();
    if (_hasPositions) {
      size_t count = static_cast<size_t>(documents.length) + 1;
      if (count == 0) throwInvalid("The merge has too many postings");
      input.position_offsets = _positions.read<const uint32_t>(runtime, 0, count).data;
      auto values = _positions.read<const uint32_t>(runtime, 1);
      input.position_values = values.data;
      input.position_count = values.length;
    }
    if (_hasSurfaces) {
      _surfaceTable = _surfaces.read(runtime, 2);
      input.surfaces = &_surfaceTable;
    }
    if (_hasSpellings) {
      _spellingTable = _spellings.read(runtime, 2);
      input.spellings = &_spellingTable;
    }
    return input;
  }

private:
  FrozenStringRegions _terms;
  SegmentRegions _growing;
  narsil_growing_segment _growingSegment{};
  FrozenStringRegions _surfaces;
  FrozenStringRegions _spellings;
  SegmentViews<7> _postings;
  SegmentViews<2> _positions;
  std::optional<TypedElements> _lengths;
  std::vector<bool> _present;
  std::vector<const uint32_t*> _pointers;
  narsil_frozen_strings _surfaceTable{};
  narsil_frozen_strings _spellingTable{};
  uint32_t _documents = 0;
  bool _hasPositions = false;
  bool _hasGrowing = false;
  bool _hasSurfaces = false;
  bool _hasSpellings = false;
};

}
