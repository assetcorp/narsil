#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_sort_select.h"

#include <array>
#include <cmath>
#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {
namespace {
enum Argument : size_t { COLUMNS, DIRECTIONS, FILTER, LIVE, LIMIT, ANCHOR_RANKS, ANCHOR_VALUES, OUTPUT, ARGUMENT_COUNT };
enum Region : size_t { CURRENT, VALUES = 5, RANKS = 10, ORDERED, DIRTY, COLUMN_REGIONS };
enum TailRegion : size_t { DIRECTION_REGION, FILTER_REGION, LIVE_REGION, ANCHOR_RANK_REGION, ANCHOR_VALUE_REGION,
                         OUTPUT_REGION = ANCHOR_VALUE_REGION + 5, TAIL_REGIONS };
static_assert(ARGUMENT_COUNT == SORT_SELECT_ARGUMENT_COUNT);
constexpr std::array<const char*, 5> PROPERTIES{"kinds", "numbers", "textStart", "textLength", "units"};

void prepareValues(jsi::Runtime& runtime, TypedElements& views, size_t first, const jsi::Value& value) {
  if (!value.isObject()) throw std::invalid_argument("The sort values must be an object");
  auto descriptor = value.getObject(runtime);
  for (size_t region = 0; region < PROPERTIES.size(); region++) {
    views.prepare(runtime, first + region, descriptor.getProperty(runtime, PROPERTIES[region]));
  }
}

narsil_sort_values readValues(jsi::Runtime& runtime, TypedElements& views, size_t first) {
  auto kinds = views.read<const uint8_t>(runtime, first, "The sort kinds");
  auto numbers = views.read<const double>(runtime, first + 1, "The sort numbers");
  auto starts = views.read<const uint32_t>(runtime, first + 2, "The sort text starts");
  auto lengths = views.read<const uint32_t>(runtime, first + 3, "The sort text lengths");
  auto units = views.read<const uint16_t>(runtime, first + 4, "The sort code units");
  return {kinds.data, kinds.length, numbers.data, numbers.length, starts.data, starts.length,
          lengths.data, lengths.length, units.data, units.length};
}
}

jsi::Value HybridNarsilCoreImpl::sortSelect(jsi::Runtime& runtime, const jsi::Value&,
                                          const jsi::Value* arguments, size_t count) try {
  if (count != ARGUMENT_COUNT || !arguments[COLUMNS].isObject() ||
      !arguments[COLUMNS].getObject(runtime).isArray(runtime) || !arguments[LIMIT].isNumber() ||
      arguments[ANCHOR_RANKS].isNull() != arguments[ANCHOR_VALUES].isNull()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  double limit = arguments[LIMIT].getNumber();
  auto descriptors = arguments[COLUMNS].getObject(runtime).getArray(runtime);
  size_t fields = descriptors.size(runtime);
  if (!std::isfinite(limit) || limit < 0 || limit > UINT32_MAX || std::floor(limit) != limit || fields == 0 ||
      fields > UINT32_MAX || fields > (SIZE_MAX - TAIL_REGIONS) / COLUMN_REGIONS) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  const size_t tail = fields * COLUMN_REGIONS;
  TypedElements views(tail + TAIL_REGIONS);
  for (size_t field = 0; field < fields; field++) {
    auto value = descriptors.getValueAtIndex(runtime, field);
    if (!value.isObject()) throw std::invalid_argument("A sort column must be an object");
    auto column = value.getObject(runtime);
    const size_t first = field * COLUMN_REGIONS;
    prepareValues(runtime, views, first + CURRENT, column.getProperty(runtime, "current"));
    prepareValues(runtime, views, first + VALUES, column.getProperty(runtime, "values"));
    views.prepare(runtime, first + RANKS, column.getProperty(runtime, "ranks"));
    views.prepare(runtime, first + ORDERED, column.getProperty(runtime, "ordered"));
    views.prepare(runtime, first + DIRTY, column.getProperty(runtime, "dirty"));
  }
  views.prepare(runtime, tail + DIRECTION_REGION, arguments[DIRECTIONS]);
  views.prepare(runtime, tail + FILTER_REGION, arguments[FILTER]);
  views.prepare(runtime, tail + LIVE_REGION, arguments[LIVE]);
  views.prepare(runtime, tail + OUTPUT_REGION, arguments[OUTPUT]);
  if (!arguments[ANCHOR_VALUES].isNull()) {
    views.prepare(runtime, tail + ANCHOR_RANK_REGION, arguments[ANCHOR_RANKS]);
    prepareValues(runtime, views, tail + ANCHOR_VALUE_REGION, arguments[ANCHOR_VALUES]);
  }
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  std::vector<narsil_sort_column> columns(fields);
  for (size_t field = 0; field < fields; field++) {
    const size_t first = field * COLUMN_REGIONS;
    auto& column = columns[field];
    column.current = readValues(runtime, views, first + CURRENT);
    column.values = readValues(runtime, views, first + VALUES);
    auto ranks = views.read<const int32_t>(runtime, first + RANKS, "The sort ranks");
    auto ordered = views.read<const uint32_t>(runtime, first + ORDERED, "The ordered ordinals");
    auto dirty = views.read<const uint32_t>(runtime, first + DIRTY, "The dirty ordinals");
    column.ranks = ranks.data;
    column.rank_count = ranks.length;
    column.ordered = ordered.data;
    column.ordered_count = ordered.length;
    column.dirty = dirty.data;
    column.dirty_words = dirty.length;
  }
  narsil_sort_select_request request{};
  narsil_sort_values anchor{};
  request.columns = columns.data();
  request.column_count = fields;
  request.limit = static_cast<uint32_t>(limit);
  if (!arguments[ANCHOR_VALUES].isNull()) {
    anchor = readValues(runtime, views, tail + ANCHOR_VALUE_REGION);
    auto ranks = views.read<const int32_t>(runtime, tail + ANCHOR_RANK_REGION, "The anchor ranks");
    request.anchor_values = &anchor;
    request.anchor_ranks = ranks.data;
    request.anchor_rank_count = ranks.length;
  }
  auto directions = views.read<const uint8_t>(runtime, tail + DIRECTION_REGION, "The sort directions");
  auto filter = views.read<const uint32_t>(runtime, tail + FILTER_REGION, "The filtered ordinals");
  auto live = views.read<const uint32_t>(runtime, tail + LIVE_REGION, "The live ordinals");
  auto output = views.read<uint32_t>(runtime, tail + OUTPUT_REGION, "The selected ordinals");
  request.directions = directions.data;
  request.direction_count = directions.length;
  request.filter = filter.data;
  request.filter_words = filter.length;
  request.live = live.data;
  request.live_words = live.length;
  request.output = output.data;
  request.output_capacity = output.length;
  uint32_t selected = 0;
  auto status = narsil_sort_select(state.keywordWorkspace.get(), &request, &selected);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(selected) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}
}
