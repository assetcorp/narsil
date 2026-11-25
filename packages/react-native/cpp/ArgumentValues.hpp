#pragma once

#include "HostMemory.hpp"
#include "HybridNarsilCoreImpl.hpp"
#include "narsil_analysis.h"
#include "narsil_core.h"

#include <jsi/jsi.h>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace margelo::nitro::narsil {

inline uint32_t wholeNumber(const jsi::Value& value, const char* what) {
  if (!value.isNumber()) throwInvalid(std::string(what) + " must be a number");
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) {
    throwInvalid(std::string(what) + " must be a whole number from 0 to 4294967295");
  }
  return static_cast<uint32_t>(number);
}

inline uint32_t wholeArgument(const jsi::Value* arguments, size_t count, size_t index, const char* what) {
  if (index >= count) throwInvalid(std::string(what) + " must be a number");
  return wholeNumber(arguments[index], what);
}

inline uint32_t languageArgument(const jsi::Value* arguments, size_t count, size_t index) {
  uint32_t language = wholeArgument(arguments, count, index, "The language index");
  if (language >= narsil_language_count()) throwInvalid("The language index names no language module of the core");
  return language;
}

inline jsi::Array arrayValue(jsi::Runtime& runtime, const jsi::Value& value, const char* what) {
  if (!value.isObject() || !value.getObject(runtime).isArray(runtime)) {
    throwInvalid(std::string(what) + " must be an array");
  }
  auto array = value.getObject(runtime).getArray(runtime);
  if (array.size(runtime) > UINT32_MAX) throwInvalid(std::string(what) + " has too many entries");
  return array;
}

inline void appendUnits(jsi::Runtime& runtime, const jsi::String& text, std::vector<uint16_t>& units, size_t limit) {
  bool tooLong = false;
  auto collect = [&units, &tooLong, limit](bool ascii, const void* data, size_t length) {
    if (tooLong || length > limit - units.size()) {
      tooLong = true;
      return;
    }
    size_t start = units.size();
    units.resize(start + length);
    if (ascii) {
      const auto* characters = static_cast<const unsigned char*>(data);
      for (size_t index = 0; index < length; index++) units[start + index] = characters[index];
    } else if (length > 0) {
      std::memcpy(units.data() + start, data, length * sizeof(uint16_t));
    }
  };
  text.getStringData(runtime, collect);
  if (tooLong) throwInvalid("The text holds more code units than the core analyses at once");
}

inline void readText(jsi::Runtime& runtime, const jsi::Value& value, const char* what, std::vector<uint16_t>& units) {
  if (!value.isString()) throwInvalid(std::string(what) + " must be a string");
  units.clear();
  appendUnits(runtime, value.getString(runtime), units, NARSIL_MAX_ANALYSED_UNITS);
}

inline jsi::Value textOf(jsi::Runtime& runtime, std::u16string& out, const uint16_t* units, size_t length) {
  out.resize(length);
  if (length > 0) std::memcpy(out.data(), units, length * sizeof(uint16_t));
  return jsi::String::createFromUtf16(runtime, out);
}

inline jsi::Value statusValue(narsil_status status) { return jsi::Value(-static_cast<double>(status)); }

inline narsil_analyser* analyserOf(std::unique_ptr<narsil_analyser, AnalyserRelease>& held) {
  if (held == nullptr) {
    narsil_analyser* created = nullptr;
    if (narsil_analyser_create(&created) != NARSIL_OK) return nullptr;
    held.reset(created);
  }
  return held.get();
}

}
