#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_facets.h"

#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::booleanFacet(jsi::Runtime& runtime, const jsi::Value&,
                                             const jsi::Value* arguments, size_t count) try {
  if (count != BOOLEAN_FACET_ARGUMENT_COUNT) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  TypedElements views(count);
  for (size_t index = 0; index < count; index++) views.prepare(runtime, index, arguments[index]);
  auto trueBits = views.read<const uint32_t>(runtime, 0, "The true ordinals");
  auto falseBits = views.read<const uint32_t>(runtime, 1, "The false ordinals");
  auto matched = views.read<const uint32_t>(runtime, 2, "The matched ordinals");
  auto counts = views.read<uint32_t>(runtime, 3, "The boolean counts");
  narsil_boolean_index index{trueBits.data, trueBits.length, falseBits.data, falseBits.length};
  return jsi::Value(-static_cast<double>(narsil_boolean_facet(&index, matched.data, matched.length, counts.data, counts.length)));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}


jsi::Value HybridNarsilCoreImpl::enumFacet(jsi::Runtime& runtime, const jsi::Value&,
                                          const jsi::Value* arguments, size_t count) try {
  if (count != ENUM_FACET_ARGUMENT_COUNT) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  TypedElements views(count);
  for (size_t index = 0; index < count; index++) views.prepare(runtime, index, arguments[index]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  auto offsets = views.read<const uint32_t>(runtime, 0, "The posting offsets");
  auto postings = views.read<const uint32_t>(runtime, 1, "The postings");
  auto matched = views.read<const uint32_t>(runtime, 2, "The matched ordinals");
  auto counts = views.read<uint32_t>(runtime, 3, "The enum counts");
  return jsi::Value(-static_cast<double>(narsil_enum_facet(state.keywordWorkspace.get(), offsets.data,
      offsets.length, postings.data, postings.length, matched.data, matched.length, counts.data, counts.length)));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
