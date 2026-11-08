#include "FrozenSegmentRegions.hpp"
#include "HybridNarsilCoreImpl.hpp"

#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::removeFrozenDocument(jsi::Runtime& runtime, const jsi::Value&,
                                                    const jsi::Value* arguments, size_t count) {
  return frozenDocument(runtime, arguments, count, false);
}

jsi::Value HybridNarsilCoreImpl::prepareFrozenRemoval(jsi::Runtime& runtime, const jsi::Value&,
                                                    const jsi::Value* arguments, size_t count) {
  return frozenDocument(runtime, arguments, count, true);
}

jsi::Value HybridNarsilCoreImpl::frozenDocument(jsi::Runtime& runtime, const jsi::Value* arguments,
                                              size_t count, bool preparing) try {
  auto refusal = [preparing](narsil_status status) {
    return jsi::Value((preparing ? -1 : 1) * static_cast<double>(status));
  };
  if (count != (preparing ? PREPARE_FROZEN_ARGUMENT_COUNT : REMOVE_FROZEN_ARGUMENT_COUNT)) return refusal(NARSIL_INVALID_ARGUMENT);
  uint32_t ordinal = segmentUnsigned(arguments[2]);
  if (!arguments[3].isObject() || !arguments[3].getObject(runtime).isArray(runtime)) {
    return refusal(NARSIL_INVALID_ARGUMENT);
  }
  auto input = arguments[3].getObject(runtime).getArray(runtime);
  size_t fieldCount = input.size(runtime);
  if (fieldCount > static_cast<size_t>(UINT16_MAX) + 1) return refusal(NARSIL_INVALID_ARGUMENT);
  FrozenSegmentRegions regions;
  regions.prepare(runtime, arguments[0], arguments[1]);
  TypedElements fieldViews(fieldCount * 2);
  std::vector<narsil_field_tokens> fields(fieldCount);
  for (size_t index = 0; index < fieldCount; index++) {
    auto value = input.getValueAtIndex(runtime, index);
    if (!value.isObject()) return refusal(NARSIL_INVALID_ARGUMENT);
    auto field = value.getObject(runtime);
    uint32_t fieldOrdinal = segmentUnsigned(field.getProperty(runtime, "field"));
    if (fieldOrdinal > UINT16_MAX) return refusal(NARSIL_INVALID_ARGUMENT);
    fields[index].field = static_cast<uint16_t>(fieldOrdinal);
    fieldViews.prepare(runtime, index * 2, field.getProperty(runtime, "tokens"));
    fieldViews.prepare(runtime, index * 2 + 1, field.getProperty(runtime, "units"));
  }
  TypedElements outputs(2);
  if (preparing) {
    outputs.prepare(runtime, 0, arguments[4]);
    outputs.prepare(runtime, 1, arguments[5]);
  }
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return refusal(NARSIL_OUT_OF_MEMORY);
    state.keywordWorkspace.reset(created);
  }
  auto segment = regions.read(runtime);
  auto output = regions.readState(runtime, segment.terms.count);
  constexpr size_t TOKEN_WORDS = sizeof(narsil_token) / sizeof(uint32_t);
  for (size_t index = 0; index < fieldCount; index++) {
    auto tokens = fieldViews.read<const uint32_t>(runtime, index * 2, "The field tokens");
    auto units = fieldViews.read<const uint16_t>(runtime, index * 2 + 1, "The field units");
    if (tokens.length % TOKEN_WORDS != 0) return refusal(NARSIL_INVALID_ARGUMENT);
    fields[index].tokens = {reinterpret_cast<const narsil_token*>(tokens.data),
                           static_cast<uint32_t>(tokens.length / TOKEN_WORDS), units.data, units.length};
  }
  narsil_remove_frozen_request request{&segment, &output, ordinal, fields.data(), fieldCount};
  if (preparing) {
    auto entries = outputs.read<uint32_t>(runtime, 0, "The removal entries");
    auto values = outputs.read<double>(runtime, 1, "The removal values");
    if (entries.length % 2 != 0) return refusal(NARSIL_INVALID_ARGUMENT);
    narsil_frozen_removal_output target{entries.data, values.data, entries.length / 2, values.length};
    size_t written = 0;
    narsil_status status = narsil_prepare_frozen_removal(state.keywordWorkspace.get(), &request, &target, &written);
    return status == NARSIL_OK ? jsi::Value(static_cast<double>(written)) : refusal(status);
  }
  return jsi::Value(static_cast<double>(narsil_remove_frozen_document(state.keywordWorkspace.get(), &request)));
} catch (const std::invalid_argument&) {
  return jsi::Value((preparing ? -1 : 1) * static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value((preparing ? -1 : 1) * static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value((preparing ? -1 : 1) * static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
