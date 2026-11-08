#pragma once

#include "FrozenSegmentRegions.hpp"
#include "narsil_expansion.h"

namespace margelo::nitro::narsil {
class ExpansionInput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The expansion source must be an object");
    auto object = value.getObject(runtime);
    auto growing = object.getProperty(runtime, "growing");
    auto frozen = object.getProperty(runtime, "frozen");
    auto state = object.getProperty(runtime, "state");
    auto occurrences = object.getProperty(runtime, "occurrences");
    _hasOccurrences = !occurrences.isNull() && !occurrences.isUndefined();
    if (_hasOccurrences) _occurrences.prepare(runtime, 0, occurrences);
    _hasGrowing = !growing.isNull();
    if (_hasGrowing) {
      if (!frozen.isNull() || !state.isNull() || _hasOccurrences)
        throwInvalid("The growing expansion source has frozen regions");
      _growing.prepare(runtime, growing);
    } else {
      if (frozen.isNull() || state.isNull()) throwInvalid("The frozen expansion source needs its state");
      _frozen.prepare(runtime, frozen, state);
    }
  }

  narsil_expansion_segment read(jsi::Runtime& runtime) {
    if (_hasGrowing) {
      _growingSource = _growing.read(runtime);
      return {&_growingSource, nullptr, nullptr, nullptr, 0};
    }
    _frozenSource = _frozen.read(runtime);
    _state = _frozen.readState(runtime, _frozenSource.terms.count);
    Elements<double> occurrences{nullptr, 0};
    if (_hasOccurrences) {
      occurrences = _occurrences.read<double>(runtime, 0, "term totals");
      if (occurrences.length != _frozenSource.terms.count) throwInvalid("The term totals have the wrong length");
    }
    return {nullptr, &_frozenSource, &_state, occurrences.data, occurrences.length};
  }

private:
  SegmentRegions _growing;
  FrozenSegmentRegions _frozen;
  narsil_growing_segment _growingSource{};
  narsil_frozen_segment _frozenSource{};
  narsil_frozen_segment_state _state{};
  bool _hasGrowing = false;
  TypedElements _occurrences{1};
  bool _hasOccurrences = false;
};
}
