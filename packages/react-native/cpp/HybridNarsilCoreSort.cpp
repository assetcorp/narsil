#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_sort.h"

#include <array>
#include <cmath>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

namespace {

enum SortArgument : size_t { VALUES, ORDINAL, MODE, NUMBER, TEXT, ARGUMENT_COUNT };
enum SortRegion : size_t { SHAPES, STARTS, KINDS, NUMBERS, TEXT_START, TEXT_LENGTH, UNITS, BYTES,
                          OUT_NUMBER, OUT_TEXT, REGION_COUNT };
static_assert(ARGUMENT_COUNT == SORT_VALUE_ARGUMENT_COUNT);

constexpr std::array<const char*, 8> FIELD_PROPERTIES{
    "shapes", "starts", "kinds", "numbers", "textStart", "textLength", "units", "bytes"};

bool unsignedArgument(const jsi::Value& value, uint32_t& into) {
  if (!value.isNumber()) return false;
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) return false;
  into = static_cast<uint32_t>(number);
  return true;
}

}

jsi::Value HybridNarsilCoreImpl::sortValue(jsi::Runtime& runtime, const jsi::Value&,
                                         const jsi::Value* arguments, size_t count) try {
  uint32_t ordinal = 0;
  uint32_t mode = 0;
  if (count != ARGUMENT_COUNT || !unsignedArgument(arguments[ORDINAL], ordinal) ||
      !unsignedArgument(arguments[MODE], mode) || !arguments[VALUES].isObject()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TypedElements views(REGION_COUNT);
  jsi::Object descriptor = arguments[VALUES].getObject(runtime);
  for (size_t region = 0; region < FIELD_PROPERTIES.size(); region++) {
    views.prepare(runtime, region, descriptor.getProperty(runtime, FIELD_PROPERTIES[region]));
  }
  views.prepare(runtime, OUT_NUMBER, arguments[NUMBER]);
  views.prepare(runtime, OUT_TEXT, arguments[TEXT]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  auto shapes = views.read<const uint8_t>(runtime, SHAPES, "The stored shapes");
  auto starts = views.read<const uint32_t>(runtime, STARTS, "The stored starts");
  auto kinds = views.read<const uint8_t>(runtime, KINDS, "The stored kinds");
  auto numbers = views.read<const double>(runtime, NUMBERS, "The stored numbers");
  auto textStart = views.read<const uint32_t>(runtime, TEXT_START, "The stored text starts");
  auto textLength = views.read<const uint32_t>(runtime, TEXT_LENGTH, "The stored text lengths");
  auto units = views.read<const uint16_t>(runtime, UNITS, "The stored code units");
  auto bytes = views.read<const uint8_t>(runtime, BYTES, "The stored encoded bytes");
  auto number = views.read<double>(runtime, OUT_NUMBER, "The numeric sort value");
  auto text = views.read<uint32_t>(runtime, OUT_TEXT, "The string sort value");
  narsil_stored_values values{shapes.data, shapes.length, starts.data, starts.length, kinds.data, kinds.length,
                              numbers.data, numbers.length, textStart.data, textStart.length,
                              textLength.data, textLength.length, units.data, units.length, bytes.data, bytes.length};
  narsil_sort_value_output output{number.data, number.length, text.data, text.length, 0};
  narsil_status status = narsil_sort_value(state.keywordWorkspace.get(), &values, ordinal, mode, &output);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(output.kind) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
