#include "ExpansionInput.hpp"
#include "HybridNarsilCoreImpl.hpp"
#include "narsil_suggestions.h"

#include <cmath>
#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::suggestTerms(jsi::Runtime& runtime, const jsi::Value&,
                                             const jsi::Value* arguments, size_t count) try {
  if (count != SUGGEST_TERMS_ARGUMENT_COUNT || !arguments[0].isObject() ||
      !arguments[0].getObject(runtime).isArray(runtime) || !arguments[3].isNumber()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  double limit = arguments[3].getNumber();
  if (!std::isfinite(limit) || limit < 0 || limit > UINT32_MAX || std::floor(limit) != limit) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  auto array = arguments[0].getObject(runtime).getArray(runtime);
  size_t length = array.size(runtime);
  if (length > UINT32_MAX) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  std::vector<ExpansionInput> inputs(length);
  std::vector<narsil_expansion_segment> sources(length);
  for (size_t at = 0; at < length; at++) inputs[at].prepare(runtime, array.getValueAtIndex(runtime, at));
  TypedElements regions(SUGGEST_TERMS_ARGUMENT_COUNT);
  for (size_t at = 1; at < count; at++) {
    if (at != 3) regions.prepare(runtime, at, arguments[at]);
  }
  auto& held = stateOf(runtime);
  if (held.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    narsil_status status = narsil_workspace_create(&created);
    if (status != NARSIL_OK) return jsi::Value(-static_cast<double>(status));
    held.keywordWorkspace.reset(created);
  }
  for (size_t at = 0; at < length; at++) sources[at] = inputs[at].read(runtime);
  auto typed = regions.read<const uint16_t>(runtime, 1, "The suggestion prefix");
  auto stemmed = regions.read<const uint16_t>(runtime, 2, "The stemmed prefix");
  auto terms = regions.read<uint32_t>(runtime, 4, "The suggestion terms");
  auto starts = regions.read<uint32_t>(runtime, 5, "The spelling offsets");
  auto spellings = regions.read<uint32_t>(runtime, 6, "The suggested spellings");
  auto occurrences = regions.read<double>(runtime, 7, "The spelling occurrence counts");
  narsil_suggestion_request request{sources.data(), sources.size(), typed.data, typed.length,
    stemmed.data, stemmed.length, static_cast<uint32_t>(limit)};
  narsil_suggestion_output output{terms.data, terms.length, starts.data, starts.length,
    spellings.data, spellings.length, occurrences.data, occurrences.length};
  uint32_t written = 0;
  narsil_status status = narsil_suggest_terms(held.keywordWorkspace.get(), &request, &output, &written);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(written) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}
}
