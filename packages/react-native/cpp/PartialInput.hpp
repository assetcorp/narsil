#pragma once

#include "ExpansionInput.hpp"
#include "narsil_expansion.h"

#include <cmath>
#include <cstdint>

namespace margelo::nitro::narsil {

class PartialInput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The partial-word source must be an object");
    auto object = value.getObject(runtime);
    auto segment = object.getProperty(runtime, "segment");
    auto runs = object.getProperty(runtime, "runs");
    _source.prepare(runtime, segment);
    _hasRuns = !runs.isNull();
    if (_hasRuns) {
      if (!runs.isObject()) throwInvalid("The partial-word runs must be an object");
      auto table = runs.getObject(runtime);
      _runs.prepare(runtime, 0, table.getProperty(runtime, "runs"));
      _runs.prepare(runtime, 1, table.getProperty(runtime, "offsets"));
      _runs.prepare(runtime, 2, table.getProperty(runtime, "members"));
    }
  }

  narsil_expansion_segment read(jsi::Runtime& runtime, narsil_frozen_runs& runs) {
    auto source = _source.read(runtime);
    if (_hasRuns) {
      if (source.growing != nullptr) throwInvalid("A growing source cannot hold frozen runs");
      auto points = _runs.read<const uint32_t>(runtime, 0, "The partial-word runs");
      auto offsets = _runs.read<const uint32_t>(runtime, 1, "The partial-word offsets");
      auto members = _runs.read<const uint32_t>(runtime, 2, "The partial-word members");
      runs = {points.data, points.length, offsets.data, offsets.length, members.data, members.length};
    }
    return source;
  }

private:
  ExpansionInput _source;
  TypedElements _runs{3};
  bool _hasRuns = false;
};

class PartialWord {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The partial-word request must be an object");
    auto object = value.getObject(runtime);
    _text.prepare(runtime, 0, object.getProperty(runtime, "written"));
    _text.prepare(runtime, 1, object.getProperty(runtime, "own"));
    _tolerance = whole(object.getProperty(runtime, "tolerance"));
    _prefixLength = whole(object.getProperty(runtime, "prefixLength"));
  }

  narsil_partial_word read(jsi::Runtime& runtime) {
    auto written = _text.read<const uint16_t>(runtime, 0, "The partial-word text");
    auto own = _text.read<const uint16_t>(runtime, 1, "The query token");
    return {written.data, written.length, own.data, own.length, _tolerance, _prefixLength};
  }

private:
  static uint32_t whole(const jsi::Value& value) {
    if (!value.isNumber()) throwInvalid("The partial-word option must be a number");
    double number = value.getNumber();
    if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) {
      throwInvalid("The partial-word option must be a uint32");
    }
    return static_cast<uint32_t>(number);
  }

  TypedElements _text{2};
  uint32_t _tolerance = 0;
  uint32_t _prefixLength = 0;
};

}
