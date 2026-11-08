#pragma once

#include "SegmentRegions.hpp"
#include "narsil_frozen_segments.h"

namespace margelo::nitro::narsil {

class FrozenStringRegions {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    _views.prepare(runtime, value, {"text", "offsets", "counts"});
  }

  narsil_frozen_strings read(jsi::Runtime& runtime, size_t stride) {
    auto text = _views.read<const uint8_t>(runtime, 0);
    auto counts = _views.read<const uint32_t>(runtime, 2);
    if (counts.length > (SIZE_MAX - 1) / stride) throwInvalid("The frozen string offsets are too large");
    auto offsets = _views.read<const uint32_t>(runtime, 1, static_cast<size_t>(counts.length) * stride + 1);
    return {text.data, text.length, offsets.data, counts.data, counts.length};
  }

private:
  SegmentViews<3> _views;
};

class FrozenSegmentRegions {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& source, const jsi::Value& state) {
    if (!source.isObject()) throwInvalid("The frozen segment must be an object");
    auto object = source.getObject(runtime);
    _documentCount = segmentUnsigned(object.getProperty(runtime, "documentCount"));
    _terms.prepare(runtime, object.getProperty(runtime, "terms"));
    _postings.prepare(runtime, source, {"payloadSlots", "postingOffsets", "postingDocuments", "postingFrequencies",
                                       "postingFields", "partialFields", "spellingTokens"});
    _state.prepare(runtime, state, {"tombstones", "tombstoneCount", "removedDocuments", "removedOccurrences",
                                    "removedSurfaces", "removedSpellings"});
    auto surfaces = object.getProperty(runtime, "surfaces");
    _hasSurfaces = !surfaces.isNull();
    if (_hasSurfaces) _surfaces.prepare(runtime, surfaces);
    auto spellings = object.getProperty(runtime, "spellings");
    _hasSpellings = !spellings.isNull();
    if (_hasSpellings) _spellings.prepare(runtime, spellings);
    auto index = object.getProperty(runtime, "removalIndex");
    _hasIndex = !index.isNull();
    if (_hasIndex) _index.prepare(runtime, index, {"starts", "rows", "termOfSlot"});
    auto removalTerms = object.getProperty(runtime, "removalTerms");
    _hasRemovalTerms = !removalTerms.isNull() && !removalTerms.isUndefined();
    if (_hasRemovalTerms) _removalTerms.prepare(runtime, 0, removalTerms);
  }

  narsil_frozen_segment read(jsi::Runtime& runtime) {
    narsil_frozen_segment segment{};
    segment.document_count = _documentCount;
    segment.terms = _terms.read(runtime, 1);
    if (segment.terms.count == SIZE_MAX) throwInvalid("The frozen posting offsets are too large");
    segment.payload_slots = _postings.read<const uint32_t>(runtime, 0, segment.terms.count).data;
    segment.posting_offsets = _postings.read<const uint32_t>(runtime, 1, segment.terms.count + 1).data;
    auto documents = _postings.read<const uint32_t>(runtime, 2);
    segment.posting_documents = documents.data;
    segment.posting_count = documents.length;
    segment.posting_frequencies = _postings.read<const uint16_t>(runtime, 3, documents.length).data;
    segment.posting_fields = _postings.read<const uint16_t>(runtime, 4, documents.length).data;
    auto partial = _postings.read<const uint8_t>(runtime, 5);
    if (partial.length > static_cast<size_t>(UINT16_MAX) + 1) throwInvalid("The frozen segment has too many fields");
    segment.partial_fields = partial.data;
    segment.field_count = partial.length;
    if (_hasSurfaces) {
      _surfaceTable = _surfaces.read(runtime, 2);
      segment.surfaces = &_surfaceTable;
    }
    if (_hasSpellings) {
      _spellingTable = _spellings.read(runtime, 1);
      segment.spellings = &_spellingTable;
    }
    segment.spelling_tokens = _postings.read<const uint32_t>(runtime, 6, _spellingTable.count).data;
    if (_hasIndex) {
      size_t starts = static_cast<size_t>(_documentCount) + 1;
      if (starts == 0) throwInvalid("The frozen removal index is too large");
      _removalIndex = {_index.read<const uint32_t>(runtime, 0, starts).data,
                       _index.read<const uint32_t>(runtime, 1, documents.length).data,
                       _index.read<const uint32_t>(runtime, 2, segment.terms.count).data};
      segment.removal_index = &_removalIndex;
    }
    if (_hasRemovalTerms) {
      auto terms = _removalTerms.read<const uint32_t>(runtime, 0, "The removal terms");
      segment.removal_terms = terms.data;
      segment.removal_words = terms.length;
    }
    return segment;
  }

  narsil_frozen_segment_state readState(jsi::Runtime& runtime, size_t termCount) {
    size_t words = _documentCount == 0 ? 1 : ((static_cast<size_t>(_documentCount) - 1) / 32) + 1;
    return {_state.read<uint32_t>(runtime, 0, words).data, _state.read<uint32_t>(runtime, 1, 1).data,
            _state.read<uint32_t>(runtime, 2, termCount).data, _state.read<double>(runtime, 3, termCount).data,
            _state.read<uint32_t>(runtime, 4, _surfaceTable.count).data,
            _state.read<uint32_t>(runtime, 5, _spellingTable.count).data};
  }

private:
  FrozenStringRegions _terms;
  FrozenStringRegions _surfaces;
  FrozenStringRegions _spellings;
  SegmentViews<7> _postings;
  SegmentViews<6> _state;
  SegmentViews<3> _index;
  narsil_frozen_strings _surfaceTable{};
  narsil_frozen_strings _spellingTable{};
  narsil_frozen_removal_index _removalIndex{};
  uint32_t _documentCount = 0;
  bool _hasSurfaces = false;
  bool _hasSpellings = false;
  bool _hasIndex = false;
  TypedElements _removalTerms{1};
  bool _hasRemovalTerms = false;
};

}
