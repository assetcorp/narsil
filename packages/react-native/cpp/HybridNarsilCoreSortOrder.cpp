#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_sort_order.h"

#include <array>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

namespace {

enum SortOrderArgument : size_t { CURRENT, LIVE, VALUES, RANKS, ORDERED, DIRTY, COUNTS, ARGUMENT_COUNT };
enum SortOrderRegion : size_t { CURRENT_START, OUTPUT_START = 5, LIVE_REGION = 10, RANKS_REGION,
                               ORDERED_REGION, DIRTY_REGION, COUNTS_REGION, REGION_COUNT };
static_assert(ARGUMENT_COUNT == SORT_ORDER_ARGUMENT_COUNT);

constexpr std::array<const char*, 5> PROPERTIES{"kinds", "numbers", "textStart", "textLength", "units"};

void prepareValues(jsi::Runtime& runtime, TypedElements& views, size_t first, const jsi::Value& value) {
  if (!value.isObject()) throw std::invalid_argument("The sort values must be an object");
  jsi::Object descriptor = value.getObject(runtime);
  for (size_t region = 0; region < PROPERTIES.size(); region++) {
    views.prepare(runtime, first + region, descriptor.getProperty(runtime, PROPERTIES[region]));
  }
}

narsil_sort_values readValues(jsi::Runtime& runtime, TypedElements& views) {
  auto kinds = views.read<const uint8_t>(runtime, 0, "The current sort kinds");
  auto numbers = views.read<const double>(runtime, 1, "The current sort numbers");
  auto starts = views.read<const uint32_t>(runtime, 2, "The current sort text starts");
  auto lengths = views.read<const uint32_t>(runtime, 3, "The current sort text lengths");
  auto units = views.read<const uint16_t>(runtime, 4, "The current sort code units");
  return {kinds.data, kinds.length, numbers.data, numbers.length, starts.data, starts.length,
          lengths.data, lengths.length, units.data, units.length};
}

narsil_sort_values_output readOutput(jsi::Runtime& runtime, TypedElements& views) {
  auto kinds = views.read<uint8_t>(runtime, OUTPUT_START, "The dictionary sort kinds");
  auto numbers = views.read<double>(runtime, OUTPUT_START + 1, "The dictionary sort numbers");
  auto starts = views.read<uint32_t>(runtime, OUTPUT_START + 2, "The dictionary sort text starts");
  auto lengths = views.read<uint32_t>(runtime, OUTPUT_START + 3, "The dictionary sort text lengths");
  auto units = views.read<uint16_t>(runtime, OUTPUT_START + 4, "The dictionary sort code units");
  return {kinds.data, kinds.length, numbers.data, numbers.length, starts.data, starts.length,
          lengths.data, lengths.length, units.data, units.length};
}

}

jsi::Value HybridNarsilCoreImpl::buildSortOrder(jsi::Runtime& runtime, const jsi::Value&,
                                              const jsi::Value* arguments, size_t count) try {
  if (count != ARGUMENT_COUNT) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  TypedElements views(REGION_COUNT);
  prepareValues(runtime, views, CURRENT_START, arguments[CURRENT]);
  prepareValues(runtime, views, OUTPUT_START, arguments[VALUES]);
  views.prepare(runtime, LIVE_REGION, arguments[LIVE]);
  views.prepare(runtime, RANKS_REGION, arguments[RANKS]);
  views.prepare(runtime, ORDERED_REGION, arguments[ORDERED]);
  views.prepare(runtime, DIRTY_REGION, arguments[DIRTY]);
  views.prepare(runtime, COUNTS_REGION, arguments[COUNTS]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  narsil_sort_values current = readValues(runtime, views);
  narsil_sort_values_output values = readOutput(runtime, views);
  auto live = views.read<const uint32_t>(runtime, LIVE_REGION, "The live sort ordinals");
  auto ranks = views.read<int32_t>(runtime, RANKS_REGION, "The sort ranks");
  auto ordered = views.read<uint32_t>(runtime, ORDERED_REGION, "The ordered sort ordinals");
  auto dirty = views.read<uint32_t>(runtime, DIRTY_REGION, "The dirty sort ordinals");
  auto counts = views.read<uint32_t>(runtime, COUNTS_REGION, "The sort counts");
  narsil_sort_order_output output{values, ranks.data, ranks.length, ordered.data, ordered.length,
                                  dirty.data, dirty.length, counts.data, counts.length};
  return jsi::Value(-static_cast<double>(narsil_build_sort_order(state.keywordWorkspace.get(), &current,
                                                               live.data, live.length, &output)));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
