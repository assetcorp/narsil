#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_pinned.h"

#include <cmath>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

namespace {

enum PinArgument : size_t { PIN_COUNT, PIN_RANKED, PIN_POSITIONS, PIN_DEPTH, PIN_OUTPUT, PIN_ARGUMENT_COUNT };

static_assert(PIN_ARGUMENT_COUNT == PINNED_ARGUMENT_COUNT);

bool unsignedArgument(const jsi::Value& value, uint32_t& into) {
  if (!value.isNumber()) return false;
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) return false;
  into = static_cast<uint32_t>(number);
  return true;
}

}

jsi::Value HybridNarsilCoreImpl::placePinned(jsi::Runtime& runtime, const jsi::Value&,
                                            const jsi::Value* arguments, size_t count) try {
  narsil_pinned_request request{};
  if (count != PIN_ARGUMENT_COUNT || !unsignedArgument(arguments[PIN_COUNT], request.count)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  request.has_depth = arguments[PIN_DEPTH].isNull() ? 0U : 1U;
  if (request.has_depth != 0 && !unsignedArgument(arguments[PIN_DEPTH], request.depth)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TypedElements views(PIN_ARGUMENT_COUNT);
  views.prepare(runtime, PIN_RANKED, arguments[PIN_RANKED]);
  views.prepare(runtime, PIN_POSITIONS, arguments[PIN_POSITIONS]);
  views.prepare(runtime, PIN_OUTPUT, arguments[PIN_OUTPUT]);
  auto ranked = views.read<const int32_t>(runtime, PIN_RANKED, "The ranked pin positions");
  auto positions = views.read<const uint32_t>(runtime, PIN_POSITIONS, "The requested pin positions");
  auto entries = views.read<int32_t>(runtime, PIN_OUTPUT, "The placed entries");
  request.ranked = ranked.data;
  request.ranked_count = ranked.length;
  request.positions = positions.data;
  request.position_count = positions.length;
  narsil_pinned_output output{entries.data, entries.length, 0};
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) {
      return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    }
    state.keywordWorkspace.reset(created);
  }
  narsil_status status = narsil_place_pinned(state.keywordWorkspace.get(), &request, &output);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(output.count) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
