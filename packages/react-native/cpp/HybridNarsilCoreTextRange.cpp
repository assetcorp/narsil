#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_sort_order.h"

#include <array>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {
namespace {
enum Argument : size_t { COLUMN, LOWER, LOWER_INCLUSIVE, UPPER, UPPER_INCLUSIVE, LIVE, OUTPUT, ARGUMENT_COUNT };
enum Region : size_t { CURRENT = 0, VALUES = 5, RANKS = 10, ORDERED, DIRTY, LOWER_UNITS, UPPER_UNITS,
                       LIVE_WORDS, OUTPUT_WORDS, REGION_COUNT };
static_assert(ARGUMENT_COUNT == TEXT_RANGE_ARGUMENT_COUNT);
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

jsi::Value HybridNarsilCoreImpl::textRange(jsi::Runtime& runtime, const jsi::Value&,
                                          const jsi::Value* arguments, size_t count) try {
  if (count != ARGUMENT_COUNT || !arguments[COLUMN].isObject() || !arguments[LOWER_INCLUSIVE].isBool() ||
      !arguments[UPPER_INCLUSIVE].isBool()) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto descriptor = arguments[COLUMN].getObject(runtime);
  auto current = descriptor.getProperty(runtime, "current");
  auto values = descriptor.getProperty(runtime, "values");
  auto ranksValue = descriptor.getProperty(runtime, "ranks");
  auto orderedValue = descriptor.getProperty(runtime, "ordered");
  auto dirtyValue = descriptor.getProperty(runtime, "dirty");
  TypedElements views(REGION_COUNT);
  prepareValues(runtime, views, CURRENT, current);
  prepareValues(runtime, views, VALUES, values);
  views.prepare(runtime, RANKS, ranksValue);
  views.prepare(runtime, ORDERED, orderedValue);
  views.prepare(runtime, DIRTY, dirtyValue);
  if (!arguments[LOWER].isNull()) views.prepare(runtime, LOWER_UNITS, arguments[LOWER]);
  if (!arguments[UPPER].isNull()) views.prepare(runtime, UPPER_UNITS, arguments[UPPER]);
  views.prepare(runtime, LIVE_WORDS, arguments[LIVE]);
  views.prepare(runtime, OUTPUT_WORDS, arguments[OUTPUT]);
  narsil_sort_column column{};
  column.current = readValues(runtime, views, CURRENT);
  column.values = readValues(runtime, views, VALUES);
  auto ranks = views.read<const int32_t>(runtime, RANKS, "The sort ranks");
  auto ordered = views.read<const uint32_t>(runtime, ORDERED, "The ordered ordinals");
  auto dirty = views.read<const uint32_t>(runtime, DIRTY, "The dirty ordinals");
  column.ranks = ranks.data;
  column.rank_count = ranks.length;
  column.ordered = ordered.data;
  column.ordered_count = ordered.length;
  column.dirty = dirty.data;
  column.dirty_words = dirty.length;
  narsil_text_range_request request{};
  request.lower.inclusive = arguments[LOWER_INCLUSIVE].getBool();
  request.upper.inclusive = arguments[UPPER_INCLUSIVE].getBool();
  if (!arguments[LOWER].isNull()) {
    auto lower = views.read<const uint16_t>(runtime, LOWER_UNITS, "The lower text bound");
    request.lower = {lower.data, lower.length, 1, request.lower.inclusive};
  }
  if (!arguments[UPPER].isNull()) {
    auto upper = views.read<const uint16_t>(runtime, UPPER_UNITS, "The upper text bound");
    request.upper = {upper.data, upper.length, 1, request.upper.inclusive};
  }
  auto live = views.read<const uint32_t>(runtime, LIVE_WORDS, "The live ordinals");
  auto output = views.read<uint32_t>(runtime, OUTPUT_WORDS, "The matching ordinals");
  request.live = live.data;
  request.live_words = live.length;
  request.output = output.data;
  request.output_words = output.length;
  return jsi::Value(-static_cast<double>(narsil_text_range(&column, &request)));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}
}
