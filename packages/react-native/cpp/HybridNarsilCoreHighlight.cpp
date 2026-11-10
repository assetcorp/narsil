#include "HighlightInput.hpp"
#include "HybridNarsilCoreImpl.hpp"
#include "narsil_highlight.h"

#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::highlight(jsi::Runtime& runtime, const jsi::Value&,
                                          const jsi::Value* arguments, size_t count) try {
  if (count != HIGHLIGHT_ARGUMENT_COUNT) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  uint32_t language = highlightWhole(arguments[0]);
  uint32_t maximum = highlightWhole(arguments[5]);
  HighlightInput query;
  query.prepare(runtime, arguments[2]);
  TypedElements regions(HIGHLIGHT_ARGUMENT_COUNT);
  for (size_t at = 1; at < count; at++) {
    if (at != 2 && at != 5) regions.prepare(runtime, at, arguments[at]);
  }
  auto& held = stateOf(runtime);
  if (held.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    narsil_status status = narsil_workspace_create(&created);
    if (status != NARSIL_OK) return jsi::Value(-static_cast<double>(status));
    held.keywordWorkspace.reset(created);
  }
  if (held.analyser == nullptr) {
    narsil_analyser* created = nullptr;
    narsil_status status = narsil_analyser_create(&created);
    if (status != NARSIL_OK) return jsi::Value(-static_cast<double>(status));
    held.analyser.reset(created);
  }
  auto text = regions.read<const uint16_t>(runtime, 1, "The highlight text");
  auto preTag = regions.read<const uint16_t>(runtime, 3, "The opening tag");
  auto postTag = regions.read<const uint16_t>(runtime, 4, "The closing tag");
  auto snippet = regions.read<uint16_t>(runtime, 6, "The snippet output");
  auto positions = regions.read<uint32_t>(runtime, 7, "The position output");
  auto length = regions.read<uint32_t>(runtime, 8, "The snippet length output");
  narsil_highlight_request request{language, highlightText(text), query.read(runtime),
    highlightText(preTag), highlightText(postTag), maximum};
  narsil_highlight_output output{snippet.data, snippet.length, positions.data, positions.length, length.data, length.length};
  uint32_t written = 0;
  narsil_status status = narsil_highlight(held.analyser.get(), held.keywordWorkspace.get(), &request, &output, &written);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(written) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
