#include "HostMemory.hpp"
#include "HybridNarsilCoreImpl.hpp"

#include <cerrno>
#include <cmath>
#include <cstdint>
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

template <typename Element>
struct Elements {
  Element* data;
  uint32_t length;
};

size_t wholeProperty(jsi::Runtime& runtime, const jsi::Object& array, const char* name, const char* what) {
  jsi::Value value = array.getProperty(runtime, name);
  if (!value.isNumber()) throwInvalid(std::string(what) + " is not a typed array");
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) {
    throwInvalid(std::string(what) + " is not a typed array");
  }
  return static_cast<size_t>(number);
}

template <typename Element>
Elements<Element> elementsOf(jsi::Runtime& runtime, const jsi::Value& value, const char* what) {
  if (!value.isObject()) throwInvalid(std::string(what) + " must be a typed array");
  jsi::Object array = value.getObject(runtime);
  if (wholeProperty(runtime, array, "BYTES_PER_ELEMENT", what) != sizeof(Element)) {
    throwInvalid(std::string(what) + " holds elements of the wrong width");
  }
  jsi::Value bufferValue = array.getProperty(runtime, "buffer");
  if (!bufferValue.isObject()) throwInvalid(std::string(what) + " has no buffer");
  jsi::Object bufferObject = bufferValue.getObject(runtime);
  if (!bufferObject.isArrayBuffer(runtime)) throwInvalid(std::string(what) + " has no buffer");
  jsi::ArrayBuffer buffer = bufferObject.getArrayBuffer(runtime);
  size_t offset = wholeProperty(runtime, array, "byteOffset", what);
  size_t length = wholeProperty(runtime, array, "length", what);
  size_t held = buffer.size(runtime);
  if (offset > held || length > (held - offset) / sizeof(Element)) {
    throwInvalid(std::string(what) + " reaches past the end of its buffer");
  }
  uint8_t* base = buffer.data(runtime);
  if (base == nullptr) {
    if (length > 0) throwInvalid(std::string(what) + " has a detached buffer");
    return {nullptr, 0};
  }
  uint8_t* start = base + offset;
  if (reinterpret_cast<uintptr_t>(start) % alignof(Element) != 0) throwInvalid(std::string(what) + " is misaligned");
  return {reinterpret_cast<Element*>(start), static_cast<uint32_t>(length)};
}

uint32_t wholeCount(double value, const char* what) {
  if (!(value >= 0) || value > UINT32_MAX || std::floor(value) != value) {
    throwInvalid(std::string(what) + " must be a whole number from 0 to 4294967295");
  }
  return static_cast<uint32_t>(value);
}

uint32_t shorterOf(uint32_t first, uint32_t second) { return first < second ? first : second; }

void readRows(jsi::Runtime& runtime, const jsi::Value* arguments, narsil_keyword_request& request) {
  auto poolDocIds = elementsOf<const uint32_t>(runtime, arguments[ARGUMENT_POOL_DOC_IDS], "The pool ordinals");
  auto poolFrequencies =
      elementsOf<const uint16_t>(runtime, arguments[ARGUMENT_POOL_FREQUENCIES], "The pool frequencies");
  auto poolFields = elementsOf<const uint16_t>(runtime, arguments[ARGUMENT_POOL_FIELDS], "The pool fields");
  auto rowDocIds = elementsOf<const uint32_t>(runtime, arguments[ARGUMENT_ROW_DOC_IDS], "The row ordinals");
  auto rowFrequencies = elementsOf<const double>(runtime, arguments[ARGUMENT_ROW_FREQUENCIES], "The row frequencies");
  auto rowFields = elementsOf<const uint16_t>(runtime, arguments[ARGUMENT_ROW_FIELDS], "The row fields");
  request.pool_doc_ids = poolDocIds.data;
  request.pool_frequencies = poolFrequencies.data;
  request.pool_fields = poolFields.data;
  request.pool_length = shorterOf(poolDocIds.length, shorterOf(poolFrequencies.length, poolFields.length));
  request.row_doc_ids = rowDocIds.data;
  request.row_frequencies = rowFrequencies.data;
  request.row_fields = rowFields.data;
  request.row_length = shorterOf(rowDocIds.length, shorterOf(rowFrequencies.length, rowFields.length));
}

void readSlots(jsi::Runtime& runtime, const jsi::Value* arguments, narsil_keyword_request& request) {
  auto slots = elementsOf<const uint32_t>(runtime, arguments[ARGUMENT_SLOTS], "The slots");
  auto lists = elementsOf<const uint32_t>(runtime, arguments[ARGUMENT_LISTS], "The lists");
  auto listValues = elementsOf<const double>(runtime, arguments[ARGUMENT_LIST_VALUES], "The list values");
  auto slotValues = elementsOf<const double>(runtime, arguments[ARGUMENT_SLOT_VALUES], "The slot values");
  request.slots = slots.data;
  request.slot_capacity = slots.length / NARSIL_KEYWORD_SLOT_STRIDE;
  request.lists = lists.data;
  request.list_values = listValues.data;
  request.list_capacity = shorterOf(lists.length / NARSIL_KEYWORD_LIST_STRIDE,
                                    listValues.length / NARSIL_KEYWORD_LIST_VALUE_STRIDE);
  request.slot_values = slotValues.data;
  request.slot_value_capacity = slotValues.length;
}

void readFields(jsi::Runtime& runtime, const jsi::Value* arguments, narsil_keyword_request& request) {
  auto searchable = elementsOf<const uint8_t>(runtime, arguments[ARGUMENT_SEARCHABLE], "The searchable fields");
  auto partialMarks = elementsOf<const uint8_t>(runtime, arguments[ARGUMENT_PARTIAL_MARKS], "The partial fields");
  auto nameRanks = elementsOf<const uint16_t>(runtime, arguments[ARGUMENT_NAME_RANKS], "The field name ranks");
  auto numbers = elementsOf<const double>(runtime, arguments[ARGUMENT_FIELD_NUMBERS], "The field numbers");
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

void readLengths(jsi::Runtime& runtime, const jsi::Value& value, std::vector<narsil_keyword_column>& columns,
                 uint32_t count) {
  if (!value.isObject() || !value.getObject(runtime).isArray(runtime)) {
    throwInvalid("The field lengths must be a list");
  }
  jsi::Array list = value.getObject(runtime).getArray(runtime);
  if (list.size(runtime) != count) throwInvalid("The field lengths hold one entry per field");
  columns.resize(count);
  for (uint32_t field = 0; field < count; field++) {
    jsi::Value column = list.getValueAtIndex(runtime, field);
    columns[field] = {nullptr, 0};
    if (column.isNull()) continue;
    auto lengths = elementsOf<const uint32_t>(runtime, column, "A field length column");
    columns[field] = {lengths.data, lengths.length};
  }
}

void readBitsets(jsi::Runtime& runtime, const jsi::Value* arguments, narsil_keyword_request& request) {
  request.has_filter = !arguments[ARGUMENT_FILTER].isNull();
  if (request.has_filter) {
    auto filter = elementsOf<const uint32_t>(runtime, arguments[ARGUMENT_FILTER], "The filter");
    request.filter = filter.data;
    request.filter_words = filter.length;
  }
  auto live = elementsOf<const uint32_t>(runtime, arguments[ARGUMENT_LIVE], "The live ordinals");
  auto removed = elementsOf<const uint32_t>(runtime, arguments[ARGUMENT_REMOVED], "The removed ordinals");
  request.live = live.data;
  request.live_words = live.length;
  request.removed = removed.data;
  request.removed_words = removed.length;
}

void readSettings(jsi::Runtime& runtime, const jsi::Value* arguments, narsil_keyword_request& request) {
  auto settings = elementsOf<const double>(runtime, arguments[ARGUMENT_SETTINGS], "The settings");
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

Elements<double> readOutput(jsi::Runtime& runtime, const jsi::Value* arguments, narsil_keyword_output& output) {
  auto ordinals = elementsOf<int32_t>(runtime, arguments[ARGUMENT_ORDINALS], "The ordinals");
  auto scores = elementsOf<double>(runtime, arguments[ARGUMENT_SCORES], "The scores");
  auto matched = elementsOf<uint32_t>(runtime, arguments[ARGUMENT_MATCHED], "The matched ordinals");
  auto outcome = elementsOf<double>(runtime, arguments[ARGUMENT_OUTCOME], "The outcome");
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
  narsil_keyword_request request{};
  narsil_keyword_output output{};
  readRows(runtime, arguments, request);
  readSlots(runtime, arguments, request);
  readBitsets(runtime, arguments, request);
  readSettings(runtime, arguments, request);
  Elements<double> outcome = readOutput(runtime, arguments, output);
  readFields(runtime, arguments, request);
  RuntimeState& state = stateOf(runtime);
  readLengths(runtime, arguments[ARGUMENT_LENGTHS], state.keywordLengths, request.field_count);
  request.lengths = state.keywordLengths.data();
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) throwSystemError(ENOMEM, "allocate the keyword workspace", "");
    state.keywordWorkspace.reset(created);
  }
  narsil_status status = narsil_keyword_score(state.keywordWorkspace.get(), &request, &output);
  outcome.data[OUTCOME_COUNT] = static_cast<double>(output.count);
  outcome.data[OUTCOME_TOTAL_MATCHED] = static_cast<double>(output.total_matched);
  if (outcome.length > OUTCOME_SCORING_PATH) {
    outcome.data[OUTCOME_SCORING_PATH] = static_cast<double>(output.scoring_path);
  }
  return jsi::Value(static_cast<double>(status));
}

}
