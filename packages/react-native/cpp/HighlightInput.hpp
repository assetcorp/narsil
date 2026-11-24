#pragma once

#include "TypedElements.hpp"
#include "narsil_highlight.h"

#include <cmath>
#include <memory>
#include <optional>
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
    auto partial = optionalArrayOf(runtime, object.getProperty(runtime, "partialWords"));
    auto prefix = object.getProperty(runtime, "prefix");
    auto folded = object.getProperty(runtime, "folded");
    _prefixLength = highlightWhole(object.getProperty(runtime, "prefixLength"));
    _hasFolded = !folded.isNull();
    std::optional<jsi::Array> keys;
    std::optional<jsi::Array> foldedPartial;
    jsi::Value foldedPrefix = jsi::Value::null();
    if (_hasFolded) {
      if (!folded.isObject()) throwInvalid("A folded highlight must be an object or null");
      auto foldedObject = folded.getObject(runtime);
      keys.emplace(arrayOf(runtime, foldedObject.getProperty(runtime, "keys")));
      foldedPartial = optionalArrayOf(runtime, foldedObject.getProperty(runtime, "partialWords"));
      foldedPrefix = foldedObject.getProperty(runtime, "prefix");
    }
    _terms.resize(countOf(runtime, terms));
    _synonyms.resize(countOf(runtime, synonyms));
    _partial.resize(countOf(runtime, partial));
    _keys.resize(countOf(runtime, keys));
    _foldedPartial.resize(countOf(runtime, foldedPartial));
    size_t slots = 2;
    for (size_t count : {_terms.size(), _synonyms.size(), _partial.size(), _keys.size(), _foldedPartial.size()}) {
      if (count > SIZE_MAX - slots) throwInvalid("A highlight query has too many words");
      slots += count;
    }
    _regions = std::make_unique<TypedElements>(slots);
    _hasPrefix = !prefix.isNull();
    _hasFoldedPrefix = !foldedPrefix.isNull();
    if (_hasPrefix) _regions->prepare(runtime, PREFIX_SLOT, prefix);
    if (_hasFoldedPrefix) _regions->prepare(runtime, FOLDED_PREFIX_SLOT, foldedPrefix);
    size_t next = FIRST_WORD_SLOT;
    prepareTerms(runtime, terms, "term", _terms, next);
    prepareTexts(runtime, synonyms, _synonyms.size(), next);
    if (partial) prepareTexts(runtime, *partial, _partial.size(), next);
    if (keys) prepareTerms(runtime, *keys, "key", _keys, next);
    if (foldedPartial) prepareTexts(runtime, *foldedPartial, _foldedPartial.size(), next);
  }

  narsil_highlight_query read(jsi::Runtime& runtime) {
    narsil_highlight_text prefix{nullptr, 0};
    if (_hasPrefix) prefix = textAt(runtime, PREFIX_SLOT);
    size_t next = FIRST_WORD_SLOT;
    for (auto& term : _terms) term.text = textAt(runtime, next++);
    for (auto& synonym : _synonyms) synonym = textAt(runtime, next++);
    for (auto& word : _partial) word = textAt(runtime, next++);
    for (auto& key : _keys) key.text = textAt(runtime, next++);
    for (auto& word : _foldedPartial) word = textAt(runtime, next++);
    const narsil_folded_highlight* folded = nullptr;
    if (_hasFolded) {
      narsil_highlight_text foldedPrefix{nullptr, 0};
      if (_hasFoldedPrefix) foldedPrefix = textAt(runtime, FOLDED_PREFIX_SLOT);
      _folded = {_keys.data(), _keys.size(), foldedPrefix, _foldedPartial.data(), _foldedPartial.size()};
      folded = &_folded;
    }
    return {_terms.data(), _terms.size(), _prefixLength, prefix, _synonyms.data(), _synonyms.size(),
      _partial.data(), _partial.size(), folded};
  }

private:
  static constexpr size_t PREFIX_SLOT = 0;
  static constexpr size_t FOLDED_PREFIX_SLOT = 1;
  static constexpr size_t FIRST_WORD_SLOT = 2;

  static jsi::Array arrayOf(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject() || !value.getObject(runtime).isArray(runtime)) {
      throwInvalid("Highlight words must be an array");
    }
    return value.getObject(runtime).getArray(runtime);
  }

  static std::optional<jsi::Array> optionalArrayOf(jsi::Runtime& runtime, const jsi::Value& value) {
    if (value.isNull()) return std::nullopt;
    return arrayOf(runtime, value);
  }

  static size_t countOf(jsi::Runtime& runtime, const std::optional<jsi::Array>& list) {
    if (!list) return 0;
    size_t count = list->size(runtime);
    if (count > UINT32_MAX) throwInvalid("A highlight query has too many words");
    return count;
  }

  static size_t countOf(jsi::Runtime& runtime, const jsi::Array& list) {
    size_t count = list.size(runtime);
    if (count > UINT32_MAX) throwInvalid("A highlight query has too many words");
    return count;
  }

  void prepareTerms(jsi::Runtime& runtime, const jsi::Array& list, const char* textName,
    std::vector<narsil_highlight_term>& into, size_t& next) {
    for (size_t at = 0; at < into.size(); at++) {
      auto entry = list.getValueAtIndex(runtime, at);
      if (!entry.isObject()) throwInvalid("A highlight term must be an object");
      auto term = entry.getObject(runtime);
      into[at].tolerance = highlightWhole(term.getProperty(runtime, "tolerance"));
      _regions->prepare(runtime, next++, term.getProperty(runtime, textName));
    }
  }

  void prepareTexts(jsi::Runtime& runtime, const jsi::Array& list, size_t count, size_t& next) {
    for (size_t at = 0; at < count; at++) _regions->prepare(runtime, next++, list.getValueAtIndex(runtime, at));
  }

  narsil_highlight_text textAt(jsi::Runtime& runtime, size_t at) {
    return highlightText(_regions->read<const uint16_t>(runtime, at, "The highlight word"));
  }

  std::unique_ptr<TypedElements> _regions;
  std::vector<narsil_highlight_term> _terms;
  std::vector<narsil_highlight_text> _synonyms;
  std::vector<narsil_highlight_text> _partial;
  std::vector<narsil_highlight_term> _keys;
  std::vector<narsil_highlight_text> _foldedPartial;
  narsil_folded_highlight _folded{};
  uint32_t _prefixLength = 0;
  bool _hasPrefix = false;
  bool _hasFolded = false;
  bool _hasFoldedPrefix = false;
};

}
