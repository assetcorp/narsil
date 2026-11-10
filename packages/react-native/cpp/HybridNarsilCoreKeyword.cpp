#include "HostMemory.hpp"
#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "core/src/keyword/regions.h"
#include "narsil_fusion.h"

#include <cerrno>
#include <cmath>
#include <cstdint>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

namespace margelo::nitro::narsil {

namespace {

enum KeywordArgument : size_t {
  ARGUMENT_POOL_DOC_IDS,
  ARGUMENT_POOL_FREQUENCIES,
  ARGUMENT_POOL_FIELDS,
  ARGUMENT_ROW_DOC_IDS,
  ARGUMENT_ROW_FREQUENCIES,
  ARGUMENT_ROW_FIELDS,
  ARGUMENT_SLOTS,
  ARGUMENT_LISTS,
  ARGUMENT_LIST_VALUES,
  ARGUMENT_SLOT_VALUES,
  ARGUMENT_SEARCHABLE,
  ARGUMENT_PARTIAL_MARKS,
  ARGUMENT_NAME_RANKS,
  ARGUMENT_FIELD_NUMBERS,
  ARGUMENT_LENGTHS,
  ARGUMENT_FILTER,
  ARGUMENT_LIVE,
  ARGUMENT_REMOVED,
  ARGUMENT_SETTINGS,
  ARGUMENT_ORDINALS,
  ARGUMENT_SCORES,
  ARGUMENT_MATCHED,
  ARGUMENT_OUTCOME,
  ARGUMENT_COUNT
};

enum FusionArgument : size_t {
  FUSE_STRATEGY,
  FUSE_K,
  FUSE_ALPHA,
  FUSE_TEXT_KEYS,
  FUSE_TEXT_SCORES,
  FUSE_VECTOR_KEYS,
  FUSE_VECTOR_SCORES,
  FUSE_ID_RANKS,
  FUSE_OUTPUT_KEYS,
  FUSE_OUTPUT_SCORES,
  FUSE_ARGUMENT_COUNT
};

static_assert(FUSE_ARGUMENT_COUNT == FUSION_ARGUMENT_COUNT);

static_assert(ARGUMENT_COUNT == KEYWORD_SCORE_ARGUMENT_COUNT);

enum Setting : size_t {
  SETTING_SLOTS,
  SETTING_TERMS,
  SETTING_CAPACITY,
  SETTING_TOTAL_DOCUMENTS,
  SETTING_TERM_MATCH,
  SETTING_ANCHOR,
  SETTING_LIMIT,
  SETTING_MIN_SCORE,
  SETTING_COLLECT,
  SETTING_COUNT
};

enum Outcome : size_t { OUTCOME_COUNT, OUTCOME_TOTAL_MATCHED, OUTCOME_SCORING_PATH };

constexpr uint32_t OUTCOME_MIN_LENGTH = OUTCOME_SCORING_PATH;

uint32_t wholeCount(double value, const char* what) {
  if (!(value >= 0) || value > UINT32_MAX || std::floor(value) != value) {
    throwInvalid(std::string(what) + " must be a whole number from 0 to 4294967295");
  }
  return static_cast<uint32_t>(value);
}

uint32_t shorterOf(uint32_t first, uint32_t second) { return first < second ? first : second; }

void readRows(jsi::Runtime& runtime, TypedElements& views, narsil_keyword_request& request) {
  auto poolDocIds = views.read<const uint32_t>(runtime, ARGUMENT_POOL_DOC_IDS, "The pool ordinals");
  auto poolFrequencies =
      views.read<const uint16_t>(runtime, ARGUMENT_POOL_FREQUENCIES, "The pool frequencies");
  auto poolFields = views.read<const uint16_t>(runtime, ARGUMENT_POOL_FIELDS, "The pool fields");
  auto rowDocIds = views.read<const uint32_t>(runtime, ARGUMENT_ROW_DOC_IDS, "The row ordinals");
  auto rowFrequencies = views.read<const double>(runtime, ARGUMENT_ROW_FREQUENCIES, "The row frequencies");
  auto rowFields = views.read<const uint16_t>(runtime, ARGUMENT_ROW_FIELDS, "The row fields");
  request.pool_doc_ids = poolDocIds.data;
  request.pool_frequencies = poolFrequencies.data;
  request.pool_fields = poolFields.data;
  request.pool_length = shorterOf(poolDocIds.length, shorterOf(poolFrequencies.length, poolFields.length));
  request.row_doc_ids = rowDocIds.data;
  request.row_frequencies = rowFrequencies.data;
  request.row_fields = rowFields.data;
  request.row_length = shorterOf(rowDocIds.length, shorterOf(rowFrequencies.length, rowFields.length));
}

void readSlots(jsi::Runtime& runtime, TypedElements& views, narsil_keyword_request& request) {
  auto slots = views.read<const uint32_t>(runtime, ARGUMENT_SLOTS, "The slots");
  auto lists = views.read<const uint32_t>(runtime, ARGUMENT_LISTS, "The lists");
  auto listValues = views.read<const double>(runtime, ARGUMENT_LIST_VALUES, "The list values");
  auto slotValues = views.read<const double>(runtime, ARGUMENT_SLOT_VALUES, "The slot values");
  request.slots = slots.data;
  request.slot_capacity = slots.length / NARSIL_KEYWORD_SLOT_STRIDE;
  request.lists = lists.data;
  request.list_values = listValues.data;
  request.list_capacity = shorterOf(lists.length / NARSIL_KEYWORD_LIST_STRIDE,
                                    listValues.length / NARSIL_KEYWORD_LIST_VALUE_STRIDE);
  request.slot_values = slotValues.data;
  request.slot_value_capacity = slotValues.length;
}

void readFields(jsi::Runtime& runtime, TypedElements& views, narsil_keyword_request& request) {
  auto searchable = views.read<const uint8_t>(runtime, ARGUMENT_SEARCHABLE, "The searchable fields");
  auto partialMarks = views.read<const uint8_t>(runtime, ARGUMENT_PARTIAL_MARKS, "The partial fields");
  auto nameRanks = views.read<const uint16_t>(runtime, ARGUMENT_NAME_RANKS, "The field name ranks");
  auto numbers = views.read<const double>(runtime, ARGUMENT_FIELD_NUMBERS, "The field numbers");
  uint32_t count = searchable.length;
  if (count > NARSIL_KEYWORD_MAX_FIELDS || partialMarks.length != count || nameRanks.length != count ||
      static_cast<uint64_t>(numbers.length) != static_cast<uint64_t>(count) * NARSIL_KEYWORD_FIELD_NUMBER_COLUMNS) {
    throwInvalid("The field columns of keywordScore disagree on the field count");
  }
  request.field_count = count;
  request.searchable = searchable.data;
  request.partial_marks = partialMarks.data;
  request.name_ranks = nameRanks.data;
  request.field_numbers = numbers.data;
}

std::vector<jsi::Value> lengthValues(jsi::Runtime& runtime, const jsi::Value& value) {
  if (!value.isObject() || !value.getObject(runtime).isArray(runtime)) {
    throwInvalid("The field lengths must be a list");
  }
  jsi::Array list = value.getObject(runtime).getArray(runtime);
  size_t count = list.size(runtime);
  if (count > NARSIL_KEYWORD_MAX_FIELDS) throwInvalid("The field lengths exceed the field limit");
  std::vector<jsi::Value> values;
  values.reserve(count);
  for (size_t field = 0; field < count; field++) values.push_back(list.getValueAtIndex(runtime, field));
  return values;
}

void readLengths(jsi::Runtime& runtime, const std::vector<jsi::Value>& values, TypedElements& views,
                 std::vector<narsil_keyword_column>& columns, uint32_t count) {
  if (values.size() != count) throwInvalid("The field lengths hold one entry per field");
  columns.resize(count);
  for (uint32_t field = 0; field < count; field++) {
    const jsi::Value& column = values[field];
    columns[field] = {nullptr, 0};
    if (column.isNull()) continue;
    auto lengths = views.read<const uint32_t>(runtime, field, "A field length column");
    columns[field] = {lengths.data, lengths.length};
  }
}

void readBitsets(jsi::Runtime& runtime, const jsi::Value* arguments, TypedElements& views, narsil_keyword_request& request) {
  request.has_filter = !arguments[ARGUMENT_FILTER].isNull();
  if (request.has_filter) {
    auto filter = views.read<const uint32_t>(runtime, ARGUMENT_FILTER, "The filter");
    request.filter = filter.data;
    request.filter_words = filter.length;
  }
  auto live = views.read<const uint32_t>(runtime, ARGUMENT_LIVE, "The live ordinals");
  auto removed = views.read<const uint32_t>(runtime, ARGUMENT_REMOVED, "The removed ordinals");
  request.live = live.data;
  request.live_words = live.length;
  request.removed = removed.data;
  request.removed_words = removed.length;
}

void readSettings(jsi::Runtime& runtime, TypedElements& views, narsil_keyword_request& request) {
  auto settings = views.read<const double>(runtime, ARGUMENT_SETTINGS, "The settings");
  if (settings.length < SETTING_COUNT) throwInvalid("The settings of keywordScore are too short");
  const double* values = settings.data;
  request.terms = values[SETTING_TERMS];
  request.total_documents = values[SETTING_TOTAL_DOCUMENTS];
  request.term_match = values[SETTING_TERM_MATCH];
  request.limit = values[SETTING_LIMIT];
  request.min_score = values[SETTING_MIN_SCORE];
  request.collect = values[SETTING_COLLECT] != 0;
  request.slot_count = wholeCount(values[SETTING_SLOTS], "The slot count");
  request.capacity = wholeCount(values[SETTING_CAPACITY], "The capacity");
}

Elements<double> readOutput(jsi::Runtime& runtime, TypedElements& views, narsil_keyword_output& output) {
  auto ordinals = views.read<int32_t>(runtime, ARGUMENT_ORDINALS, "The ordinals");
  auto scores = views.read<double>(runtime, ARGUMENT_SCORES, "The scores");
  auto matched = views.read<uint32_t>(runtime, ARGUMENT_MATCHED, "The matched ordinals");
  auto outcome = views.read<double>(runtime, ARGUMENT_OUTCOME, "The outcome");
  if (outcome.length < OUTCOME_MIN_LENGTH) throwInvalid("The outcome of keywordScore is too short");
  output.ordinals = ordinals.data;
  output.scores = scores.data;
  output.length = shorterOf(ordinals.length, scores.length);
  output.matched = matched.data;
  output.matched_words = matched.length;
  return outcome;
}

}

jsi::Value HybridNarsilCoreImpl::keywordScore(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* arguments,
                                              size_t count) {
  if (count != ARGUMENT_COUNT) throwInvalid("keywordScore takes twenty-three arguments");
  std::vector<jsi::Value> lengths = lengthValues(runtime, arguments[ARGUMENT_LENGTHS]);
  TypedElements views(ARGUMENT_COUNT);
  for (size_t argument = 0; argument < ARGUMENT_COUNT; argument++) {
    if (argument == ARGUMENT_LENGTHS || (argument == ARGUMENT_FILTER && arguments[argument].isNull())) continue;
    views.prepare(runtime, argument, arguments[argument]);
  }
  TypedElements lengthViews(lengths.size());
  for (size_t field = 0; field < lengths.size(); field++) {
    if (!lengths[field].isNull()) lengthViews.prepare(runtime, field, lengths[field]);
  }
  narsil_keyword_request request{};
  narsil_keyword_output output{};
  readRows(runtime, views, request);
  readSlots(runtime, views, request);
  readBitsets(runtime, arguments, views, request);
  readSettings(runtime, views, request);
  Elements<double> outcome = readOutput(runtime, views, output);
  readFields(runtime, views, request);
  RuntimeState& state = stateOf(runtime);
  readLengths(runtime, lengths, lengthViews, state.keywordLengths, request.field_count);
  request.lengths = state.keywordLengths.data();
  auto settings = views.read<const double>(runtime, ARGUMENT_SETTINGS, "The settings");
  if (!keyword_binding_regions_are_disjoint(&request, &output, settings.data, settings.length,
                                           outcome.data, outcome.length)) {
    return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) throwSystemError(ENOMEM, "allocate the keyword workspace", "");
    state.keywordWorkspace.reset(created);
  }
  narsil_status status = narsil_keyword_score(state.keywordWorkspace.get(), &request, &output);
  if (status != NARSIL_OK) return jsi::Value(static_cast<double>(status));
  outcome.data[OUTCOME_COUNT] = static_cast<double>(output.count);
  outcome.data[OUTCOME_TOTAL_MATCHED] = static_cast<double>(output.total_matched);
  if (outcome.length > OUTCOME_SCORING_PATH) {
    outcome.data[OUTCOME_SCORING_PATH] = static_cast<double>(output.scoring_path);
  }
  return jsi::Value(static_cast<double>(status));
}

jsi::Value HybridNarsilCoreImpl::fuse(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* arguments,
                                      size_t count) try {
  const jsi::Value invalid(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  if (count != FUSE_ARGUMENT_COUNT || !arguments[FUSE_STRATEGY].isNumber() ||
      !arguments[FUSE_K].isNumber() || !arguments[FUSE_ALPHA].isNumber()) {
    return jsi::Value(runtime, invalid);
  }
  double strategy = arguments[FUSE_STRATEGY].getNumber();
  if (!std::isfinite(strategy) || strategy < static_cast<double>(NARSIL_FUSION_RRF) ||
      strategy > static_cast<double>(NARSIL_FUSION_LINEAR) || std::floor(strategy) != strategy) {
    return jsi::Value(runtime, invalid);
  }
  TypedElements views(FUSE_ARGUMENT_COUNT);
  for (size_t argument = FUSE_TEXT_KEYS; argument < FUSE_ARGUMENT_COUNT; argument++) {
    views.prepare(runtime, argument, arguments[argument]);
  }
  auto textKeys = views.read<const uint32_t>(runtime, FUSE_TEXT_KEYS, "The text keys");
  auto textScores = views.read<const double>(runtime, FUSE_TEXT_SCORES, "The text scores");
  auto vectorKeys = views.read<const uint32_t>(runtime, FUSE_VECTOR_KEYS, "The vector keys");
  auto vectorScores = views.read<const double>(runtime, FUSE_VECTOR_SCORES, "The vector scores");
  auto ranks = views.read<const uint32_t>(runtime, FUSE_ID_RANKS, "The ID ranks");
  auto keys = views.read<uint32_t>(runtime, FUSE_OUTPUT_KEYS, "The fused keys");
  auto scores = views.read<double>(runtime, FUSE_OUTPUT_SCORES, "The fused scores");
  if (textKeys.length != textScores.length || vectorKeys.length != vectorScores.length) {
    return jsi::Value(runtime, invalid);
  }
  narsil_fusion_request request{};
  request.strategy = static_cast<uint32_t>(strategy);
  request.rank_constant = arguments[FUSE_K].getNumber();
  request.alpha = arguments[FUSE_ALPHA].getNumber();
  request.text = {textKeys.data, textScores.data, textKeys.length};
  request.vector = {vectorKeys.data, vectorScores.data, vectorKeys.length};
  request.id_ranks = ranks.data;
  request.key_count = ranks.length;
  narsil_fusion_output output{keys.data, scores.data, shorterOf(keys.length, scores.length), 0};
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) {
      return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    }
    state.keywordWorkspace.reset(created);
  }
  narsil_status status = narsil_fuse(state.keywordWorkspace.get(), &request, &output);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(output.count) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
