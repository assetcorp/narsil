#pragma once

#include "TypedElements.hpp"
#include "narsil_segments.h"

#include <array>
#include <cstdint>

namespace margelo::nitro::narsil {

template <size_t Count>
class SegmentViews {
public:
  TypedElements views{Count};

  void prepare(jsi::Runtime& runtime, const jsi::Value& value, const std::array<const char*, Count>& properties) {
    if (!value.isObject()) throwInvalid("A segment region descriptor must be an object");
    auto object = value.getObject(runtime);
    for (size_t index = 0; index < Count; index++) {
      views.prepare(runtime, index, object.getProperty(runtime, properties[index]));
    }
  }

  template <typename Element>
  Elements<Element> read(jsi::Runtime& runtime, size_t index, size_t expected = SIZE_MAX) {
    auto region = views.read<Element>(runtime, index, "The segment region");
    if (expected != SIZE_MAX && region.length != expected) throwInvalid("The segment region has the wrong length");
    return region;
  }
};

class SegmentStringRegions {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    _views.prepare(runtime, value, {"header", "slots", "termOffset", "termLength", "firstUnitNext", "firstUnitHead", "units"});
  }

  narsil_term_table read(jsi::Runtime& runtime) {
    auto header = _views.read<uint32_t>(runtime, 0);
    auto slots = _views.read<int32_t>(runtime, 1);
    auto offsets = _views.read<uint32_t>(runtime, 2);
    auto lengths = _views.read<uint32_t>(runtime, 3);
    auto next = _views.read<uint32_t>(runtime, 4);
    auto heads = _views.read<uint32_t>(runtime, 5);
    auto units = _views.read<uint16_t>(runtime, 6);
    return {header.data, header.length, slots.data, slots.length, offsets.data, offsets.length,
            lengths.data, lengths.length, next.data, next.length, heads.data, heads.length, units.data, units.length};
  }

private:
  SegmentViews<7> _views;
};

class SegmentSurfaceRegions {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The surface table must be an object");
    auto object = value.getObject(runtime);
    _strings.prepare(runtime, object.getProperty(runtime, "strings"));
    _views.prepare(runtime, value, {"token", "count"});
  }

  narsil_surface_table read(jsi::Runtime& runtime) {
    auto strings = _strings.read(runtime);
    auto tokens = _views.read<uint32_t>(runtime, 0, strings.offset_count);
    auto counts = _views.read<uint32_t>(runtime, 1, strings.offset_count);
    return {strings, tokens.data, counts.data, tokens.length};
  }

private:
  SegmentStringRegions _strings;
  SegmentViews<2> _views;
};

class SegmentRunRegions {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    _views.prepare(runtime, value, {"header", "slots", "runs", "listStart", "listLength", "listClass", "members",
                                     "allocation", "freeHeads", "sliceCapacities"});
  }

  narsil_run_table read(jsi::Runtime& runtime) {
    auto header = _views.read<uint32_t>(runtime, 0, 8);
    auto slots = _views.read<int32_t>(runtime, 1);
    auto starts = _views.read<uint32_t>(runtime, 3);
    if (starts.length > SIZE_MAX / 3) throwInvalid("The run table is too large");
    auto runs = _views.read<uint32_t>(runtime, 2, static_cast<size_t>(starts.length) * 3);
    auto lengths = _views.read<uint32_t>(runtime, 4, starts.length);
    auto classes = _views.read<uint8_t>(runtime, 5, starts.length);
    auto members = _views.read<uint32_t>(runtime, 6);
    auto allocation = _views.read<uint32_t>(runtime, 7, 2);
    auto sizes = _views.read<uint32_t>(runtime, 9);
    auto heads = _views.read<uint32_t>(runtime, 8, sizes.length);
    return {header.data, slots.data, slots.length, runs.data, starts.data, lengths.data, classes.data,
            starts.length, members.data, members.length, {allocation.data, heads.data, sizes.data, sizes.length}};
  }

private:
  SegmentViews<10> _views;
};

}
