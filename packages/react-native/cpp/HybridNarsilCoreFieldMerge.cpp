#include "HybridNarsilCoreImpl.hpp"
#include "SegmentRegions.hpp"
#include "TypedElements.hpp"
#include "narsil_field_merge.h"

#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {
namespace {

size_t fieldRegionCount(uint32_t kind) {
  constexpr size_t counts[] = {0, 2, 2, 5, 4, 8, 4};
  if (kind == 0 || kind >= sizeof counts / sizeof counts[0]) throwInvalid("The field merge kind is invalid");
  return counts[kind];
}

void prepareFieldRegions(jsi::Runtime& runtime, TypedElements& held, size_t first, const jsi::Value& value,
                         size_t count) {
  if (!value.isObject() || !value.getObject(runtime).isArray(runtime)) throwInvalid("The field regions must be an array");
  auto array = value.getObject(runtime).getArray(runtime);
  if (array.size(runtime) != count) throwInvalid("The field region count does not match its kind");
  for (size_t at = 0; at < count; at++) held.prepare(runtime, first + at, array.getValueAtIndex(runtime, at));
}

template <typename Element>
narsil_field_merge_target readFieldRegion(jsi::Runtime& runtime, TypedElements& held, size_t at) {
  auto region = held.read<Element>(runtime, at, "The field merge region");
  return {region.data, region.length};
}

narsil_field_merge_target readFieldRegion(jsi::Runtime& runtime, TypedElements& held, size_t first, size_t at,
                                         uint32_t kind) {
  size_t index = first + at;
  if (kind == NARSIL_MERGE_NUMERIC && at == 0) return readFieldRegion<double>(runtime, held, index);
  if (kind == NARSIL_MERGE_ENUM && at == 0) return readFieldRegion<uint16_t>(runtime, held, index);
  if (kind == NARSIL_MERGE_GEO) {
    if (at == 0) return readFieldRegion<uint64_t>(runtime, held, index);
    if (at == 1 || at == 2) return readFieldRegion<double>(runtime, held, index);
  }
  if (kind == NARSIL_MERGE_STORED) {
    if (at == 0 || at == 2 || at == 7) return readFieldRegion<uint8_t>(runtime, held, index);
    if (at == 3) return readFieldRegion<double>(runtime, held, index);
    if (at == 6) return readFieldRegion<uint16_t>(runtime, held, index);
  }
  return readFieldRegion<uint32_t>(runtime, held, index);
}

}

jsi::Value HybridNarsilCoreImpl::measureFieldMerge(jsi::Runtime& runtime, const jsi::Value&,
                                                  const jsi::Value* arguments, size_t count) {
  return fieldMerge(runtime, arguments, count, false);
}

jsi::Value HybridNarsilCoreImpl::writeFieldMerge(jsi::Runtime& runtime, const jsi::Value&,
                                                const jsi::Value* arguments, size_t count) {
  return fieldMerge(runtime, arguments, count, true);
}

jsi::Value HybridNarsilCoreImpl::fieldMerge(jsi::Runtime& runtime, const jsi::Value* arguments,
                                           size_t count, bool writing) try {
  if (count != 4 || !arguments[1].isObject() || !arguments[1].getObject(runtime).isArray(runtime)) {
    return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  uint32_t kind = segmentUnsigned(arguments[0]);
  size_t regions = fieldRegionCount(kind);
  uint32_t documents = segmentUnsigned(arguments[2]);
  auto array = arguments[1].getObject(runtime).getArray(runtime);
  size_t length = array.size(runtime);
  if (length > UINT32_MAX || length > SIZE_MAX / (regions + 1)) {
    return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  std::vector<narsil_field_merge_source> sources(length);
  TypedElements inputs(length * (regions + 1));
  TypedElements outputs(writing ? regions : 1);
  for (size_t at = 0; at < length; at++) {
    auto value = array.getValueAtIndex(runtime, at);
    if (!value.isObject()) throwInvalid("A field merge source must be an object");
    auto object = value.getObject(runtime);
    size_t first = at * (regions + 1);
    inputs.prepare(runtime, first, object.getProperty(runtime, "mapping"));
    prepareFieldRegions(runtime, inputs, first + 1, object.getProperty(runtime, "regions"), regions);
  }
  if (writing) prepareFieldRegions(runtime, outputs, 0, arguments[3], regions);
  else outputs.prepare(runtime, 0, arguments[3]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  for (size_t at = 0; at < length; at++) {
    size_t first = at * (regions + 1);
    auto mapping = inputs.read<uint32_t>(runtime, first, "The document mapping");
    sources[at].mapping = mapping.data;
    sources[at].document_count = mapping.length;
    for (size_t region = 0; region < regions; region++) {
      auto data = readFieldRegion(runtime, inputs, first + 1, region, kind);
      sources[at].regions[region] = {data.data, data.capacity};
    }
  }
  narsil_field_merge_request request{kind, documents, sources.data(), sources.size()};
  if (writing) {
    narsil_field_merge_output output{};
    for (size_t at = 0; at < regions; at++) output.regions[at] = readFieldRegion(runtime, outputs, 0, at, kind);
    return jsi::Value(static_cast<double>(narsil_write_field_merge(state.keywordWorkspace.get(), &request, &output)));
  }
  auto sizes = outputs.read<uint32_t>(runtime, 0, "The field merge sizes");
  if (sizes.length != NARSIL_FIELD_MERGE_REGIONS) return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
  static_assert(sizeof(narsil_field_merge_sizes) == NARSIL_FIELD_MERGE_REGIONS * sizeof(uint32_t));
  return jsi::Value(static_cast<double>(narsil_measure_field_merge(state.keywordWorkspace.get(), &request,
                                                                  reinterpret_cast<narsil_field_merge_sizes*>(sizes.data))));
} catch (const std::invalid_argument&) {
  return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
