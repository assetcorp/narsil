#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_facets.h"

#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::numberFacet(jsi::Runtime& runtime, const jsi::Value&,
                                           const jsi::Value* arguments, size_t count) {
  return numericFacet(runtime, arguments, count, false);
}

jsi::Value HybridNarsilCoreImpl::rangeFacet(jsi::Runtime& runtime, const jsi::Value&,
                                          const jsi::Value* arguments, size_t count) {
  return numericFacet(runtime, arguments, count, true);
}

jsi::Value HybridNarsilCoreImpl::numericFacet(jsi::Runtime& runtime, const jsi::Value* arguments,
                                            size_t count, bool ranges) try {
  if (count != NUMERIC_FACET_ARGUMENT_COUNT) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  TypedElements views(count);
  for (size_t index = 0; index < count; index++) views.prepare(runtime, index, arguments[index]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  auto values = views.read<const double>(runtime, 0, "The numeric values");
  auto ordinals = views.read<const uint32_t>(runtime, 1, "The numeric ordinals");
  auto matched = views.read<const uint32_t>(runtime, 2, "The matched ordinals");
  auto fourth = views.read<double>(runtime, 3, "The facet values or ranges");
  auto counts = views.read<uint32_t>(runtime, 4, "The facet counts");
  narsil_numeric_facet_input input{values.data, values.length, ordinals.data, ordinals.length, matched.data, matched.length};
  if (ranges) {
    return jsi::Value(-static_cast<double>(narsil_range_facet(state.keywordWorkspace.get(), &input, fourth.data,
                                                              fourth.length, counts.data, counts.length)));
  }
  narsil_number_facet_output output{fourth.data, fourth.length, counts.data, counts.length};
  uint32_t buckets = 0;
  narsil_status status = narsil_number_facet(state.keywordWorkspace.get(), &input, &output, &buckets);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(buckets) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
