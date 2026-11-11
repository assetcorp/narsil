#include "ExpansionInput.hpp"
#include "HybridNarsilCoreImpl.hpp"
#include "narsil_expansion.h"

#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::expandPrefix(jsi::Runtime& runtime, const jsi::Value&,
                                             const jsi::Value* arguments, size_t count) try {
  if (count != EXPAND_PREFIX_ARGUMENT_COUNT || !arguments[0].isObject() ||
      !arguments[0].getObject(runtime).isArray(runtime)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  auto array = arguments[0].getObject(runtime).getArray(runtime);
  size_t length = array.size(runtime);
  if (length > UINT32_MAX) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  std::vector<ExpansionInput> inputs(length);
  std::vector<narsil_expansion_segment> sources(length);
  for (size_t at = 0; at < length; at++) inputs[at].prepare(runtime, array.getValueAtIndex(runtime, at));
  TypedElements regions(EXPAND_PREFIX_ARGUMENT_COUNT - 1);
  for (size_t at = 1; at < count; at++) regions.prepare(runtime, at - 1, arguments[at]);
  auto& held = stateOf(runtime);
  if (held.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    narsil_status status = narsil_workspace_create(&created);
    if (status != NARSIL_OK) return jsi::Value(-static_cast<double>(status));
    held.keywordWorkspace.reset(created);
  }
  for (size_t at = 0; at < length; at++) sources[at] = inputs[at].read(runtime);
  auto typed = regions.read<const uint16_t>(runtime, 0, "The prefix text");
  auto stemmed = regions.read<const uint16_t>(runtime, 1, "The stemmed prefix");
  auto own = regions.read<const uint16_t>(runtime, 2, "The query token");
  auto segments = regions.read<uint32_t>(runtime, 3, "The completion sources");
  auto tokens = regions.read<uint32_t>(runtime, 4, "The completion tokens");
  auto factors = regions.read<double>(runtime, 5, "The completion factors");
  narsil_prefix_request request{sources.data(), sources.size(), typed.data, typed.length,
    stemmed.data, stemmed.length, own.data, own.length};
  narsil_expansion_output output{segments.data, segments.length, tokens.data, tokens.length,
    factors.data, factors.length};
  uint32_t written = 0;
  narsil_status status = narsil_expand_prefix(held.keywordWorkspace.get(), &request, &output, &written);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(written) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}
}
