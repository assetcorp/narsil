#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_pages.h"

#include <cmath>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

namespace {

enum PageArgument : size_t { COUNT, SORTED, SCORES, PRESENT, AFTER, ANCHOR, ARGUMENT_COUNT };
static_assert(ARGUMENT_COUNT == PAGE_START_ARGUMENT_COUNT);

}

jsi::Value HybridNarsilCoreImpl::pageStart(jsi::Runtime& runtime, const jsi::Value&,
                                         const jsi::Value* arguments, size_t count) try {
  if (count != ARGUMENT_COUNT || !arguments[COUNT].isNumber() || !arguments[SORTED].isBool() ||
      (!arguments[ANCHOR].isNull() && !arguments[ANCHOR].isNumber())) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  double logicalCount = arguments[COUNT].getNumber();
  if (!std::isfinite(logicalCount) || logicalCount < 0 || logicalCount > UINT32_MAX ||
      std::floor(logicalCount) != logicalCount) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  narsil_page_request request{};
  request.count = static_cast<uint32_t>(logicalCount);
  request.sorted = arguments[SORTED].getBool() ? 1U : 0U;
  request.has_scores = arguments[SCORES].isNull() ? 0U : 1U;
  request.has_anchor_score = arguments[ANCHOR].isNull() ? 0U : 1U;
  if (request.has_anchor_score != 0) request.anchor_score = arguments[ANCHOR].getNumber();
  bool hasPresent = !arguments[PRESENT].isNull();
  if (hasPresent && request.has_scores == 0) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  TypedElements views(ARGUMENT_COUNT);
  if (request.has_scores != 0) views.prepare(runtime, SCORES, arguments[SCORES]);
  if (hasPresent) views.prepare(runtime, PRESENT, arguments[PRESENT]);
  views.prepare(runtime, AFTER, arguments[AFTER]);
  if (request.has_scores != 0) {
    auto scores = views.read<const double>(runtime, SCORES, "The scores");
    request.scores = scores.data;
    request.scores_length = scores.length;
  }
  if (hasPresent) {
    auto present = views.read<const uint32_t>(runtime, PRESENT, "The score validity");
    if (present.length == 0) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
    request.score_present = present.data;
    request.score_present_length = present.length;
  }
  auto after = views.read<const uint32_t>(runtime, AFTER, "The anchor bitmap");
  request.after_anchor = after.data;
  request.after_anchor_length = after.length;
  uint32_t start = 0;
  narsil_status status = narsil_page_start(&request, &start);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(start) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
