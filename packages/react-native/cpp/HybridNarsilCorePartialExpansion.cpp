#include "HybridNarsilCoreImpl.hpp"
#include "PartialInput.hpp"
#include "narsil_expansion.h"

#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {
namespace {

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
