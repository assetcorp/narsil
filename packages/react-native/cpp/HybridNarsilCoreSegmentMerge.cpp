#include "HybridNarsilCoreImpl.hpp"
#include "KeywordMergeInput.hpp"
#include "KeywordMergeOutput.hpp"

#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::measureMerge(jsi::Runtime& runtime, const jsi::Value&,
                                             const jsi::Value* arguments, size_t count) {
  return keywordMerge(runtime, arguments, count, false);
}

jsi::Value HybridNarsilCoreImpl::writeMerge(jsi::Runtime& runtime, const jsi::Value&,
                                           const jsi::Value* arguments, size_t count) {
  return keywordMerge(runtime, arguments, count, true);
}

jsi::Value HybridNarsilCoreImpl::keywordMerge(jsi::Runtime& runtime, const jsi::Value* arguments,
                                             size_t count, bool writing) try {
  constexpr size_t ARGUMENTS = 4;
  constexpr size_t SIZE_WORDS = 9;
  if ((count != ARGUMENTS && count != ARGUMENTS + 1) || !arguments[0].isObject() || !arguments[0].getObject(runtime).isArray(runtime)) {
    return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  uint32_t documents = segmentUnsigned(arguments[1]);
  uint32_t fields = segmentUnsigned(arguments[2]);
  if (fields > static_cast<size_t>(UINT16_MAX) + 1) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto list = arguments[0].getObject(runtime).getArray(runtime);
  size_t length = list.size(runtime);
  if (length > UINT32_MAX) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  std::vector<KeywordMergeInput> regions(length);
  std::vector<narsil_keyword_merge_input> inputs(length);
  for (size_t at = 0; at < length; at++) regions[at].prepare(runtime, list.getValueAtIndex(runtime, at));
  KeywordMergeOutput outputRegions;
  TypedElements sizes(1);
  if (writing) outputRegions.prepare(runtime, arguments[3]);
  else sizes.prepare(runtime, 0, arguments[3]);
  FrozenStringRegions retained;
  bool hasRetained = count > ARGUMENTS && !arguments[ARGUMENTS].isNull() && !arguments[ARGUMENTS].isUndefined();
  if (hasRetained) retained.prepare(runtime, arguments[ARGUMENTS]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  for (size_t at = 0; at < length; at++) inputs[at] = regions[at].read(runtime);
  narsil_frozen_strings retainedTerms{};
  if (hasRetained) retainedTerms = retained.read(runtime, 1);
  narsil_keyword_merge_request request{inputs.data(), inputs.size(), documents, fields, hasRetained ? &retainedTerms : nullptr};
  if (writing) {
    auto output = outputRegions.read(runtime);
    return jsi::Value(static_cast<double>(narsil_write_merge(state.keywordWorkspace.get(), &request, &output)));
  }
  auto output = sizes.read<uint32_t>(runtime, 0, "The merge sizes");
  if (output.length != SIZE_WORDS) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  static_assert(sizeof(narsil_keyword_merge_sizes) == SIZE_WORDS * sizeof(uint32_t));
  auto target = reinterpret_cast<narsil_keyword_merge_sizes*>(output.data);
  return jsi::Value(static_cast<double>(narsil_measure_merge(state.keywordWorkspace.get(), &request, target)));
} catch (const std::invalid_argument&) {
  return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
