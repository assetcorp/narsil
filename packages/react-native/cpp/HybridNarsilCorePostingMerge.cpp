#include "HybridNarsilCoreImpl.hpp"
#include "KeywordMergeInput.hpp"
#include "narsil_posting_merge.h"

#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::mergePostings(jsi::Runtime& runtime, const jsi::Value&,
                                             const jsi::Value* arguments, size_t count) try {
  if (count != 4 || !arguments[0].isObject() || !arguments[0].getObject(runtime).isArray(runtime)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  uint32_t documents = segmentUnsigned(arguments[1]);
  uint32_t fields = segmentUnsigned(arguments[2]);
  if (fields > static_cast<size_t>(UINT16_MAX) + 1) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto list = arguments[0].getObject(runtime).getArray(runtime);
  size_t length = list.size(runtime);
  if (length > UINT32_MAX) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  std::vector<KeywordMergeInput> regions(length);
  std::vector<narsil_keyword_merge_input> inputs(length);
  for (size_t at = 0; at < length; at++) regions[at].prepare(runtime, list.getValueAtIndex(runtime, at));
  SegmentViews<6> target;
  target.prepare(runtime, arguments[3], {"documents", "frequencies", "fields", "positionOffsets", "positions", "totals"});
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  for (size_t at = 0; at < length; at++) inputs[at] = regions[at].read(runtime);
  auto ordinals = target.read<uint32_t>(runtime, 0);
  auto frequencies = target.read<uint16_t>(runtime, 1, ordinals.length);
  auto fieldValues = target.read<uint16_t>(runtime, 2, ordinals.length);
  auto offsets = target.read<uint32_t>(runtime, 3);
  auto positions = target.read<uint32_t>(runtime, 4);
  auto totals = target.read<double>(runtime, 5);
  narsil_posting_merge_output output{ordinals.data, frequencies.data, fieldValues.data, ordinals.length,
                                      offsets.data, offsets.length, positions.data, positions.length, totals.data, totals.length};
  narsil_keyword_merge_request request{inputs.data(), inputs.size(), documents, fields, nullptr};
  uint32_t written = 0;
  auto status = narsil_merge_postings(state.keywordWorkspace.get(), &request, &output, &written);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(written) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
