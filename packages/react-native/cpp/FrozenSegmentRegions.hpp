#pragma once

#include "PagedInput.hpp"
#include "SegmentRegions.hpp"
#include "narsil_frozen_segments.h"

#include <array>

namespace margelo::nitro::narsil {

inline constexpr size_t FROZEN_REGION_ARGUMENTS = 30;

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
    constexpr std::array<const char*, STRING_REGIONS> stringKeys{"text", "offsets", "counts"};
    prepareGroup(runtime, object.getProperty(runtime, "terms"), TERM_TEXT, stringKeys);
    _hasSurfaces = prepareGroup(runtime, object.getProperty(runtime, "surfaces"), SURFACE_TEXT, stringKeys, true);
    _hasSpellings = prepareGroup(runtime, object.getProperty(runtime, "spellings"), SPELLING_TEXT, stringKeys, true);
    constexpr std::array<const char*, INDEX_REGIONS> indexKeys{"starts", "rows", "termOfSlot"};
    _hasIndex = prepareGroup(runtime, object.getProperty(runtime, "removalIndex"), REMOVAL_STARTS, indexKeys, true);
    constexpr std::array<const char*, REMOVAL_STARTS - PAYLOAD_SLOTS> postingKeys{
        "payloadSlots", "postingOffsets", "postingDocuments", "postingFrequencies",
        "postingFields", "partialFields", "spellingTokens"};
    prepareGroup(runtime, source, PAYLOAD_SLOTS, postingKeys);
    constexpr std::array<const char*, REGION_END - TOMBSTONES> stateKeys{
        "tombstones",       "tombstoneCount", "removedDocuments", "removedOccurrences", "removedSurfaces",
        "removedSpellings", "pendingHeader",  "pendingDocuments", "pendingTokens",      "pendingUnits"};
    prepareGroup(runtime, state, TOMBSTONES, stateKeys);
  }

  void prepare(jsi::Runtime& runtime, const jsi::Value* arguments) {
    _documentCount = segmentUnsigned(arguments[DOCUMENT_COUNT]);
    _hasSurfaces = presentGroup(arguments, SURFACE_TEXT, STRING_REGIONS);
    _hasSpellings = presentGroup(arguments, SPELLING_TEXT, STRING_REGIONS);
    _hasIndex = presentGroup(arguments, REMOVAL_STARTS, INDEX_REGIONS);
    for (size_t at = TERM_TEXT; at < FROZEN_REGION_ARGUMENTS; at++) {
      if (!heldAt(at)) continue;
      _views.prepare(runtime, at, arguments[at]);
    }
  }

  narsil_frozen_segment read(jsi::Runtime& runtime) {
    narsil_frozen_segment segment{};
    segment.document_count = _documentCount;
    segment.terms = strings(runtime, TERM_TEXT, 1);
    if (segment.terms.count == SIZE_MAX) throwInvalid("The frozen posting offsets are too large");
    segment.payload_slots = region<const uint32_t>(runtime, PAYLOAD_SLOTS, segment.terms.count).data;
    segment.posting_offsets = region<const uint32_t>(runtime, POSTING_OFFSETS, segment.terms.count + 1).data;
    auto documents = region<const uint32_t>(runtime, POSTING_DOCUMENTS);
    segment.posting_documents = documents.data;
    segment.posting_count = documents.length;
    segment.posting_frequencies = region<const uint16_t>(runtime, POSTING_FREQUENCIES, documents.length).data;
    segment.posting_fields = region<const uint16_t>(runtime, POSTING_FIELDS, documents.length).data;
    auto partial = region<const uint8_t>(runtime, PARTIAL_FIELDS);
    if (partial.length > static_cast<size_t>(UINT16_MAX) + 1) throwInvalid("The frozen segment has too many fields");
    segment.partial_fields = partial.data;
    segment.field_count = partial.length;
    _surfaceTable = {};
    _spellingTable = {};
    if (_hasSurfaces) {
      _surfaceTable = strings(runtime, SURFACE_TEXT, 2);
      segment.surfaces = &_surfaceTable;
    }
    if (_hasSpellings) {
      _spellingTable = strings(runtime, SPELLING_TEXT, 1);
      segment.spellings = &_spellingTable;
    }
    segment.spelling_tokens = region<const uint32_t>(runtime, SPELLING_TOKENS, _spellingTable.count).data;
    if (_hasIndex) {
      size_t starts = static_cast<size_t>(_documentCount) + 1;
      if (starts == 0) throwInvalid("The frozen removal index is too large");
      _removalIndex = {region<const uint32_t>(runtime, REMOVAL_STARTS, starts).data,
                       region<const uint32_t>(runtime, REMOVAL_ROWS, documents.length).data,
                       region<const uint32_t>(runtime, REMOVAL_TERM_OF_SLOT, segment.terms.count).data};
      segment.removal_index = &_removalIndex;
    }
    return segment;
  }

  narsil_frozen_segment_state readState(jsi::Runtime& runtime, const narsil_frozen_segment& segment) {
    size_t words = _documentCount == 0 ? 1 : ((static_cast<size_t>(_documentCount) - 1) / 32) + 1;
    auto documents = region<uint32_t>(runtime, PENDING_DOCUMENTS);
    auto tokens = region<uint32_t>(runtime, PENDING_TOKENS);
    auto units = region<uint16_t>(runtime, PENDING_UNITS);
    if (tokens.length % NARSIL_PENDING_TOKEN_WORDS != 0) throwInvalid("The pending tokens hold a partial token");
    return {region<uint32_t>(runtime, TOMBSTONES, words).data,
            region<uint32_t>(runtime, TOMBSTONE_COUNT, 1).data,
            region<uint32_t>(runtime, REMOVED_DOCUMENTS, segment.terms.count).data,
            region<double>(runtime, REMOVED_OCCURRENCES, segment.terms.count).data,
            region<uint32_t>(runtime, REMOVED_SURFACES, _surfaceTable.count).data,
            region<uint32_t>(runtime, REMOVED_SPELLINGS, _spellingTable.count).data,
            region<uint32_t>(runtime, PENDING_HEADER, NARSIL_PENDING_HEADER_WORDS).data,
            documents.data,
            documents.length,
            tokens.data,
            tokens.length / NARSIL_PENDING_TOKEN_WORDS,
            units.data,
            units.length};
  }

private:
  enum : size_t {
    DOCUMENT_COUNT,
    TERM_TEXT,
    SURFACE_TEXT = TERM_TEXT + 3,
    SPELLING_TEXT = SURFACE_TEXT + 3,
    PAYLOAD_SLOTS = SPELLING_TEXT + 3,
    POSTING_OFFSETS,
    POSTING_DOCUMENTS,
    POSTING_FREQUENCIES,
    POSTING_FIELDS,
    PARTIAL_FIELDS,
    SPELLING_TOKENS,
    REMOVAL_STARTS,
    REMOVAL_ROWS,
    REMOVAL_TERM_OF_SLOT,
    TOMBSTONES,
    TOMBSTONE_COUNT,
    REMOVED_DOCUMENTS,
    REMOVED_OCCURRENCES,
    REMOVED_SURFACES,
    REMOVED_SPELLINGS,
    PENDING_HEADER,
    PENDING_DOCUMENTS,
    PENDING_TOKENS,
    PENDING_UNITS,
    REGION_END
  };
  static constexpr size_t STRING_REGIONS = 3;
  static constexpr size_t INDEX_REGIONS = 3;
  static_assert(REGION_END == FROZEN_REGION_ARGUMENTS);

  static bool presentGroup(const jsi::Value* arguments, size_t first, size_t count) {
    size_t absent = 0;
    for (size_t at = first; at < first + count; at++) absent += arguments[at].isNull() ? 1 : 0;
    if (absent != 0 && absent != count) throwInvalid("An optional frozen table must pass all of its regions or none");
    return absent == 0;
  }

  template <size_t Count>
  bool prepareGroup(jsi::Runtime& runtime, const jsi::Value& value, size_t first,
                    const std::array<const char*, Count>& keys, bool optional = false) {
    if (optional && value.isNull()) return false;
    if (!value.isObject()) throwInvalid("A frozen segment table must be an object");
    auto object = value.getObject(runtime);
    for (size_t at = 0; at < Count; at++) _views.prepare(runtime, first + at, object.getProperty(runtime, keys[at]));
    return true;
  }

  bool heldAt(size_t at) const {
    if (at >= SURFACE_TEXT && at < SURFACE_TEXT + STRING_REGIONS) return _hasSurfaces;
    if (at >= SPELLING_TEXT && at < SPELLING_TEXT + STRING_REGIONS) return _hasSpellings;
    if (at >= REMOVAL_STARTS && at < REMOVAL_STARTS + INDEX_REGIONS) return _hasIndex;
    return true;
  }

  template <typename Element>
  Elements<Element> region(jsi::Runtime& runtime, size_t index, size_t expected = SIZE_MAX) {
    auto found = _views.read<Element>(runtime, index, "The frozen segment region");
    if (expected != SIZE_MAX && found.length != expected) throwInvalid("The frozen segment region has the wrong length");
    return found;
  }

  narsil_frozen_strings strings(jsi::Runtime& runtime, size_t first, size_t stride) {
    auto text = region<const uint8_t>(runtime, first);
    auto counts = region<const uint32_t>(runtime, first + 2);
    if (counts.length > (SIZE_MAX - 1) / stride) throwInvalid("The frozen string offsets are too large");
    auto offsets = region<const uint32_t>(runtime, first + 1, static_cast<size_t>(counts.length) * stride + 1);
    return {text.data, text.length, offsets.data, counts.data, counts.length};
  }

  TypedElements _views{FROZEN_REGION_ARGUMENTS};
  narsil_frozen_strings _surfaceTable{};
  narsil_frozen_strings _spellingTable{};
  narsil_frozen_removal_index _removalIndex{};
  uint32_t _documentCount = 0;
  bool _hasSurfaces = false;
  bool _hasSpellings = false;
  bool _hasIndex = false;
};

class FrozenPagedRegions {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    _present = !value.isNull();
    if (!_present) return;
    if (!value.isObject()) throwInvalid("The paged removal sections must be an object");
    auto object = value.getObject(runtime);
    _offsets.prepare(runtime, object.getProperty(runtime, "offsets"));
    _values.prepare(runtime, object.getProperty(runtime, "values"));
    _cache.prepare(runtime, object.getProperty(runtime, "cache"));
    _fault.prepare(runtime, 0, object.getProperty(runtime, "fault"));
  }

  const narsil_frozen_paged_removals* read(jsi::Runtime& runtime) {
    if (!_present) return nullptr;
    _offsetSection = _offsets.read(runtime);
    _valueSection = _values.read(runtime);
    if (_cache.present) _pageCache = _cache.read(runtime);
    auto fault = _fault.read<uint64_t>(runtime, 0, "The page fault");
    if (fault.length != 3) throwInvalid("The page fault must hold three words");
    _removals = {_cache.present ? &_pageCache : nullptr, &_offsetSection, &_valueSection,
                 reinterpret_cast<narsil_page_fault*>(fault.data)};
    return &_removals;
  }

private:
  PagedSectionInput _offsets;
  PagedSectionInput _values;
  PagedCacheInput _cache;
  TypedElements _fault{1};
  narsil_page_section _offsetSection{};
  narsil_page_section _valueSection{};
  narsil_page_cache _pageCache{};
  narsil_frozen_paged_removals _removals{};
  bool _present = false;
};

}
