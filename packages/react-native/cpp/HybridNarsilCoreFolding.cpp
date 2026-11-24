#include "ArgumentValues.hpp"
#include "ExpansionInput.hpp"
#include "HybridNarsilCoreImpl.hpp"
#include "PartialInput.hpp"
#include "narsil_expansion.h"
#include "narsil_folding.h"

#include <cerrno>
#include <memory>
#include <new>
#include <optional>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {
namespace {

enum FoldSpellingArgument : size_t { FOLD_LANGUAGE, FOLD_FLAGS, FOLD_TEXT };

enum FoldedTermsArgument : size_t {
  TERMS_SOURCES,
  TERMS_TABLES,
  TERMS_LANGUAGE,
  TERMS_WORDS,
  TERMS_SEGMENTS,
  TERMS_TOKENS,
  TERMS_STARTS
};

enum FoldedPrefixArgument : size_t {
  PREFIX_SOURCES,
  PREFIX_TABLES,
  PREFIX_LANGUAGE,
  PREFIX_TYPED,
  PREFIX_STEMMED,
  PREFIX_OWN,
  PREFIX_FOLDED,
  PREFIX_SEGMENTS,
  PREFIX_TOKENS,
  PREFIX_FACTORS
};

enum FoldedPartialArgument : size_t {
  PARTIAL_SOURCES,
  PARTIAL_TABLES,
  PARTIAL_LANGUAGE,
  PARTIAL_WORDS,
  PARTIAL_FOLDED,
  PARTIAL_STARTS,
  PARTIAL_SEGMENTS,
  PARTIAL_TOKENS,
  PARTIAL_FACTORS
};

class FoldTableState final : public jsi::NativeState {
public:
  FoldTableState() = default;
  ~FoldTableState() override { narsil_fold_table_destroy(table); }
  FoldTableState(const FoldTableState&) = delete;
  FoldTableState& operator=(const FoldTableState&) = delete;
  narsil_fold_table* table = nullptr;
};

class FoldTables {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value, size_t sources) {
    auto list = arrayValue(runtime, value, "The fold tables");
    size_t count = list.size(runtime);
    if (count != sources) throwInvalid("The fold tables must match the sources one for one");
    _held.reserve(count);
    _tables.reserve(count);
    for (size_t at = 0; at < count; at++) {
      auto entry = list.getValueAtIndex(runtime, at);
      if (!entry.isObject() || !entry.getObject(runtime).hasNativeState<FoldTableState>(runtime)) {
        throwInvalid("A fold table must come from createFoldTable");
      }
      auto state = entry.getObject(runtime).getNativeState<FoldTableState>(runtime);
      _tables.push_back(state->table);
      _held.push_back(std::move(state));
    }
  }

  narsil_fold_table* const* data() const { return _tables.data(); }

private:
  std::vector<std::shared_ptr<FoldTableState>> _held;
  std::vector<narsil_fold_table*> _tables;
};

class FoldedWord {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("The folded word must be an object");
    auto object = value.getObject(runtime);
    _text.prepare(runtime, 0, object.getProperty(runtime, "key"));
    _text.prepare(runtime, 1, object.getProperty(runtime, "own"));
    auto excluded = arrayValue(runtime, object.getProperty(runtime, "excluded"), "The excluded words");
    size_t count = excluded.size(runtime);
    _excluded.emplace(count);
    for (size_t at = 0; at < count; at++) _excluded->prepare(runtime, at, excluded.getValueAtIndex(runtime, at));
    _terms.resize(count);
    _tolerance = wholeNumber(object.getProperty(runtime, "tolerance"), "The folded word tolerance");
    _prefixLength = wholeNumber(object.getProperty(runtime, "prefixLength"), "The folded word prefix length");
  }

  narsil_folded_word read(jsi::Runtime& runtime) {
    auto key = _text.read<const uint16_t>(runtime, 0, "The folded key");
    auto own = _text.read<const uint16_t>(runtime, 1, "The query token");
    for (size_t at = 0; at < _terms.size(); at++) {
      auto units = _excluded->read<const uint16_t>(runtime, at, "An excluded word");
      _terms[at] = {units.data, units.length};
    }
    return {key.data, key.length, own.data, own.length, _terms.data(), _terms.size(), _tolerance, _prefixLength};
  }

private:
  TypedElements _text{2};
  std::optional<TypedElements> _excluded;
  std::vector<narsil_term> _terms;
  uint32_t _tolerance = 0;
  uint32_t _prefixLength = 0;
};

template <typename Input>
std::vector<Input> preparedList(jsi::Runtime& runtime, const jsi::Value& value, const char* what) {
  auto list = arrayValue(runtime, value, what);
  std::vector<Input> inputs(list.size(runtime));
  for (size_t at = 0; at < inputs.size(); at++) inputs[at].prepare(runtime, list.getValueAtIndex(runtime, at));
  return inputs;
}

jsi::Value countOrStatus(narsil_status status, uint32_t written) {
  return status == NARSIL_OK ? jsi::Value(static_cast<double>(written)) : statusValue(status);
}

template <typename Body>
jsi::Value refusedAsStatus(Body&& body) {
  try {
    return body();
  } catch (const std::invalid_argument&) {
    return statusValue(NARSIL_INVALID_ARGUMENT);
  } catch (const std::length_error&) {
    return statusValue(NARSIL_INVALID_ARGUMENT);
  } catch (const std::bad_alloc&) {
    return statusValue(NARSIL_OUT_OF_MEMORY);
  }
}

}

narsil_status HybridNarsilCoreImpl::updateFoldTables(jsi::Runtime& runtime, narsil_fold_table* const* tables,
                                                     const narsil_expansion_segment* segments, size_t count,
                                                     uint32_t language, narsil_workspace** workspace) {
  RuntimeState& held = stateOf(runtime);
  if (held.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    narsil_status status = narsil_workspace_create(&created);
    if (status != NARSIL_OK) return status;
    held.keywordWorkspace.reset(created);
  }
  narsil_analyser* analyser = analyserOf(held.analyser);
  if (analyser == nullptr) return NARSIL_OUT_OF_MEMORY;
  for (size_t at = 0; at < count; at++) {
    narsil_status status =
        narsil_fold_table_update(held.keywordWorkspace.get(), analyser, tables[at], segments + at, language);
    if (status != NARSIL_OK) return status;
  }
  *workspace = held.keywordWorkspace.get();
  return NARSIL_OK;
}

jsi::Value HybridNarsilCoreImpl::createFoldTable(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value*,
                                                 size_t) {
  auto state = std::make_shared<FoldTableState>();
  narsil_status status = narsil_fold_table_create(&state->table);
  if (status == NARSIL_OUT_OF_MEMORY) throwSystemError(ENOMEM, "hold a fold table", "");
  if (status != NARSIL_OK) throwInvalid("The core cannot create a fold table");
  jsi::Object handle(runtime);
  handle.setNativeState(runtime, state);
  return handle;
}

jsi::Value HybridNarsilCoreImpl::foldSpelling(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* arguments,
                                              size_t count) {
  if (count < FOLD_SPELLING_ARGUMENT_COUNT) throwInvalid("foldSpelling takes three arguments");
  uint32_t language = languageArgument(arguments, count, FOLD_LANGUAGE);
  uint32_t flags = wholeArgument(arguments, count, FOLD_FLAGS, "The fold flags");
  RuntimeState& analysis = stateOf(runtime);
  readText(runtime, arguments[FOLD_TEXT], "The spelling", analysis.textUnits);
  narsil_analyser* active = analyserOf(analysis.analyser);
  if (active == nullptr) return statusValue(NARSIL_OUT_OF_MEMORY);
  narsil_term term = {nullptr, 0};
  narsil_status status = narsil_fold_spelling(active, language, analysis.textUnits.data(),
                                              static_cast<uint32_t>(analysis.textUnits.size()), flags, &term);
  if (status != NARSIL_OK) return statusValue(status);
  return textOf(runtime, analysis.textOut, term.units, term.length);
}

jsi::Value HybridNarsilCoreImpl::expandFoldedTerms(jsi::Runtime& runtime, const jsi::Value&,
                                                   const jsi::Value* arguments, size_t count) {
  return refusedAsStatus([&] {
    if (count != EXPAND_FOLDED_TERMS_ARGUMENT_COUNT) return statusValue(NARSIL_INVALID_ARGUMENT);
    uint32_t language = languageArgument(arguments, count, TERMS_LANGUAGE);
    auto inputs = preparedList<ExpansionInput>(runtime, arguments[TERMS_SOURCES], "The folded sources");
    FoldTables tables;
    tables.prepare(runtime, arguments[TERMS_TABLES], inputs.size());
    auto queries = preparedList<FoldedWord>(runtime, arguments[TERMS_WORDS], "The folded words");
    TypedElements regions(EXPAND_FOLDED_TERMS_ARGUMENT_COUNT - TERMS_SEGMENTS);
    for (size_t at = TERMS_SEGMENTS; at < count; at++) regions.prepare(runtime, at - TERMS_SEGMENTS, arguments[at]);
    std::vector<narsil_expansion_segment> sources(inputs.size());
    std::vector<narsil_folded_word> words(queries.size());
    for (size_t at = 0; at < inputs.size(); at++) sources[at] = inputs[at].read(runtime);
    for (size_t at = 0; at < queries.size(); at++) words[at] = queries[at].read(runtime);
    auto segments = regions.read<uint32_t>(runtime, TERMS_SEGMENTS - TERMS_SEGMENTS, "The folded word sources");
    auto tokens = regions.read<uint32_t>(runtime, TERMS_TOKENS - TERMS_SEGMENTS, "The folded word tokens");
    auto starts = regions.read<uint32_t>(runtime, TERMS_STARTS - TERMS_SEGMENTS, "The folded word offsets");
    narsil_workspace* workspace = nullptr;
    narsil_status status =
        updateFoldTables(runtime, tables.data(), sources.data(), sources.size(), language, &workspace);
    if (status != NARSIL_OK) return statusValue(status);
    narsil_folded_request request{sources.data(), tables.data(), sources.size(), words.data(), words.size()};
    narsil_folded_output output{segments.data, segments.length, tokens.data, tokens.length,
                                starts.data,   starts.length};
    uint32_t written = 0;
    status = narsil_expand_folded_terms(workspace, &request, &output, &written);
    return countOrStatus(status, written);
  });
}

jsi::Value HybridNarsilCoreImpl::expandFoldedPrefix(jsi::Runtime& runtime, const jsi::Value&,
                                                    const jsi::Value* arguments, size_t count) {
  return refusedAsStatus([&] {
    if (count != EXPAND_FOLDED_PREFIX_ARGUMENT_COUNT) return statusValue(NARSIL_INVALID_ARGUMENT);
    uint32_t language = languageArgument(arguments, count, PREFIX_LANGUAGE);
    auto inputs = preparedList<ExpansionInput>(runtime, arguments[PREFIX_SOURCES], "The folded sources");
    FoldTables tables;
    tables.prepare(runtime, arguments[PREFIX_TABLES], inputs.size());
    TypedElements regions(EXPAND_FOLDED_PREFIX_ARGUMENT_COUNT - PREFIX_TYPED);
    for (size_t at = PREFIX_TYPED; at < count; at++) regions.prepare(runtime, at - PREFIX_TYPED, arguments[at]);
    std::vector<narsil_expansion_segment> sources(inputs.size());
    for (size_t at = 0; at < inputs.size(); at++) sources[at] = inputs[at].read(runtime);
    auto typed = regions.read<const uint16_t>(runtime, PREFIX_TYPED - PREFIX_TYPED, "The prefix text");
    auto stemmed = regions.read<const uint16_t>(runtime, PREFIX_STEMMED - PREFIX_TYPED, "The stemmed prefix");
    auto own = regions.read<const uint16_t>(runtime, PREFIX_OWN - PREFIX_TYPED, "The query token");
    auto folded = regions.read<const uint16_t>(runtime, PREFIX_FOLDED - PREFIX_TYPED, "The folded prefix");
    auto segments = regions.read<uint32_t>(runtime, PREFIX_SEGMENTS - PREFIX_TYPED, "The completion sources");
    auto tokens = regions.read<uint32_t>(runtime, PREFIX_TOKENS - PREFIX_TYPED, "The completion tokens");
    auto factors = regions.read<double>(runtime, PREFIX_FACTORS - PREFIX_TYPED, "The completion factors");
    narsil_workspace* workspace = nullptr;
    narsil_status status =
        updateFoldTables(runtime, tables.data(), sources.data(), sources.size(), language, &workspace);
    if (status != NARSIL_OK) return statusValue(status);
    narsil_folded_prefix_request request{
        {sources.data(), sources.size(), typed.data, typed.length, stemmed.data, stemmed.length, own.data, own.length},
        tables.data(),
        folded.data,
        folded.length};
    narsil_expansion_output output{segments.data, segments.length, tokens.data, tokens.length,
                                   factors.data,  factors.length};
    uint32_t written = 0;
    status = narsil_expand_folded_prefix(workspace, &request, &output, &written);
    return countOrStatus(status, written);
  });
}

jsi::Value HybridNarsilCoreImpl::expandFoldedPartialWords(jsi::Runtime& runtime, const jsi::Value&,
                                                          const jsi::Value* arguments, size_t count) {
  return refusedAsStatus([&] {
    if (count != EXPAND_FOLDED_PARTIAL_ARGUMENT_COUNT) return statusValue(NARSIL_INVALID_ARGUMENT);
    uint32_t language = languageArgument(arguments, count, PARTIAL_LANGUAGE);
    auto inputs = preparedList<PartialInput>(runtime, arguments[PARTIAL_SOURCES], "The partial-word sources");
    FoldTables tables;
    tables.prepare(runtime, arguments[PARTIAL_TABLES], inputs.size());
    auto queries = preparedList<PartialWord>(runtime, arguments[PARTIAL_WORDS], "The partial-word requests");
    auto foldedList = arrayValue(runtime, arguments[PARTIAL_FOLDED], "The folded partial words");
    if (foldedList.size(runtime) != queries.size()) throwInvalid("Every partial-word request needs its folded text");
    TypedElements foldedTexts(queries.size());
    for (size_t at = 0; at < queries.size(); at++) {
      foldedTexts.prepare(runtime, at, foldedList.getValueAtIndex(runtime, at));
    }
    TypedElements regions(EXPAND_FOLDED_PARTIAL_ARGUMENT_COUNT - PARTIAL_STARTS);
    for (size_t at = PARTIAL_STARTS; at < count; at++) regions.prepare(runtime, at - PARTIAL_STARTS, arguments[at]);
    std::vector<narsil_expansion_segment> sources(inputs.size());
    std::vector<narsil_frozen_runs> runs(inputs.size());
    std::vector<narsil_partial_word> words(queries.size());
    std::vector<narsil_term> folded(queries.size());
    for (size_t at = 0; at < inputs.size(); at++) sources[at] = inputs[at].read(runtime, runs[at]);
    for (size_t at = 0; at < queries.size(); at++) {
      words[at] = queries[at].read(runtime);
      auto units = foldedTexts.read<const uint16_t>(runtime, at, "The folded partial word");
      folded[at] = {units.data, units.length};
    }
    auto starts = regions.read<uint32_t>(runtime, PARTIAL_STARTS - PARTIAL_STARTS, "The addition offsets");
    auto segments = regions.read<uint32_t>(runtime, PARTIAL_SEGMENTS - PARTIAL_STARTS, "The addition sources");
    auto tokens = regions.read<uint32_t>(runtime, PARTIAL_TOKENS - PARTIAL_STARTS, "The addition tokens");
    auto factors = regions.read<double>(runtime, PARTIAL_FACTORS - PARTIAL_STARTS, "The addition factors");
    narsil_workspace* workspace = nullptr;
    narsil_status status =
        updateFoldTables(runtime, tables.data(), sources.data(), sources.size(), language, &workspace);
    if (status != NARSIL_OK) return statusValue(status);
    narsil_folded_partial_request request{
        {sources.data(), runs.data(), sources.size(), words.data(), words.size()}, tables.data(), folded.data()};
    narsil_partial_output output{
        {segments.data, segments.length, tokens.data, tokens.length, factors.data, factors.length},
        starts.data,
        starts.length};
    uint32_t written = 0;
    status = narsil_expand_folded_partial_words(workspace, &request, &output, &written);
    return countOrStatus(status, written);
  });
}

}
