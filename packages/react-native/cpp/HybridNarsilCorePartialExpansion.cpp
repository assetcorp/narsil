#include "ExpansionInput.hpp"
#include "HybridNarsilCoreImpl.hpp"
#include "narsil_expansion.h"

#include <cmath>
#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {
namespace {

class PartialInput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The partial-word source must be an object");
    auto object = value.getObject(runtime);
    auto segment = object.getProperty(runtime, "segment");
    auto runs = object.getProperty(runtime, "runs");
    _source.prepare(runtime, segment);
    _hasRuns = !runs.isNull();
    if (_hasRuns) {
      if (!runs.isObject()) throwInvalid("The partial-word runs must be an object");
      auto table = runs.getObject(runtime);
      _runs.prepare(runtime, 0, table.getProperty(runtime, "runs"));
      _runs.prepare(runtime, 1, table.getProperty(runtime, "offsets"));
      _runs.prepare(runtime, 2, table.getProperty(runtime, "members"));
    }
  }

  narsil_expansion_segment read(jsi::Runtime& runtime, narsil_frozen_runs& runs) {
    auto source = _source.read(runtime);
    if (_hasRuns) {
      if (source.growing != nullptr) throwInvalid("A growing source cannot hold frozen runs");
      auto points = _runs.read<const uint32_t>(runtime, 0, "The partial-word runs");
      auto offsets = _runs.read<const uint32_t>(runtime, 1, "The partial-word offsets");
      auto members = _runs.read<const uint32_t>(runtime, 2, "The partial-word members");
      runs = {points.data, points.length, offsets.data, offsets.length, members.data, members.length};
    }
    return source;
  }

private:
  ExpansionInput _source;
  TypedElements _runs{3};
  bool _hasRuns = false;
};

class PartialWord {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The partial-word request must be an object");
    auto object = value.getObject(runtime);
    _text.prepare(runtime, 0, object.getProperty(runtime, "written"));
    _text.prepare(runtime, 1, object.getProperty(runtime, "own"));
    _tolerance = whole(object.getProperty(runtime, "tolerance"));
    _prefixLength = whole(object.getProperty(runtime, "prefixLength"));
  }

  narsil_partial_word read(jsi::Runtime& runtime) {
    auto written = _text.read<const uint16_t>(runtime, 0, "The partial-word text");
    auto own = _text.read<const uint16_t>(runtime, 1, "The query token");
    return {written.data, written.length, own.data, own.length, _tolerance, _prefixLength};
  }

private:
  static uint32_t whole(const jsi::Value& value) {
    if (!value.isNumber()) throwInvalid("The partial-word option must be a number");
    double number = value.getNumber();
    if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) {
      throwInvalid("The partial-word option must be a uint32");
    }
    return static_cast<uint32_t>(number);
  }

  TypedElements _text{2};
  uint32_t _tolerance = 0;
  uint32_t _prefixLength = 0;
};

jsi::Array arrayOf(jsi::Runtime& runtime, const jsi::Value& value) {
  if (!value.isObject() || !value.getObject(runtime).isArray(runtime)) {
    throwInvalid("The partial-word input must be an array");
  }
  auto array = value.getObject(runtime).getArray(runtime);
  if (array.size(runtime) > UINT32_MAX) throwInvalid("The partial-word input has too many entries");
  return array;
}

}

jsi::Value HybridNarsilCoreImpl::expandPartialWords(jsi::Runtime& runtime, const jsi::Value&,
                                                   const jsi::Value* arguments, size_t count) try {
  if (count != EXPAND_PARTIAL_ARGUMENT_COUNT) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto sourceArray = arrayOf(runtime, arguments[0]);
  auto wordArray = arrayOf(runtime, arguments[1]);
  size_t sourceCount = sourceArray.size(runtime);
  size_t wordCount = wordArray.size(runtime);
  std::vector<PartialInput> inputs(sourceCount);
  std::vector<PartialWord> queries(wordCount);
  std::vector<narsil_expansion_segment> sources(sourceCount);
  std::vector<narsil_frozen_runs> runs(sourceCount);
  std::vector<narsil_partial_word> words(wordCount);
  for (size_t at = 0; at < sourceCount; at++) inputs[at].prepare(runtime, sourceArray.getValueAtIndex(runtime, at));
  for (size_t at = 0; at < wordCount; at++) queries[at].prepare(runtime, wordArray.getValueAtIndex(runtime, at));
  TypedElements regions(EXPAND_PARTIAL_ARGUMENT_COUNT - 2);
  for (size_t at = 2; at < count; at++) regions.prepare(runtime, at - 2, arguments[at]);
  auto& held = stateOf(runtime);
  if (held.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    narsil_status status = narsil_workspace_create(&created);
    if (status != NARSIL_OK) return jsi::Value(-static_cast<double>(status));
    held.keywordWorkspace.reset(created);
  }
  for (size_t at = 0; at < sourceCount; at++) sources[at] = inputs[at].read(runtime, runs[at]);
  for (size_t at = 0; at < wordCount; at++) words[at] = queries[at].read(runtime);
  auto starts = regions.read<uint32_t>(runtime, 0, "The addition offsets");
  auto segments = regions.read<uint32_t>(runtime, 1, "The addition sources");
  auto tokens = regions.read<uint32_t>(runtime, 2, "The addition tokens");
  auto factors = regions.read<double>(runtime, 3, "The addition factors");
  narsil_partial_request request{sources.data(), runs.data(), sourceCount, words.data(), wordCount};
  narsil_partial_output output{{segments.data, segments.length, tokens.data, tokens.length,
    factors.data, factors.length}, starts.data, starts.length};
  uint32_t written = 0;
  narsil_status status = narsil_expand_partial_words(held.keywordWorkspace.get(), &request, &output, &written);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(written) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}
}
