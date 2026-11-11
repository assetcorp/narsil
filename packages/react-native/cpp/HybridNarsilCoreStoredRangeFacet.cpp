#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_facets.h"

#include <array>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {
namespace {
enum Region : size_t { SHAPES, STARTS, KINDS, NUMBERS, TEXT_START, TEXT_LENGTH, UNITS, BYTES,
                       MATCHED, RANGES, COUNTS, REGION_COUNT };
constexpr std::array<const char*, 8> FIELD_PROPERTIES{
    "shapes", "starts", "kinds", "numbers", "textStart", "textLength", "units", "bytes"};
}

jsi::Value HybridNarsilCoreImpl::storedRangeFacet(jsi::Runtime& runtime, const jsi::Value&,
                                                const jsi::Value* arguments, size_t count) try {
  if (count != STORED_RANGE_FACET_ARGUMENT_COUNT || !arguments[0].isObject()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TypedElements views(REGION_COUNT);
  auto descriptor = arguments[0].getObject(runtime);
  for (size_t region = 0; region < FIELD_PROPERTIES.size(); region++) {
    views.prepare(runtime, region, descriptor.getProperty(runtime, FIELD_PROPERTIES[region]));
  }
  views.prepare(runtime, MATCHED, arguments[1]);
  views.prepare(runtime, RANGES, arguments[2]);
  views.prepare(runtime, COUNTS, arguments[3]);
  auto shapes = views.read<const uint8_t>(runtime, SHAPES, "The stored shapes");
  auto starts = views.read<const uint32_t>(runtime, STARTS, "The stored starts");
  auto kinds = views.read<const uint8_t>(runtime, KINDS, "The stored kinds");
  auto numbers = views.read<const double>(runtime, NUMBERS, "The stored numbers");
  auto textStart = views.read<const uint32_t>(runtime, TEXT_START, "The stored text starts");
  auto textLength = views.read<const uint32_t>(runtime, TEXT_LENGTH, "The stored text lengths");
  auto units = views.read<const uint16_t>(runtime, UNITS, "The stored code units");
  auto bytes = views.read<const uint8_t>(runtime, BYTES, "The stored encoded bytes");
  auto matched = views.read<const uint32_t>(runtime, MATCHED, "The matched ordinals");
  auto ranges = views.read<const double>(runtime, RANGES, "The range bounds");
  auto counts = views.read<uint32_t>(runtime, COUNTS, "The facet counts");
  narsil_stored_values values{shapes.data, shapes.length, starts.data, starts.length, kinds.data, kinds.length,
                              numbers.data, numbers.length, textStart.data, textStart.length,
                              textLength.data, textLength.length, units.data, units.length, bytes.data, bytes.length};
  return jsi::Value(-static_cast<double>(narsil_stored_range_facet(&values, matched.data, matched.length,
      ranges.data, ranges.length, counts.data, counts.length)));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
