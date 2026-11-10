#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_pattern.h"
#include "narsil_stored_values.h"
#include "narsil_work.h"
#include "core/src/regions.h"

#include <array>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {
namespace {
enum Argument : size_t { DOCUMENTS, RUNS, OFFSETS, POSTINGS, VALUES, TEXT, OPTIONS, METER, STOP, DEADLINE, INTO };
enum FieldRegion : size_t { SHAPES, STARTS, KINDS, NUMBERS, TEXT_START, TEXT_LENGTH, UNITS, BYTES, FIELD_REGIONS };
enum Option : size_t { OPERATOR, CASE_FOLD, TOLERANCE, COUNT_PREPARATION, MATCHER_BYTES, OPTION_COUNT };
constexpr std::array<const char*, FIELD_REGIONS> FIELD_PROPERTIES{
    "shapes", "starts", "kinds", "numbers", "textStart", "textLength", "units", "bytes"};

narsil_stored_values readField(jsi::Runtime& runtime, TypedElements& views) {
  auto shapes = views.read<const uint8_t>(runtime, SHAPES, "The stored shapes");
  auto starts = views.read<const uint32_t>(runtime, STARTS, "The stored starts");
  auto kinds = views.read<const uint8_t>(runtime, KINDS, "The stored kinds");
  auto numbers = views.read<const double>(runtime, NUMBERS, "The stored numbers");
  auto textStart = views.read<const uint32_t>(runtime, TEXT_START, "The stored text starts");
  auto textLength = views.read<const uint32_t>(runtime, TEXT_LENGTH, "The stored text lengths");
  auto units = views.read<const uint16_t>(runtime, UNITS, "The stored code units");
  auto bytes = views.read<const uint8_t>(runtime, BYTES, "The stored encoded bytes");
  return {shapes.data, shapes.length, starts.data, starts.length, kinds.data, kinds.length,
          numbers.data, numbers.length, textStart.data, textStart.length, textLength.data, textLength.length,
          units.data, units.length, bytes.data, bytes.length};
}

bool controlsValid(Elements<const uint32_t> options, Elements<int64_t> meter,
                   Elements<const uint32_t> stop, Elements<const uint64_t> deadline, Elements<uint32_t> into) {
  if (options.length != OPTION_COUNT || meter.length != 2 || stop.length != 1 || deadline.length != 1) return false;
  memory_region output, spent, flags, time, cap;
  return region_of(into.data, into.length, sizeof(uint32_t), &output) &&
         region_of(meter.data, 1, sizeof(int64_t), &spent) &&
         region_of(meter.data + 1, 1, sizeof(int64_t), &cap) &&
         region_of(options.data, OPTION_COUNT, sizeof(uint32_t), &flags) &&
         region_of(deadline.data, 1, sizeof(uint64_t), &time) &&
         !overlaps(output, flags) && !overlaps(output, time) && !overlaps(output, cap) &&
         !overlaps(spent, flags) && !overlaps(spent, time) && !overlaps(spent, cap);
}
}

jsi::Value HybridNarsilCoreImpl::patternTest(jsi::Runtime& runtime, const jsi::Value&,
                                           const jsi::Value* arguments, size_t count) try {
  if (count != PATTERN_ARGUMENT_COUNT || !arguments[VALUES].isObject()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TypedElements fields(FIELD_REGIONS);
  auto descriptor = arguments[VALUES].getObject(runtime);
  for (size_t region = 0; region < FIELD_REGIONS; region++) {
    fields.prepare(runtime, region, descriptor.getProperty(runtime, FIELD_PROPERTIES[region]));
  }
  TypedElements views(PATTERN_ARGUMENT_COUNT);
  for (size_t at = 0; at < PATTERN_ARGUMENT_COUNT; at++) {
    if (at != VALUES) views.prepare(runtime, at, arguments[at]);
  }
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  auto values = readField(runtime, fields);
  auto documents = views.read<const uint32_t>(runtime, DOCUMENTS, "The field documents");
  auto runs = views.read<const uint32_t>(runtime, RUNS, "The indexed code point triples");
  auto offsets = views.read<const uint32_t>(runtime, OFFSETS, "The posting offsets");
  auto postings = views.read<const uint32_t>(runtime, POSTINGS, "The postings");
  auto text = views.read<const uint16_t>(runtime, TEXT, "The pattern text");
  auto options = views.read<const uint32_t>(runtime, OPTIONS, "The pattern options");
  auto meter = views.read<int64_t>(runtime, METER, "The work counter and cap");
  auto stop = views.read<const uint32_t>(runtime, STOP, "The stop flag");
  auto deadline = views.read<const uint64_t>(runtime, DEADLINE, "The search deadline");
  auto into = views.read<uint32_t>(runtime, INTO, "The matching documents");
  if (!controlsValid(options, meter, stop, deadline, into)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  narsil_pattern_index index{{documents.data, documents.length}, {runs.data, runs.length},
                             {offsets.data, offsets.length}, {postings.data, postings.length}};
  narsil_pattern_test test{text.data, text.length, options.data[OPERATOR], options.data[CASE_FOLD],
                           options.data[TOLERANCE], options.data[COUNT_PREPARATION], options.data[MATCHER_BYTES]};
  narsil_work_meter work{meter.data, meter.data[1], stop.data, deadline.data[0]};
  auto status = narsil_pattern_match(state.keywordWorkspace.get(), &index, &values, &test, &work,
                                      into.data, into.length);
  return jsi::Value(-static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::clockNow(jsi::Runtime& runtime, const jsi::Value&,
                                        const jsi::Value* arguments, size_t count) try {
  if (count != 1) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  TypedElements views(1);
  views.prepare(runtime, 0, arguments[0]);
  auto into = views.read<uint64_t>(runtime, 0, "The clock output");
  if (into.length == 0) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  into.data[0] = narsil_clock_now();
  return jsi::Value(0);
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
