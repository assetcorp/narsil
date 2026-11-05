#include "HostMemory.hpp"
#include "HybridNarsilCoreImpl.hpp"

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

enum TransformArgument : size_t { TRANSFORM_LANGUAGE, TRANSFORM_FLAGS, TRANSFORM_TEXT, TRANSFORM_ARGUMENT_COUNT };

enum TokenRecord : size_t {
  RECORD_POSITION,
  RECORD_TERM_OFFSET,
  RECORD_TERM_LENGTH,
  RECORD_SURFACE_OFFSET,
  RECORD_SURFACE_LENGTH,
  RECORD_ORIGINAL_OFFSET,
  RECORD_ORIGINAL_LENGTH,
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
    record += TOKEN_RECORD_WORDS;
  }
  return true;
}

jsi::Value statusValue(narsil_status status) { return jsi::Value(-static_cast<double>(status)); }

}

void HybridNarsilCoreImpl::loadHybridMethods() {
  HybridNarsilCoreSpec::loadHybridMethods();
  registerHybrids(this, [](Prototype& prototype) {
    prototype.registerRawHybridMethod("languageCount", 0, &HybridNarsilCoreImpl::languageCount);
    prototype.registerRawHybridMethod("languageName", 1, &HybridNarsilCoreImpl::languageName);
    prototype.registerRawHybridMethod("languageRevision", 1, &HybridNarsilCoreImpl::languageRevision);
    prototype.registerRawHybridMethod("languageStopWords", 1, &HybridNarsilCoreImpl::languageStopWords);
    prototype.registerRawHybridMethod("createStopWordSet", 1, &HybridNarsilCoreImpl::createStopWordSet);
    prototype.registerRawHybridMethod("analyse", ANALYSE_ARGUMENT_COUNT, &HybridNarsilCoreImpl::analyse);
    prototype.registerRawHybridMethod("transform", TRANSFORM_ARGUMENT_COUNT, &HybridNarsilCoreImpl::transform);
  });
}

narsil_analyser* HybridNarsilCoreImpl::analyser() {
  if (_analyser == nullptr) {
    narsil_analyser* created = nullptr;
    if (narsil_analyser_create(&created) != NARSIL_OK) return nullptr;
    _analyser.reset(created);
  }
  return _analyser.get();
}

void HybridNarsilCoreImpl::readText(jsi::Runtime& runtime, const jsi::Value& value, const char* what) {
  if (!value.isString()) throwInvalid(std::string(what) + " must be a string");
  _textUnits.clear();
  appendUnits(runtime, value.getString(runtime), _textUnits, NARSIL_MAX_ANALYSED_UNITS);
}

jsi::Value HybridNarsilCoreImpl::textOf(jsi::Runtime& runtime, const uint16_t* units, size_t length) {
  _textOut.resize(length);
  if (length > 0) std::memcpy(_textOut.data(), units, length * sizeof(uint16_t));
  return jsi::String::createFromUtf16(runtime, _textOut);
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
  jsi::Array words(runtime, list.count);
  for (uint32_t index = 0; index < list.count; index++) {
    uint32_t start = list.offsets[index];
    words.setValueAtIndex(runtime, index, textOf(runtime, list.units + start, list.offsets[index + 1] - start));
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
  size_t capacity = 0;
  uint32_t* records = recordsArgument(runtime, arguments, count, &capacity);
  readText(runtime, arguments[ANALYSE_TEXT], "The text");
  narsil_analyser* active = analyser();
  if (active == nullptr) return statusValue(NARSIL_OUT_OF_MEMORY);
  request.text = _textUnits.empty() ? NO_UNITS : _textUnits.data();
  request.length = static_cast<uint32_t>(_textUnits.size());
  narsil_tokens tokens = {nullptr, 0, nullptr, 0};
  narsil_status status = narsil_analyse(active, &request, &tokens);
  if (status != NARSIL_OK) return statusValue(status);
  if (!writeRecords(tokens, records, capacity)) return jsi::Value::null();
  return textOf(runtime, tokens.units, tokens.unit_count);
}

jsi::Value HybridNarsilCoreImpl::transform(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* arguments,
                                           size_t count) {
  narsil_analysis_request request = {0, nullptr, 0, nullptr, 0};
  request.language = languageArgument(arguments, count, TRANSFORM_LANGUAGE);
  request.flags = wholeArgument(arguments, count, TRANSFORM_FLAGS, "The transform flags");
  if (count < TRANSFORM_ARGUMENT_COUNT) throwInvalid("transform takes three arguments");
  readText(runtime, arguments[TRANSFORM_TEXT], "The token");
  narsil_analyser* active = analyser();
  if (active == nullptr) return statusValue(NARSIL_OUT_OF_MEMORY);
  request.text = _textUnits.empty() ? NO_UNITS : _textUnits.data();
  request.length = static_cast<uint32_t>(_textUnits.size());
  narsil_term term = {nullptr, 0};
  narsil_status status = narsil_transform(active, &request, &term);
  if (status != NARSIL_OK) return statusValue(status);
  return textOf(runtime, term.units, term.length);
}

}
