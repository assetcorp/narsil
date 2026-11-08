#include "HybridNarsilCoreImpl.hpp"
#include "TermRegions.hpp"
#include "narsil_terms.h"

#include <cmath>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {
namespace {
bool unsignedTermArgument(const jsi::Value& value, uint32_t& into) {
  if (!value.isNumber()) return false;
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) return false;
  into = static_cast<uint32_t>(number);
  return true;
}
}

jsi::Value HybridNarsilCoreImpl::lookupTerms(jsi::Runtime& runtime, const jsi::Value* arguments,
                                           size_t count, uint32_t operation) try {
  size_t required = LOOKUP_EXACT_ARGUMENT_COUNT;
  if (operation == NARSIL_LOOKUP_PREFIX) required = LOOKUP_PREFIX_ARGUMENT_COUNT;
  if (operation == NARSIL_LOOKUP_TYPO) required = LOOKUP_TYPO_ARGUMENT_COUNT;
  if (count != required) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  narsil_term_lookup request{};
  request.operation = operation;
  if (operation == NARSIL_LOOKUP_PREFIX && !unsignedTermArgument(arguments[2], request.limit)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  if (operation == NARSIL_LOOKUP_TYPO &&
      (!unsignedTermArgument(arguments[2], request.tolerance) || !unsignedTermArgument(arguments[3], request.prefix_length))) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TermRegions regions;
  regions.prepare(runtime, arguments[0]);
  regions.views.prepare(runtime, TermRegions::TEXT, arguments[1]);
  regions.views.prepare(runtime, TermRegions::OUTPUT, arguments[required - 1]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  narsil_term_table table{};
  auto dictionary = regions.read(runtime, table);
  auto text = regions.views.read<const uint16_t>(runtime, TermRegions::TEXT, "The lookup text");
  auto output = regions.views.read<uint32_t>(runtime, TermRegions::OUTPUT, "The lookup ordinals");
  request.dictionary = &dictionary;
  request.text = text.data;
  request.text_length = text.length;
  uint32_t found = 0;
  narsil_status status = narsil_lookup_terms(state.keywordWorkspace.get(), &request, output.data, output.length, &found);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(found) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::lookupExact(jsi::Runtime& runtime, const jsi::Value&,
                                           const jsi::Value* arguments, size_t count) {
  return lookupTerms(runtime, arguments, count, NARSIL_LOOKUP_EXACT);
}

jsi::Value HybridNarsilCoreImpl::lookupExactBatch(jsi::Runtime& runtime, const jsi::Value&,
                                                const jsi::Value* arguments, size_t count) try {
  if (count != LOOKUP_EXACT_BATCH_ARGUMENT_COUNT) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  TermRegions regions;
  regions.prepare(runtime, arguments[0]);
  regions.views.prepare(runtime, TermRegions::TEXT, arguments[1]);
  regions.views.prepare(runtime, TermRegions::BOUNDARIES, arguments[2]);
  regions.views.prepare(runtime, TermRegions::OUTPUT, arguments[3]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  narsil_term_table table{};
  auto dictionary = regions.read(runtime, table);
  auto units = regions.views.read<const uint16_t>(runtime, TermRegions::TEXT, "The query terms");
  auto offsets = regions.views.read<const uint32_t>(runtime, TermRegions::BOUNDARIES, "The query term offsets");
  auto output = regions.views.read<uint32_t>(runtime, TermRegions::OUTPUT, "The query term ordinals");
  narsil_status status = narsil_lookup_exact_batch(state.keywordWorkspace.get(), &dictionary, units.data, units.length,
                                                   offsets.data, offsets.length, output.data, output.length);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(offsets.length - 1) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::lookupPrefix(jsi::Runtime& runtime, const jsi::Value&,
                                            const jsi::Value* arguments, size_t count) {
  return lookupTerms(runtime, arguments, count, NARSIL_LOOKUP_PREFIX);
}

jsi::Value HybridNarsilCoreImpl::lookupTypo(jsi::Runtime& runtime, const jsi::Value&,
                                          const jsi::Value* arguments, size_t count) {
  return lookupTerms(runtime, arguments, count, NARSIL_LOOKUP_TYPO);
}

jsi::Value HybridNarsilCoreImpl::documentFrequency(jsi::Runtime& runtime, const jsi::Value&,
                                                 const jsi::Value* arguments, size_t count) try {
  uint32_t ordinal = 0;
  if (count != DOCUMENT_FREQUENCY_ARGUMENT_COUNT || !unsignedTermArgument(arguments[1], ordinal)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TermRegions regions;
  regions.prepare(runtime, arguments[0]);
  regions.views.prepare(runtime, TermRegions::OUTPUT, arguments[2]);
  narsil_term_table table{};
  auto dictionary = regions.read(runtime, table);
  auto output = regions.views.read<uint32_t>(runtime, TermRegions::OUTPUT, "The live document frequency");
  return jsi::Value(-static_cast<double>(narsil_document_frequency(&dictionary, ordinal, output.data, output.length)));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
