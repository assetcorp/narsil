#include "HybridNarsilCoreImpl.hpp"
#include "SegmentRegions.hpp"
#include "narsil_segments.h"

#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::beginBatch(jsi::Runtime& runtime, const jsi::Value&,
                                          const jsi::Value* arguments, size_t count) {
  return keywordBatch(runtime, arguments, count, false);
}

jsi::Value HybridNarsilCoreImpl::endBatch(jsi::Runtime& runtime, const jsi::Value&,
                                        const jsi::Value* arguments, size_t count) {
  return keywordBatch(runtime, arguments, count, true);
}

jsi::Value HybridNarsilCoreImpl::keywordBatch(jsi::Runtime& runtime, const jsi::Value* arguments,
                                            size_t count, bool ending) try {
  if (count != 1) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  SegmentRegions regions;
  regions.prepare(runtime, arguments[0]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  auto segment = regions.read(runtime);
  narsil_status status = ending ? narsil_end_batch(state.keywordWorkspace.get(), &segment)
                               : narsil_begin_batch(state.keywordWorkspace.get(), &segment);
  return jsi::Value(static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::indexTerms(jsi::Runtime& runtime, const jsi::Value&,
                                          const jsi::Value* arguments, size_t count) {
  return mutateDocument(runtime, arguments, count, false);
}

jsi::Value HybridNarsilCoreImpl::removeDocument(jsi::Runtime& runtime, const jsi::Value&,
                                              const jsi::Value* arguments, size_t count) {
  return mutateDocument(runtime, arguments, count, true);
}

jsi::Value HybridNarsilCoreImpl::mutateDocument(jsi::Runtime& runtime, const jsi::Value* arguments,
                                              size_t count, bool removing) try {
  if (count != INDEX_TERMS_ARGUMENT_COUNT) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  uint32_t ordinal = segmentUnsigned(arguments[1]);
  if (!arguments[2].isObject() || !arguments[2].getObject(runtime).isArray(runtime)) {
    return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  auto input = arguments[2].getObject(runtime).getArray(runtime);
  size_t fieldCount = input.size(runtime);
  if (fieldCount > static_cast<size_t>(UINT16_MAX) + 1) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  SegmentRegions regions;
  regions.prepare(runtime, arguments[0]);
  TypedElements fieldViews(fieldCount * 2);
  std::vector<narsil_field_tokens> fields(fieldCount);
  for (size_t index = 0; index < fieldCount; index++) {
    auto value = input.getValueAtIndex(runtime, index);
    if (!value.isObject()) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
    auto field = value.getObject(runtime);
    uint32_t fieldOrdinal = segmentUnsigned(field.getProperty(runtime, "field"));
    if (fieldOrdinal > UINT16_MAX) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
    fields[index].field = static_cast<uint16_t>(fieldOrdinal);
    fieldViews.prepare(runtime, index * 2, field.getProperty(runtime, "tokens"));
    fieldViews.prepare(runtime, index * 2 + 1, field.getProperty(runtime, "units"));
  }
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  auto segment = regions.read(runtime);
  constexpr size_t TOKEN_WORDS = sizeof(narsil_token) / sizeof(uint32_t);
  for (size_t index = 0; index < fieldCount; index++) {
    auto tokens = fieldViews.read<const uint32_t>(runtime, index * 2, "The field tokens");
    auto units = fieldViews.read<const uint16_t>(runtime, index * 2 + 1, "The field units");
    if (tokens.length % TOKEN_WORDS != 0) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
    fields[index].tokens = {reinterpret_cast<const narsil_token*>(tokens.data),
                           static_cast<uint32_t>(tokens.length / TOKEN_WORDS), units.data, units.length};
  }
  narsil_index_terms_request request{&segment, ordinal, fields.data(), fieldCount};
  narsil_status status = removing ? narsil_remove_document(state.keywordWorkspace.get(), &request)
                                 : narsil_index_terms(state.keywordWorkspace.get(), &request);
  return jsi::Value(static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
