#include "HostMemory.hpp"
#include "HybridNarsilCoreImpl.hpp"
#include "narsil_packed_tokens.h"

#include <NitroModules/ArrayBuffer.hpp>
#include <NitroModules/JSIConverter.hpp>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace margelo::nitro::narsil {

namespace {

enum AnalyseArgument : size_t {
  ANALYSE_LANGUAGE,
  ANALYSE_FLAGS,
  ANALYSE_TEXT,
  ANALYSE_STOP_WORDS,
  ANALYSE_RECORD_BUFFER,
  ANALYSE_RECORD_BYTE_OFFSET,
  ANALYSE_RECORD_LENGTH,
  ANALYSE_ARGUMENT_COUNT
};

enum PackedArgument : size_t {
  PACKED_UNIT_BUFFER = ANALYSE_ARGUMENT_COUNT,
  PACKED_UNIT_BYTE_OFFSET,
  PACKED_UNIT_LENGTH,
  PACKED_ARGUMENT_COUNT
};

enum PackedRecord : size_t { PACKED_NEEDED_UNITS = 1, PACKED_RECORD_MIN_WORDS };

enum TransformArgument : size_t { TRANSFORM_LANGUAGE, TRANSFORM_FLAGS, TRANSFORM_TEXT, TRANSFORM_ARGUMENT_COUNT };

enum TokenRecord : size_t {
  RECORD_POSITION,
  RECORD_TERM_OFFSET,
  RECORD_TERM_LENGTH,
  RECORD_SURFACE_OFFSET,
  RECORD_SURFACE_LENGTH,
  RECORD_ORIGINAL_OFFSET,
  RECORD_ORIGINAL_LENGTH,
  RECORD_TERM_SLOT,
  TOKEN_RECORD_WORDS
};

const uint16_t NO_UNITS[1] = {0};

class StopWordSetState final : public jsi::NativeState {
public:
  StopWordSetState() = default;
  ~StopWordSetState() override { narsil_stop_word_set_destroy(set); }
  StopWordSetState(const StopWordSetState&) = delete;
  StopWordSetState& operator=(const StopWordSetState&) = delete;
  narsil_stop_word_set* set = nullptr;
};

uint32_t wholeArgument(const jsi::Value* arguments, size_t count, size_t index, const char* what) {
  if (index >= count || !arguments[index].isNumber()) throwInvalid(std::string(what) + " must be a number");
  double value = arguments[index].getNumber();
  if (!std::isfinite(value) || value < 0 || value > UINT32_MAX || std::floor(value) != value) {
    throwInvalid(std::string(what) + " must be a whole number from 0 to 4294967295");
  }
  return static_cast<uint32_t>(value);
}

uint32_t languageArgument(const jsi::Value* arguments, size_t count, size_t index) {
  uint32_t language = wholeArgument(arguments, count, index, "The language index");
  if (language >= narsil_language_count()) throwInvalid("The language index names no language module of the core");
  return language;
}

void appendUnits(jsi::Runtime& runtime, const jsi::String& text, std::vector<uint16_t>& units, size_t limit) {
  bool tooLong = false;
  auto collect = [&units, &tooLong, limit](bool ascii, const void* data, size_t length) {
    if (tooLong || length > limit - units.size()) {
      tooLong = true;
      return;
    }
    size_t start = units.size();
    units.resize(start + length);
    if (ascii) {
      const auto* characters = static_cast<const unsigned char*>(data);
      for (size_t index = 0; index < length; index++) units[start + index] = characters[index];
    } else if (length > 0) {
      std::memcpy(units.data() + start, data, length * sizeof(uint16_t));
    }
  };
  text.getStringData(runtime, collect);
  if (tooLong) throwInvalid("The text holds more code units than the core analyses at once");
}

const narsil_stop_word_set* stopWordsArgument(jsi::Runtime& runtime, const jsi::Value& value) {
  if (value.isNull()) return nullptr;
  if (value.isObject()) {
    jsi::Object handle = value.getObject(runtime);
    if (handle.hasNativeState<StopWordSetState>(runtime)) return handle.getNativeState<StopWordSetState>(runtime)->set;
  }
  throwInvalid("The stop words must be a set from createStopWordSet, or null");
}

uint32_t* recordsArgument(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, size_t* capacity) {
  uint32_t byteOffset = wholeArgument(arguments, count, ANALYSE_RECORD_BYTE_OFFSET, "The record byte offset");
  uint32_t length = wholeArgument(arguments, count, ANALYSE_RECORD_LENGTH, "The record length");
  const jsi::Value& value = arguments[ANALYSE_RECORD_BUFFER];
  if (!value.isObject()) throwInvalid("The records must be a Uint32Array");
  jsi::Object object = value.getObject(runtime);
  if (!object.isArrayBuffer(runtime)) throwInvalid("The records must be a Uint32Array");
  jsi::ArrayBuffer buffer = object.getArrayBuffer(runtime);
  size_t held = buffer.size(runtime);
  if (length == 0 || byteOffset > held || static_cast<size_t>(length) > (held - byteOffset) / sizeof(uint32_t)) {
    throwInvalid("The records reach past the end of their buffer, or hold no entry");
  }
  uint8_t* bytes = buffer.data(runtime) + byteOffset;
  if (reinterpret_cast<uintptr_t>(bytes) % alignof(uint32_t) != 0) throwInvalid("The records are misaligned");
  *capacity = length;
  return reinterpret_cast<uint32_t*>(bytes);
}

uint16_t* unitsArgument(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, size_t* capacity) {
  uint32_t byteOffset = wholeArgument(arguments, count, PACKED_UNIT_BYTE_OFFSET, "The unit byte offset");
  uint32_t length = wholeArgument(arguments, count, PACKED_UNIT_LENGTH, "The unit length");
  const jsi::Value& value = arguments[PACKED_UNIT_BUFFER];
  if (!value.isObject()) throwInvalid("The units must be a Uint16Array");
  jsi::Object object = value.getObject(runtime);
  if (!object.isArrayBuffer(runtime)) throwInvalid("The units must be a Uint16Array");
  jsi::ArrayBuffer buffer = object.getArrayBuffer(runtime);
  size_t held = buffer.size(runtime);
  if (byteOffset > held || static_cast<size_t>(length) > (held - byteOffset) / sizeof(uint16_t)) {
    throwInvalid("The units reach past the end of their buffer");
  }
  *capacity = length;
  if (length == 0) return nullptr;
  uint8_t* bytes = buffer.data(runtime) + byteOffset;
  if (reinterpret_cast<uintptr_t>(bytes) % alignof(uint16_t) != 0) throwInvalid("The units are misaligned");
  return reinterpret_cast<uint16_t*>(bytes);
}

bool writeRecords(const narsil_tokens& tokens, uint32_t* records, size_t capacity) {
  records[0] = tokens.token_count;
  if (capacity - 1 < static_cast<size_t>(tokens.token_count) * TOKEN_RECORD_WORDS) return false;
  uint32_t* record = records + 1;
  for (uint32_t index = 0; index < tokens.token_count; index++) {
    const narsil_token& token = tokens.tokens[index];
    record[RECORD_POSITION] = token.position;
    record[RECORD_TERM_OFFSET] = token.term_offset;
    record[RECORD_TERM_LENGTH] = token.term_length;
    record[RECORD_SURFACE_OFFSET] = token.surface_offset;
    record[RECORD_SURFACE_LENGTH] = token.surface_length;
    record[RECORD_ORIGINAL_OFFSET] = token.original_offset;
    record[RECORD_ORIGINAL_LENGTH] = token.original_length;
    record[RECORD_TERM_SLOT] = token.term_slot;
    record += TOKEN_RECORD_WORDS;
  }
  return true;
}

jsi::Value statusValue(narsil_status status) { return jsi::Value(-static_cast<double>(status)); }

narsil_analyser* analyserOf(std::unique_ptr<narsil_analyser, AnalyserRelease>& held) {
  if (held == nullptr) {
    narsil_analyser* created = nullptr;
    if (narsil_analyser_create(&created) != NARSIL_OK) return nullptr;
    held.reset(created);
  }
  return held.get();
}

void readText(jsi::Runtime& runtime, const jsi::Value& value, const char* what, std::vector<uint16_t>& units) {
  if (!value.isString()) throwInvalid(std::string(what) + " must be a string");
  units.clear();
  appendUnits(runtime, value.getString(runtime), units, NARSIL_MAX_ANALYSED_UNITS);
}

jsi::Value textOf(jsi::Runtime& runtime, std::u16string& out, const uint16_t* units, size_t length) {
  out.resize(length);
  if (length > 0) std::memcpy(out.data(), units, length * sizeof(uint16_t));
  return jsi::String::createFromUtf16(runtime, out);
}

}

void HybridNarsilCoreImpl::loadHybridMethods() {
  HybridNarsilCoreSpec::loadHybridMethods();
  registerHybrids(this, [](Prototype& prototype) {
    prototype.registerRawHybridMethod("matchPhrases", MATCH_PHRASES_ARGUMENT_COUNT, &HybridNarsilCoreImpl::matchPhrases);
    prototype.registerRawHybridMethod("languageCount", 0, &HybridNarsilCoreImpl::languageCount);
    prototype.registerRawHybridMethod("languageName", 1, &HybridNarsilCoreImpl::languageName);
    prototype.registerRawHybridMethod("languageRevision", 1, &HybridNarsilCoreImpl::languageRevision);
    prototype.registerRawHybridMethod("languageStopWords", 1, &HybridNarsilCoreImpl::languageStopWords);
    prototype.registerRawHybridMethod("createStopWordSet", 1, &HybridNarsilCoreImpl::createStopWordSet);
    prototype.registerRawHybridMethod("analyse", ANALYSE_ARGUMENT_COUNT, &HybridNarsilCoreImpl::analyse);
    prototype.registerRawHybridMethod("analysePacked", PACKED_ARGUMENT_COUNT, &HybridNarsilCoreImpl::analysePacked);
    prototype.registerRawHybridMethod("transform", TRANSFORM_ARGUMENT_COUNT, &HybridNarsilCoreImpl::transform);
    prototype.registerRawHybridMethod("keywordScore", KEYWORD_SCORE_ARGUMENT_COUNT,
                                      &HybridNarsilCoreImpl::keywordScore);
    prototype.registerRawHybridMethod("fuse", FUSION_ARGUMENT_COUNT, &HybridNarsilCoreImpl::fuse);
    prototype.registerRawHybridMethod("mergeRankings", MERGE_RANKINGS_ARGUMENT_COUNT,
                                      &HybridNarsilCoreImpl::mergeRankings);
    prototype.registerRawHybridMethod("mergeSorted", MERGE_SORTED_ARGUMENT_COUNT,
                                      &HybridNarsilCoreImpl::mergeSorted);
    prototype.registerRawHybridMethod("placePinned", PINNED_ARGUMENT_COUNT, &HybridNarsilCoreImpl::placePinned);
    prototype.registerRawHybridMethod("mergeFacets", FACET_MERGE_ARGUMENT_COUNT, &HybridNarsilCoreImpl::mergeFacets);
    prototype.registerRawHybridMethod("mergeGroups", GROUP_MERGE_ARGUMENT_COUNT, &HybridNarsilCoreImpl::mergeGroups);
    prototype.registerRawHybridMethod("groupHits", GROUP_HITS_ARGUMENT_COUNT, &HybridNarsilCoreImpl::groupHits);
    prototype.registerRawHybridMethod("pageStart", PAGE_START_ARGUMENT_COUNT, &HybridNarsilCoreImpl::pageStart);
    prototype.registerRawHybridMethod("sortValue", SORT_VALUE_ARGUMENT_COUNT, &HybridNarsilCoreImpl::sortValue);
    prototype.registerRawHybridMethod("buildSortOrder", SORT_ORDER_ARGUMENT_COUNT,
                                      &HybridNarsilCoreImpl::buildSortOrder);
    prototype.registerRawHybridMethod("textRange", TEXT_RANGE_ARGUMENT_COUNT, &HybridNarsilCoreImpl::textRange);
    prototype.registerRawHybridMethod("booleanFacet", BOOLEAN_FACET_ARGUMENT_COUNT, &HybridNarsilCoreImpl::booleanFacet);
    prototype.registerRawHybridMethod("numberFacet", NUMERIC_FACET_ARGUMENT_COUNT, &HybridNarsilCoreImpl::numberFacet);
    prototype.registerRawHybridMethod("rangeFacet", NUMERIC_FACET_ARGUMENT_COUNT, &HybridNarsilCoreImpl::rangeFacet);
    prototype.registerRawHybridMethod("enumFacet", ENUM_FACET_ARGUMENT_COUNT, &HybridNarsilCoreImpl::enumFacet);
    prototype.registerRawHybridMethod("valueFacet", VALUE_FACET_ARGUMENT_COUNT, &HybridNarsilCoreImpl::valueFacet);
    prototype.registerRawHybridMethod("storedRangeFacet", STORED_RANGE_FACET_ARGUMENT_COUNT, &HybridNarsilCoreImpl::storedRangeFacet);
    prototype.registerRawHybridMethod("sortSelect", SORT_SELECT_ARGUMENT_COUNT, &HybridNarsilCoreImpl::sortSelect);
    prototype.registerRawHybridMethod("evaluateFilter", FILTER_ARGUMENT_COUNT, &HybridNarsilCoreImpl::evaluateFilter);
    prototype.registerRawHybridMethod("patternTest", PATTERN_ARGUMENT_COUNT, &HybridNarsilCoreImpl::patternTest);
    prototype.registerRawHybridMethod("lookupExact", LOOKUP_EXACT_ARGUMENT_COUNT, &HybridNarsilCoreImpl::lookupExact);
    prototype.registerRawHybridMethod("lookupExactBatch", LOOKUP_EXACT_BATCH_ARGUMENT_COUNT, &HybridNarsilCoreImpl::lookupExactBatch);
    prototype.registerRawHybridMethod("expandSynonyms", EXPAND_SYNONYMS_ARGUMENT_COUNT, &HybridNarsilCoreImpl::expandSynonyms);
    prototype.registerRawHybridMethod("expandPrefix", EXPAND_PREFIX_ARGUMENT_COUNT, &HybridNarsilCoreImpl::expandPrefix);
    prototype.registerRawHybridMethod("expandPartialWords", EXPAND_PARTIAL_ARGUMENT_COUNT, &HybridNarsilCoreImpl::expandPartialWords);
    prototype.registerRawHybridMethod("suggestTerms", SUGGEST_TERMS_ARGUMENT_COUNT, &HybridNarsilCoreImpl::suggestTerms);
    prototype.registerRawHybridMethod("highlight", HIGHLIGHT_ARGUMENT_COUNT, &HybridNarsilCoreImpl::highlight);
    prototype.registerRawHybridMethod("openPagedFile", 1, &HybridNarsilCoreImpl::openPagedFile);
    prototype.registerRawHybridMethod("closePagedFile", 1, &HybridNarsilCoreImpl::closePagedFile);
    prototype.registerRawHybridMethod("readPage", 5, &HybridNarsilCoreImpl::readPage);
    prototype.registerRawHybridMethod("readPageAsync", 5, &HybridNarsilCoreImpl::readPageAsync);
    prototype.registerRawHybridMethod("readPagedPostings", 8, &HybridNarsilCoreImpl::readPagedPostings);
    prototype.registerRawHybridMethod("readPagedPositions", 8, &HybridNarsilCoreImpl::readPagedPositions);
    prototype.registerRawHybridMethod("readPagedRemovals", 7, &HybridNarsilCoreImpl::readPagedRemovals);
    prototype.registerRawHybridMethod("readPagedId", 6, &HybridNarsilCoreImpl::readPagedId);
    prototype.registerRawHybridMethod("readPagedOrdinal", 6, &HybridNarsilCoreImpl::readPagedOrdinal);
    prototype.registerRawHybridMethod("readPagedWriteRecord", 6, &HybridNarsilCoreImpl::readPagedWriteRecord);
    prototype.registerRawHybridMethod("readPagedTotals", 6, &HybridNarsilCoreImpl::readPagedTotals);
    prototype.registerRawHybridMethod("searchPagedVectors", 9, &HybridNarsilCoreImpl::searchPagedVectors);
    prototype.registerRawHybridMethod("searchPagedVectorsAsync", 9, &HybridNarsilCoreImpl::searchPagedVectorsAsync);
    prototype.registerRawHybridMethod("lookupPrefix", LOOKUP_PREFIX_ARGUMENT_COUNT, &HybridNarsilCoreImpl::lookupPrefix);
    prototype.registerRawHybridMethod("lookupTypo", LOOKUP_TYPO_ARGUMENT_COUNT, &HybridNarsilCoreImpl::lookupTypo);
    prototype.registerRawHybridMethod("documentFrequency", DOCUMENT_FREQUENCY_ARGUMENT_COUNT, &HybridNarsilCoreImpl::documentFrequency);
    prototype.registerRawHybridMethod("indexTerms", INDEX_TERMS_ARGUMENT_COUNT, &HybridNarsilCoreImpl::indexTerms);
    prototype.registerRawHybridMethod("removeDocument", INDEX_TERMS_ARGUMENT_COUNT, &HybridNarsilCoreImpl::removeDocument);
    prototype.registerRawHybridMethod("removeFrozenDocument", REMOVE_FROZEN_ARGUMENT_COUNT, &HybridNarsilCoreImpl::removeFrozenDocument);
    prototype.registerRawHybridMethod("prepareFrozenRemoval", PREPARE_FROZEN_ARGUMENT_COUNT, &HybridNarsilCoreImpl::prepareFrozenRemoval);
    prototype.registerRawHybridMethod("settleFrozenState", SETTLE_FROZEN_ARGUMENT_COUNT, &HybridNarsilCoreImpl::settleFrozenState);
    prototype.registerRawHybridMethod("beginBatch", KEYWORD_BATCH_ARGUMENT_COUNT, &HybridNarsilCoreImpl::beginBatch);
    prototype.registerRawHybridMethod("measureMerge", 4, &HybridNarsilCoreImpl::measureMerge);
    prototype.registerRawHybridMethod("writeMerge", 4, &HybridNarsilCoreImpl::writeMerge);
    prototype.registerRawHybridMethod("mergePostings", 4, &HybridNarsilCoreImpl::mergePostings);
    prototype.registerRawHybridMethod("measureFieldMerge", 4, &HybridNarsilCoreImpl::measureFieldMerge);
    prototype.registerRawHybridMethod("writeFieldMerge", 4, &HybridNarsilCoreImpl::writeFieldMerge);
    prototype.registerRawHybridMethod("endBatch", KEYWORD_BATCH_ARGUMENT_COUNT, &HybridNarsilCoreImpl::endBatch);
    prototype.registerRawHybridMethod("clockNow", 1, &HybridNarsilCoreImpl::clockNow);
  });
}

HybridNarsilCoreImpl::RuntimeState& HybridNarsilCoreImpl::stateOf(jsi::Runtime& runtime) {
  std::lock_guard<std::mutex> guard(_runtimeStateLock);
  std::unique_ptr<RuntimeState>& held = _stateByRuntime[&runtime];
  if (held == nullptr) held = std::make_unique<RuntimeState>();
  return *held;
}

jsi::Value HybridNarsilCoreImpl::languageCount(jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
  return jsi::Value(static_cast<double>(narsil_language_count()));
}

jsi::Value HybridNarsilCoreImpl::languageName(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* arguments,
                                              size_t count) {
  return jsi::String::createFromAscii(runtime, narsil_language_name(languageArgument(arguments, count, 0)));
}

jsi::Value HybridNarsilCoreImpl::languageRevision(jsi::Runtime& runtime, const jsi::Value&,
                                                  const jsi::Value* arguments, size_t count) {
  return jsi::String::createFromAscii(runtime, narsil_language_revision(languageArgument(arguments, count, 0)));
}

jsi::Value HybridNarsilCoreImpl::languageStopWords(jsi::Runtime& runtime, const jsi::Value&,
                                                   const jsi::Value* arguments, size_t count) {
  narsil_word_list list = {nullptr, nullptr, 0};
  if (narsil_language_stop_words(languageArgument(arguments, count, 0), &list) != NARSIL_OK) {
    throwInvalid("The core holds no stop words for that language");
  }
  std::u16string& out = stateOf(runtime).textOut;
  jsi::Array words(runtime, list.count);
  for (uint32_t index = 0; index < list.count; index++) {
    uint32_t start = list.offsets[index];
    words.setValueAtIndex(runtime, index, textOf(runtime, out, list.units + start, list.offsets[index + 1] - start));
  }
  return words;
}

jsi::Value HybridNarsilCoreImpl::createStopWordSet(jsi::Runtime& runtime, const jsi::Value&,
                                                   const jsi::Value* arguments, size_t count) {
  if (count < 1 || !arguments[0].isObject() || !arguments[0].getObject(runtime).isArray(runtime)) {
    throwInvalid("createStopWordSet takes one list of words");
  }
  jsi::Array list = arguments[0].getObject(runtime).getArray(runtime);
  size_t wordCount = list.size(runtime);
  if (wordCount >= UINT32_MAX) throwInvalid("createStopWordSet takes fewer than 4294967295 words");
  std::vector<uint16_t> units;
  std::vector<uint32_t> offsets(wordCount + 1, 0);
  for (size_t index = 0; index < wordCount; index++) {
    jsi::Value word = list.getValueAtIndex(runtime, index);
    if (!word.isString()) throwInvalid("Every stop word must be a string");
    size_t start = units.size();
    appendUnits(runtime, word.getString(runtime), units, start + NARSIL_MAX_ANALYSED_UNITS);
    if (units.size() > UINT32_MAX) throwInvalid("The stop words hold more code units than the core can index");
    offsets[index + 1] = static_cast<uint32_t>(units.size());
  }
  auto state = std::make_shared<StopWordSetState>();
  narsil_status status = narsil_stop_word_set_create(units.empty() ? NO_UNITS : units.data(), offsets.data(),
                                                     static_cast<uint32_t>(wordCount), &state->set);
  if (status == NARSIL_OUT_OF_MEMORY) throwSystemError(ENOMEM, "hold the stop words", "");
  if (status != NARSIL_OK) throwInvalid("The core cannot hold those stop words");
  jsi::Object handle(runtime);
  handle.setNativeState(runtime, state);
  return handle;
}

jsi::Value HybridNarsilCoreImpl::analyse(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* arguments,
                                         size_t count) {
  narsil_analysis_request request = {0, nullptr, 0, nullptr, 0};
  request.language = languageArgument(arguments, count, ANALYSE_LANGUAGE);
  request.flags = wholeArgument(arguments, count, ANALYSE_FLAGS, "The analysis flags");
  if (count < ANALYSE_ARGUMENT_COUNT) throwInvalid("analyse takes seven arguments");
  request.stop_words = stopWordsArgument(runtime, arguments[ANALYSE_STOP_WORDS]);
  RuntimeState& analysis = stateOf(runtime);
  readText(runtime, arguments[ANALYSE_TEXT], "The text", analysis.textUnits);
  narsil_analyser* active = analyserOf(analysis.analyser);
  if (active == nullptr) return statusValue(NARSIL_OUT_OF_MEMORY);
  size_t capacity = 0;
  uint32_t* records = recordsArgument(runtime, arguments, count, &capacity);
  request.text = analysis.textUnits.empty() ? NO_UNITS : analysis.textUnits.data();
  request.length = static_cast<uint32_t>(analysis.textUnits.size());
  narsil_tokens tokens = {nullptr, 0, nullptr, 0};
  narsil_status status = narsil_analyse(active, &request, &tokens);
  if (status != NARSIL_OK) return statusValue(status);
  if (!writeRecords(tokens, records, capacity)) return jsi::Value::null();
  return textOf(runtime, analysis.textOut, tokens.units, tokens.unit_count);
}

jsi::Value HybridNarsilCoreImpl::analysePacked(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* arguments,
                                               size_t count) {
  narsil_analysis_request request = {0, nullptr, 0, nullptr, 0};
  request.language = languageArgument(arguments, count, ANALYSE_LANGUAGE);
  request.flags = wholeArgument(arguments, count, ANALYSE_FLAGS, "The analysis flags");
  if (count < PACKED_ARGUMENT_COUNT) throwInvalid("analysePacked takes ten arguments");
  request.stop_words = stopWordsArgument(runtime, arguments[ANALYSE_STOP_WORDS]);
  RuntimeState& analysis = stateOf(runtime);
  readText(runtime, arguments[ANALYSE_TEXT], "The text", analysis.textUnits);
  narsil_analyser* active = analyserOf(analysis.analyser);
  if (active == nullptr) return statusValue(NARSIL_OUT_OF_MEMORY);
  size_t capacity = 0;
  uint32_t* records = recordsArgument(runtime, arguments, count, &capacity);
  if (capacity < PACKED_RECORD_MIN_WORDS) throwInvalid("The packed records need room for the needed unit count");
  size_t unitCapacity = 0;
  uint16_t* units = unitsArgument(runtime, arguments, count, &unitCapacity);
  request.text = analysis.textUnits.empty() ? NO_UNITS : analysis.textUnits.data();
  request.length = static_cast<uint32_t>(analysis.textUnits.size());
  narsil_tokens tokens = {nullptr, 0, nullptr, 0};
  narsil_status status = narsil_analyse(active, &request, &tokens);
  if (status != NARSIL_OK) return statusValue(status);
  uint32_t needed = 0;
  status = narsil_pack_tokens(&tokens, records, capacity, units, unitCapacity, &needed);
  if (status == NARSIL_NEEDS_ROOM) {
    records[PACKED_NEEDED_UNITS] = needed;
    return jsi::Value::null();
  }
  if (status != NARSIL_OK) return statusValue(status);
  return jsi::Value(static_cast<double>(needed));
}

jsi::Value HybridNarsilCoreImpl::transform(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* arguments,
                                           size_t count) {
  narsil_analysis_request request = {0, nullptr, 0, nullptr, 0};
  request.language = languageArgument(arguments, count, TRANSFORM_LANGUAGE);
  request.flags = wholeArgument(arguments, count, TRANSFORM_FLAGS, "The transform flags");
  if (count < TRANSFORM_ARGUMENT_COUNT) throwInvalid("transform takes three arguments");
  RuntimeState& analysis = stateOf(runtime);
  readText(runtime, arguments[TRANSFORM_TEXT], "The token", analysis.textUnits);
  narsil_analyser* active = analyserOf(analysis.analyser);
  if (active == nullptr) return statusValue(NARSIL_OUT_OF_MEMORY);
  request.text = analysis.textUnits.empty() ? NO_UNITS : analysis.textUnits.data();
  request.length = static_cast<uint32_t>(analysis.textUnits.size());
  narsil_term term = {nullptr, 0};
  narsil_status status = narsil_transform(active, &request, &term);
  if (status != NARSIL_OK) return statusValue(status);
  return textOf(runtime, analysis.textOut, term.units, term.length);
}

}
