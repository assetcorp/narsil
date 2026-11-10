#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_filters.h"
#include "core/src/regions.h"

#include <array>
#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {
namespace {
enum Argument : size_t { PLAN, NUMBERS, UNITS, OFFSETS, LISTS, BITSETS, KINDS, FIELDS, LIVE, INTO };
constexpr std::array<size_t, 5> FIELD_COUNTS{1, 3, 3, 6, 5};

jsi::Array arrayOf(jsi::Runtime& runtime, const jsi::Value& value) {
  if (!value.isObject() || !value.getObject(runtime).isArray(runtime)) {
    throw std::invalid_argument("The filter regions must be arrays");
  }
  return value.getObject(runtime).getArray(runtime);
}

template <typename Element>
narsil_filter_region regionOf(jsi::Runtime& runtime, TypedElements& views, size_t index) {
  auto region = views.read<const Element>(runtime, index, "The filter region");
  return {region.data, region.length};
}

narsil_filter_region fieldRegion(jsi::Runtime& runtime, TypedElements& views, size_t index,
                                uint32_t kind, size_t region) {
  if ((kind == NARSIL_FILTER_NUMERIC && region == 1) ||
      (kind == NARSIL_FILTER_GEO && (region == 2 || region == 3))) {
    return regionOf<double>(runtime, views, index);
  }
  if (kind == NARSIL_FILTER_ENUM && region == 1) return regionOf<uint16_t>(runtime, views, index);
  if (kind == NARSIL_FILTER_GEO && region == 1) return regionOf<uint64_t>(runtime, views, index);
  return regionOf<uint32_t>(runtime, views, index);
}
}

jsi::Value HybridNarsilCoreImpl::evaluateFilter(jsi::Runtime& runtime, const jsi::Value&,
                                              const jsi::Value* arguments, size_t count) try {
  if (count != FILTER_ARGUMENT_COUNT) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto fieldArrays = arrayOf(runtime, arguments[FIELDS]);
  auto bitsetArrays = arrayOf(runtime, arguments[BITSETS]);
  size_t fieldCount = fieldArrays.size(runtime);
  size_t bitsetCount = bitsetArrays.size(runtime);
  if (fieldCount > UINT32_MAX || bitsetCount > UINT32_MAX ||
      fieldCount > (SIZE_MAX - FILTER_ARGUMENT_COUNT) / NARSIL_FILTER_FIELD_REGIONS) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  size_t bitsetStart = FILTER_ARGUMENT_COUNT + fieldCount * NARSIL_FILTER_FIELD_REGIONS;
  if (bitsetCount > SIZE_MAX - bitsetStart) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  TypedElements views(bitsetStart + bitsetCount);
  std::vector<narsil_filter_field> fields(fieldCount);
  std::vector<narsil_filter_bits> bitsets(bitsetCount);
  for (size_t at = 0; at < FILTER_ARGUMENT_COUNT; at++) {
    if (at != BITSETS && at != FIELDS) views.prepare(runtime, at, arguments[at]);
  }
  for (size_t at = 0; at < fieldCount; at++) {
    auto regions = arrayOf(runtime, fieldArrays.getValueAtIndex(runtime, at));
    size_t size = regions.size(runtime);
    if (size == 0 || size > NARSIL_FILTER_FIELD_REGIONS) {
      return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
    }
    fields[at].region_count = size;
    for (size_t region = 0; region < size; region++) {
      views.prepare(runtime, FILTER_ARGUMENT_COUNT + at * NARSIL_FILTER_FIELD_REGIONS + region,
                    regions.getValueAtIndex(runtime, region));
    }
  }
  for (size_t at = 0; at < bitsetCount; at++) {
    views.prepare(runtime, bitsetStart + at, bitsetArrays.getValueAtIndex(runtime, at));
  }
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  auto plan = views.read<const uint32_t>(runtime, PLAN, "The filter plan");
  auto numbers = views.read<const double>(runtime, NUMBERS, "The filter numbers");
  auto units = views.read<const uint16_t>(runtime, UNITS, "The filter text");
  auto offsets = views.read<const uint32_t>(runtime, OFFSETS, "The filter text offsets");
  auto lists = views.read<const uint32_t>(runtime, LISTS, "The filter lists");
  auto kinds = views.read<const uint8_t>(runtime, KINDS, "The filter kinds");
  auto live = views.read<const uint32_t>(runtime, LIVE, "The live documents");
  auto into = views.read<uint32_t>(runtime, INTO, "The filter output");
  memory_region output;
  memory_region kindRegion;
  if (kinds.length != fieldCount || !region_of(into.data, into.length, sizeof(uint32_t), &output) ||
      !region_of(kinds.data, kinds.length, sizeof(uint8_t), &kindRegion) || overlaps(output, kindRegion)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  for (size_t at = 0; at < fieldCount; at++) {
    auto& field = fields[at];
    field.kind = kinds.data[at];
    if (field.kind >= FIELD_COUNTS.size() || field.region_count != FIELD_COUNTS[field.kind]) {
      return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
    }
    for (size_t region = 0; region < field.region_count; region++) {
      field.regions[region] = fieldRegion(runtime, views,
          FILTER_ARGUMENT_COUNT + at * NARSIL_FILTER_FIELD_REGIONS + region, field.kind, region);
    }
  }
  for (size_t at = 0; at < bitsetCount; at++) {
    auto bits = views.read<const uint32_t>(runtime, bitsetStart + at, "The filter bitmap");
    bitsets[at] = {bits.data, bits.length};
  }
  narsil_filter_program program{plan.data, plan.length, numbers.data, numbers.length, units.data, units.length,
      offsets.data, offsets.length, lists.data, lists.length, bitsets.data(), bitsetCount,
      fields.data(), fieldCount, {live.data, live.length}};
  auto status = narsil_evaluate_filter(state.keywordWorkspace.get(), &program, into.data, into.length);
  return jsi::Value(-static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
