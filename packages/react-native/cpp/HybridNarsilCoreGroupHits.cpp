#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_groups.h"
#include "narsil_stored_values.h"

#include <array>
#include <cmath>
#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {

namespace {

enum GroupArgument : size_t { VALUES, ORDINALS, SCORES, ID_RANKS, MAXIMUM, LIMIT, HEADS, OFFSETS, HITS, MEMBERS, ARGUMENT_COUNT };
enum FieldRegion : size_t { SHAPES, STARTS, KINDS, NUMBERS, TEXT_START, TEXT_LENGTH, UNITS, BYTES, FIELD_REGIONS };
static_assert(ARGUMENT_COUNT == GROUP_HITS_ARGUMENT_COUNT);

constexpr std::array<const char*, FIELD_REGIONS> FIELD_PROPERTIES{
    "shapes", "starts", "kinds", "numbers", "textStart", "textLength", "units", "bytes"};
constexpr std::array<size_t, 7> REGION_ARGUMENTS{ORDINALS, SCORES, ID_RANKS, HEADS, OFFSETS, HITS, MEMBERS};

bool unsignedArgument(const jsi::Value& value, uint32_t& into) {
  if (!value.isNumber()) return false;
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) return false;
  into = static_cast<uint32_t>(number);
  return true;
}

narsil_stored_values readField(jsi::Runtime& runtime, TypedElements& views, size_t offset) {
  auto shapes = views.read<const uint8_t>(runtime, offset + SHAPES, "The stored shapes");
  auto starts = views.read<const uint32_t>(runtime, offset + STARTS, "The stored starts");
  auto kinds = views.read<const uint8_t>(runtime, offset + KINDS, "The stored kinds");
  auto numbers = views.read<const double>(runtime, offset + NUMBERS, "The stored numbers");
  auto textStart = views.read<const uint32_t>(runtime, offset + TEXT_START, "The stored text starts");
  auto textLength = views.read<const uint32_t>(runtime, offset + TEXT_LENGTH, "The stored text lengths");
  auto units = views.read<const uint16_t>(runtime, offset + UNITS, "The stored code units");
  auto bytes = views.read<const uint8_t>(runtime, offset + BYTES, "The stored encoded bytes");
  return {shapes.data, shapes.length, starts.data, starts.length, kinds.data, kinds.length, numbers.data, numbers.length,
          textStart.data, textStart.length, textLength.data, textLength.length, units.data, units.length, bytes.data, bytes.length};
}

}

jsi::Value HybridNarsilCoreImpl::groupHits(jsi::Runtime& runtime, const jsi::Value&,
                                         const jsi::Value* arguments, size_t count) try {
  narsil_group_request request{};
  if (count != ARGUMENT_COUNT || !unsignedArgument(arguments[MAXIMUM], request.max_per_group) ||
      !arguments[VALUES].isObject() || !arguments[VALUES].getObject(runtime).isArray(runtime)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  request.has_limit = arguments[LIMIT].isNull() ? 0U : 1U;
  if (request.has_limit != 0 && !unsignedArgument(arguments[LIMIT], request.limit)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  jsi::Array fields = arguments[VALUES].getObject(runtime).getArray(runtime);
  size_t fieldCount = fields.size(runtime);
  if (fieldCount > UINT32_MAX || fieldCount > SIZE_MAX / FIELD_REGIONS) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TypedElements fieldViews(fieldCount * FIELD_REGIONS);
  for (size_t field = 0; field < fieldCount; field++) {
    jsi::Value value = fields.getValueAtIndex(runtime, field);
    if (!value.isObject()) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
    jsi::Object descriptor = value.getObject(runtime);
    for (size_t region = 0; region < FIELD_REGIONS; region++) {
      fieldViews.prepare(runtime, field * FIELD_REGIONS + region, descriptor.getProperty(runtime, FIELD_PROPERTIES[region]));
    }
  }
  TypedElements views(ARGUMENT_COUNT);
  for (size_t argument : REGION_ARGUMENTS) views.prepare(runtime, argument, arguments[argument]);
  std::vector<narsil_stored_values> descriptors(fieldCount);
  for (size_t field = 0; field < fieldCount; field++) descriptors[field] = readField(runtime, fieldViews, field * FIELD_REGIONS);
  auto ordinals = views.read<const uint32_t>(runtime, ORDINALS, "The hit ordinals");
  auto scores = views.read<const double>(runtime, SCORES, "The hit scores");
  auto idRanks = views.read<const uint32_t>(runtime, ID_RANKS, "The document ID ranks");
  auto heads = views.read<uint32_t>(runtime, HEADS, "The group heads");
  auto offsets = views.read<uint32_t>(runtime, OFFSETS, "The group offsets");
  auto hits = views.read<uint32_t>(runtime, HITS, "The retained hit positions");
  auto members = views.read<uint32_t>(runtime, MEMBERS, "The full member counts");
  request.values = descriptors.data();
  request.value_count = descriptors.size();
  request.ordinals = ordinals.data;
  request.ordinal_count = ordinals.length;
  request.scores = scores.data;
  request.score_count = scores.length;
  request.id_ranks = idRanks.data;
  request.id_rank_count = idRanks.length;
  narsil_group_output output{heads.data, heads.length, offsets.data, offsets.length,
                             hits.data, hits.length, members.data, members.length, 0};
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  narsil_status status = narsil_group_hits(state.keywordWorkspace.get(), &request, &output);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(output.count) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
