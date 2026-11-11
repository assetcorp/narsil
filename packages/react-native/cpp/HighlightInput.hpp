#pragma once

#include "TypedElements.hpp"
#include "narsil_highlight.h"

#include <cmath>
#include <memory>
#include <vector>

namespace margelo::nitro::narsil {

inline uint32_t highlightWhole(const jsi::Value& value) {
  if (!value.isNumber()) throwInvalid("A highlight count must be a number");
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) {
    throwInvalid("A highlight count must be an unsigned 32-bit integer");
  }
  return static_cast<uint32_t>(number);
}

inline narsil_highlight_text highlightText(Elements<const uint16_t> value) {
  static constexpr uint16_t empty = 0;
  return {value.length == 0 ? &empty : value.data, value.length};
}

class HighlightInput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("A highlight query must be an object");
    auto object = value.getObject(runtime);
    auto terms = arrayOf(runtime, object.getProperty(runtime, "terms"));
    auto synonyms = arrayOf(runtime, object.getProperty(runtime, "synonyms"));
    auto partial = object.getProperty(runtime, "partialWords");
    auto prefix = object.getProperty(runtime, "prefix");
    _prefixLength = highlightWhole(object.getProperty(runtime, "prefixLength"));
    size_t termCount = terms.size(runtime);
    size_t synonymCount = synonyms.size(runtime);
    size_t partialCount = 0;
    std::optional<jsi::Array> partialArray;
    if (!partial.isNull()) {
      partialArray.emplace(arrayOf(runtime, partial));
      partialCount = partialArray->size(runtime);
    }
    if (termCount > UINT32_MAX || synonymCount > UINT32_MAX || partialCount > UINT32_MAX ||
        termCount > SIZE_MAX - synonymCount || termCount + synonymCount >= SIZE_MAX - partialCount) {
      throwInvalid("A highlight query has too many words");
    }
    _terms.resize(termCount);
    _synonyms.resize(synonymCount);
    _partial.resize(partialCount);
    _regions = std::make_unique<TypedElements>(termCount + synonymCount + partialCount + 1);
    _hasPrefix = !prefix.isNull();
    if (_hasPrefix) _regions->prepare(runtime, 0, prefix);
    for (size_t at = 0; at < termCount; at++) {
      auto entry = terms.getValueAtIndex(runtime, at);
      if (!entry.isObject()) throwInvalid("A highlight term must be an object");
      auto term = entry.getObject(runtime);
      _terms[at].tolerance = highlightWhole(term.getProperty(runtime, "tolerance"));
      _regions->prepare(runtime, at + 1, term.getProperty(runtime, "term"));
    }
    for (size_t at = 0; at < synonymCount; at++) {
      _regions->prepare(runtime, termCount + at + 1, synonyms.getValueAtIndex(runtime, at));
    }
    for (size_t at = 0; at < partialCount; at++) {
      _regions->prepare(runtime, termCount + synonymCount + at + 1, partialArray->getValueAtIndex(runtime, at));
    }
  }

  narsil_highlight_query read(jsi::Runtime& runtime) {
    narsil_highlight_text prefix{nullptr, 0};
    if (_hasPrefix) prefix = textAt(runtime, 0);
    for (size_t at = 0; at < _terms.size(); at++) _terms[at].text = textAt(runtime, at + 1);
    for (size_t at = 0; at < _synonyms.size(); at++) _synonyms[at] = textAt(runtime, _terms.size() + at + 1);
    for (size_t at = 0; at < _partial.size(); at++) {
      _partial[at] = textAt(runtime, _terms.size() + _synonyms.size() + at + 1);
    }
    return {_terms.data(), _terms.size(), _prefixLength, prefix,
      _synonyms.data(), _synonyms.size(), _partial.data(), _partial.size()};
  }

private:
  static jsi::Array arrayOf(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject() || !value.getObject(runtime).isArray(runtime)) {
      throwInvalid("Highlight words must be an array");
    }
    return value.getObject(runtime).getArray(runtime);
  }

  narsil_highlight_text textAt(jsi::Runtime& runtime, size_t at) {
    return highlightText(_regions->read<const uint16_t>(runtime, at, "The highlight word"));
  }

  std::unique_ptr<TypedElements> _regions;
  std::vector<narsil_highlight_term> _terms;
  std::vector<narsil_highlight_text> _synonyms;
  std::vector<narsil_highlight_text> _partial;
  uint32_t _prefixLength = 0;
  bool _hasPrefix = false;
};

}
