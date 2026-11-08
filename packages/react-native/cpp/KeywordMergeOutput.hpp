#pragma once

#include "SegmentRegions.hpp"
#include "narsil_segment_merge.h"

namespace margelo::nitro::narsil {

class KeywordMergeOutput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The merge output must be an object");
    auto object = value.getObject(runtime);
    _terms.prepare(runtime, object.getProperty(runtime, "terms"), {"text", "offsets", "counts"});
    _surfaces.prepare(runtime, object.getProperty(runtime, "surfaces"), {"text", "offsets", "counts"});
    _spellings.prepare(runtime, object.getProperty(runtime, "spellings"), {"text", "offsets", "counts"});
    _arrays.prepare(runtime, value, {"postingOffsets", "postingDocuments", "postingFrequencies", "postingFields",
                                     "fieldLengths", "totalFieldLengths"});
    auto offsets = object.getProperty(runtime, "positionOffsets");
    auto positions = object.getProperty(runtime, "positionValues");
    if (offsets.isNull() != positions.isNull()) throwInvalid("The merge positions must both be present or null");
    _hasPositions = !offsets.isNull();
    if (_hasPositions) {
      _positions.views.prepare(runtime, 0, offsets);
      _positions.views.prepare(runtime, 1, positions);
    }
  }

  narsil_keyword_merge_output read(jsi::Runtime& runtime) {
    narsil_keyword_merge_output output{};
    output.terms = strings(runtime, _terms);
    output.surfaces = strings(runtime, _surfaces);
    output.spellings = strings(runtime, _spellings);
    auto offsets = _arrays.read<uint32_t>(runtime, 0);
    output.posting_offsets = offsets.data;
    output.posting_offset_capacity = offsets.length;
    auto documents = _arrays.read<uint32_t>(runtime, 1);
    output.posting_documents = documents.data;
    output.posting_capacity = documents.length;
    output.posting_frequencies = _arrays.read<uint16_t>(runtime, 2, documents.length).data;
    output.posting_fields = _arrays.read<uint16_t>(runtime, 3, documents.length).data;
    auto lengths = _arrays.read<uint32_t>(runtime, 4);
    output.field_lengths = lengths.data;
    output.field_length_capacity = lengths.length;
    auto totals = _arrays.read<double>(runtime, 5);
    output.total_field_lengths = totals.data;
    output.field_count = totals.length;
    if (_hasPositions) {
      auto starts = _positions.read<uint32_t>(runtime, 0);
      auto values = _positions.read<uint32_t>(runtime, 1);
      output.position_offsets = starts.data;
      output.position_offset_capacity = starts.length;
      output.position_values = values.data;
      output.position_capacity = values.length;
    }
    return output;
  }

private:
  static narsil_merged_strings strings(jsi::Runtime& runtime, SegmentViews<3>& views) {
    auto text = views.read<uint8_t>(runtime, 0);
    auto offsets = views.read<uint32_t>(runtime, 1);
    auto counts = views.read<uint32_t>(runtime, 2);
    return {text.data, offsets.data, counts.data, counts.length, text.length, offsets.length};
  }

  SegmentViews<3> _terms;
  SegmentViews<3> _surfaces;
  SegmentViews<3> _spellings;
  SegmentViews<6> _arrays;
  SegmentViews<2> _positions;
  bool _hasPositions = false;
};

}
