#pragma once

#include "TypedElements.hpp"
#include "narsil_terms.h"

#include <array>

namespace margelo::nitro::narsil {

class TermRegions {
public:
  enum Region : size_t { HEADER, SLOTS, OFFSET, LENGTH, NEXT, HEAD, UNITS,
                        TOKENS, OFFSETS, FREQUENCIES, REMOVED, TEXT, OUTPUT, BOUNDARIES, REGION_COUNT };
  TypedElements views{REGION_COUNT};

  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The term dictionary must be an object");
    auto descriptor = value.getObject(runtime);
    auto growing = descriptor.getProperty(runtime, "growing");
    _growing = !growing.isNull();
    if (_growing) {
      if (!growing.isObject()) throwInvalid("The growing term table must be an object");
      auto table = growing.getObject(runtime);
      constexpr std::array<const char*, 7> properties{
          "header", "slots", "termOffset", "termLength", "firstUnitNext", "firstUnitHead", "units"};
      for (size_t at = 0; at < properties.size(); at++) {
        views.prepare(runtime, at, table.getProperty(runtime, properties[at]));
      }
    }
    constexpr std::array<const char*, 4> properties{"tokens", "offsets", "frequencies", "removed"};
    for (size_t at = 0; at < properties.size(); at++) {
      views.prepare(runtime, TOKENS + at, descriptor.getProperty(runtime, properties[at]));
    }
  }

  narsil_term_dictionary read(jsi::Runtime& runtime, narsil_term_table& table) {
    if (_growing) {
      auto header = views.read<uint32_t>(runtime, HEADER, "The term header");
      auto slots = views.read<int32_t>(runtime, SLOTS, "The term slots");
      auto offset = views.read<uint32_t>(runtime, OFFSET, "The term offsets");
      auto length = views.read<uint32_t>(runtime, LENGTH, "The term lengths");
      auto next = views.read<uint32_t>(runtime, NEXT, "The next terms");
      auto head = views.read<uint32_t>(runtime, HEAD, "The first terms");
      auto units = views.read<uint16_t>(runtime, UNITS, "The term units");
      table = {header.data, header.length, slots.data, slots.length, offset.data, offset.length,
               length.data, length.length, next.data, next.length, head.data, head.length, units.data, units.length};
    }
    auto tokens = views.read<const uint8_t>(runtime, TOKENS, "The frozen tokens");
    auto offsets = views.read<const uint32_t>(runtime, OFFSETS, "The frozen token offsets");
    auto frequencies = views.read<const uint32_t>(runtime, FREQUENCIES, "The document frequencies");
    auto removed = views.read<const uint32_t>(runtime, REMOVED, "The removed document counts");
    return {_growing ? &table : nullptr, tokens.data, tokens.length, offsets.data, offsets.length,
            frequencies.data, frequencies.length, removed.data, removed.length};
  }

private:
  bool _growing = false;
};

}
