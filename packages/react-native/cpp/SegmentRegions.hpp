#pragma once

#include "SegmentTables.hpp"
#include "narsil_segments.h"

#include <cmath>
#include <cstdint>

namespace margelo::nitro::narsil {

inline uint32_t segmentUnsigned(const jsi::Value& value) {
  if (!value.isNumber()) throwInvalid("A segment ordinal must be a number");
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) {
    throwInvalid("A segment ordinal must be a uint32 integer");
  }
  return static_cast<uint32_t>(number);
}

class SegmentRegions {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The segment must be an object");
    auto object = value.getObject(runtime);
    _capacity = segmentUnsigned(object.getProperty(runtime, "ordinalCapacity"));
    _terms.prepare(runtime, object.getProperty(runtime, "terms"));
    _columns.prepare(runtime, object.getProperty(runtime, "columns"),
                     {"sliceStart", "sliceClass", "lengths", "docFrequency", "deadDocuments", "totalTermFrequency",
                      "surfaceOccurrences", "revision", "flags"});
    preparePostings(runtime, object.getProperty(runtime, "postings"));
    _values.prepare(runtime, value, {"retired", "fieldLengths", "totalDocuments", "totalFieldLengths", "partialFields"});
    auto positions = object.getProperty(runtime, "positions");
    _hasPositions = !positions.isNull();
    if (_hasPositions) _positionValues.prepare(runtime, positions, {"values", "allocation"});
    auto surfaces = object.getProperty(runtime, "surfaces");
    _hasSurfaces = !surfaces.isNull();
    if (_hasSurfaces) _surfaces.prepare(runtime, surfaces);
    auto spellings = object.getProperty(runtime, "spellings");
    _hasSpellings = !spellings.isNull();
    if (_hasSpellings) {
      if (!spellings.isObject()) throwInvalid("The spelling table must be an object");
      _spellings.prepare(runtime, spellings);
      auto table = spellings.getObject(runtime);
      _spellingPoints.views.prepare(runtime, 0, table.getProperty(runtime, "codePoints"));
      _runs.prepare(runtime, table.getProperty(runtime, "runs"));
    }
  }

  narsil_growing_segment read(jsi::Runtime& runtime) {
    narsil_growing_segment segment{};
    segment.terms = _terms.read(runtime);
    segment.columns = readColumns(runtime, segment.terms.offset_count);
    segment.postings = readPostings(runtime);
    auto partial = _values.read<uint8_t>(runtime, 4);
    if (partial.length > static_cast<size_t>(UINT16_MAX) + 1 ||
        (partial.length > 0 && _capacity > SIZE_MAX / partial.length)) throwInvalid("The segment has too many fields");
    size_t words = _capacity == 0 ? 1 : ((static_cast<size_t>(_capacity) - 1) / 32) + 1;
    segment.retired = _values.read<uint32_t>(runtime, 0, words).data;
    segment.field_lengths = _values.read<uint32_t>(runtime, 1, static_cast<size_t>(_capacity) * partial.length).data;
    segment.total_documents = _values.read<uint32_t>(runtime, 2, 1).data;
    segment.total_field_lengths = _values.read<double>(runtime, 3, partial.length).data;
    segment.partial_fields = partial.data;
    segment.field_count = partial.length;
    segment.ordinal_capacity = _capacity;
    if (_hasPositions) {
      auto values = _positionValues.read<uint32_t>(runtime, 0);
      _positionPool = {values.data, values.length, _positionValues.read<uint32_t>(runtime, 1, 2).data};
      segment.positions = &_positionPool;
    }
    if (_hasSurfaces) {
      _surfaceTable = _surfaces.read(runtime);
      segment.surfaces = &_surfaceTable;
    }
    if (_hasSpellings) {
      _spellingTable.entries = _spellings.read(runtime);
      _spellingTable.code_points = _spellingPoints.read<uint32_t>(runtime, 0, _spellingTable.entries.capacity).data;
      _spellingTable.runs = _runs.read(runtime);
      segment.spellings = &_spellingTable;
    }
    return segment;
  }

private:
  void preparePostings(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The posting pool must be an object");
    auto object = value.getObject(runtime);
    constexpr std::array<const char*, 7> properties{
        "docIds", "frequencies", "fieldIndices", "positionStarts", "allocation", "freeHeads", "sliceCapacities"};
    for (size_t index = 0; index < properties.size(); index++) {
      auto property = object.getProperty(runtime, properties[index]);
      if (index == 3) {
        _hasPositionStarts = !property.isNull();
        if (!_hasPositionStarts) continue;
      }
      _postings.views.prepare(runtime, index, property);
    }
  }

  narsil_term_columns readColumns(jsi::Runtime& runtime, size_t capacity) {
    return {_columns.read<uint32_t>(runtime, 0, capacity).data, _columns.read<uint8_t>(runtime, 1, capacity).data,
            _columns.read<uint32_t>(runtime, 2, capacity).data, _columns.read<uint32_t>(runtime, 3, capacity).data,
            _columns.read<uint32_t>(runtime, 4, capacity).data, _columns.read<double>(runtime, 5, capacity).data,
            _columns.read<double>(runtime, 6, capacity).data, _columns.read<uint32_t>(runtime, 7, capacity).data,
            _columns.read<uint8_t>(runtime, 8, capacity).data, capacity};
  }

  narsil_posting_pool readPostings(jsi::Runtime& runtime) {
    auto docs = _postings.read<uint32_t>(runtime, 0);
    auto sizes = _postings.read<uint32_t>(runtime, 6);
    uint32_t* positions = _hasPositionStarts ? _postings.read<uint32_t>(runtime, 3, docs.length).data : nullptr;
    return {docs.data, _postings.read<uint16_t>(runtime, 1, docs.length).data,
            _postings.read<uint16_t>(runtime, 2, docs.length).data, positions, docs.length,
            {_postings.read<uint32_t>(runtime, 4, 2).data, _postings.read<uint32_t>(runtime, 5, sizes.length).data,
             sizes.data, sizes.length}};
  }

  SegmentStringRegions _terms;
  SegmentViews<9> _columns;
  SegmentViews<7> _postings;
  SegmentViews<5> _values;
  SegmentViews<2> _positionValues;
  SegmentSurfaceRegions _surfaces;
  SegmentSurfaceRegions _spellings;
  SegmentViews<1> _spellingPoints;
  SegmentRunRegions _runs;
  narsil_position_pool _positionPool{};
  narsil_surface_table _surfaceTable{};
  narsil_spelling_table _spellingTable{};
  uint32_t _capacity = 0;
  bool _hasPositions = false;
  bool _hasPositionStarts = false;
  bool _hasSurfaces = false;
  bool _hasSpellings = false;
};

}
