#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_phrases.h"
#include "core/src/regions.h"

#include <array>
#include <cmath>
#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {
namespace {
enum { REQUEST, METER, STOP, DEADLINE, MATCHED, OUT_STARTS, OUT_DOCUMENTS, OUT_FIELDS, OUT_FREQUENCIES, ARGUMENT_COUNT };
enum { POSTINGS, STARTS, TOKENS, OFFSETS, SEARCHABLE, FILTER, REMOVED, ORDINAL_COUNT, COLLECT, PROPERTY_COUNT };
enum { DOCUMENTS, FIELDS, POSITION_STARTS, POSITION_COUNTS, POSITIONS, LIST_REGIONS };
static_assert(ARGUMENT_COUNT == MATCH_PHRASES_ARGUMENT_COUNT);

narsil_phrase_postings readList(jsi::Runtime& runtime, TypedElements& views, size_t index, bool ordered) {
  size_t base = index * LIST_REGIONS;
  auto documents = views.read<const uint32_t>(runtime, base + DOCUMENTS, "The phrase documents");
  auto fields = views.read<const uint16_t>(runtime, base + FIELDS, "The phrase fields");
  auto starts = views.read<const uint32_t>(runtime, base + POSITION_STARTS, "The position starts");
  auto counts = views.read<const uint32_t>(runtime, base + POSITION_COUNTS, "The position counts");
  auto positions = views.read<const uint32_t>(runtime, base + POSITIONS, "The stored positions");
  if (fields.length != documents.length || starts.length != documents.length || counts.length != documents.length) {
    throwInvalid("The phrase posting regions must have equal lengths");
  }
  return {documents.data, fields.data, starts.data, counts.data, documents.length,
    positions.data, positions.length, ordered ? 1 : 0};
}

bool controlsValid(Elements<int64_t> meter, Elements<const uint64_t> deadline,
                   const narsil_phrase_output& output) {
  memory_region cap, expiry, spent;
  if (!region_of(meter.data + 1, 1, sizeof(int64_t), &cap) ||
      !region_of(deadline.data, 1, sizeof(uint64_t), &expiry) ||
      !region_of(meter.data, 1, sizeof(int64_t), &spent) || overlaps(spent, cap) || overlaps(spent, expiry)) return false;
  std::array<memory_region, 5> writes;
  if (!region_of(output.matched, output.matched_words, sizeof(uint32_t), &writes[0]) ||
      !region_of(output.starts, output.start_capacity, sizeof(uint32_t), &writes[1]) ||
      !region_of(output.documents, output.document_capacity, sizeof(uint32_t), &writes[2]) ||
      !region_of(output.fields, output.field_capacity, sizeof(uint16_t), &writes[3]) ||
      !region_of(output.frequencies, output.frequency_capacity, sizeof(uint32_t), &writes[4])) return false;
  for (const auto& write : writes) if (overlaps(write, cap) || overlaps(write, expiry)) return false;
  return true;
}
}

jsi::Value HybridNarsilCoreImpl::matchPhrases(jsi::Runtime& runtime, const jsi::Value&,
                                             const jsi::Value* arguments, size_t count) try {
  if (count != ARGUMENT_COUNT || !arguments[REQUEST].isObject()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  constexpr std::array<const char*, PROPERTY_COUNT> properties{
    "postings", "starts", "tokens", "offsets", "searchable", "filter", "removed", "ordinalCount", "collect"
  };
  std::array<jsi::Value, PROPERTY_COUNT> handles;
  auto object = arguments[REQUEST].getObject(runtime);
  for (size_t at = 0; at < properties.size(); at++) handles[at] = object.getProperty(runtime, properties[at]);
  if (!handles[POSTINGS].isObject() || !handles[POSTINGS].getObject(runtime).isArray(runtime) ||
      !handles[ORDINAL_COUNT].isNumber() || !handles[COLLECT].isBool()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  double ordinals = handles[ORDINAL_COUNT].getNumber();
  if (!std::isfinite(ordinals) || ordinals < 0 || ordinals > UINT32_MAX || std::floor(ordinals) != ordinals) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  bool collect = handles[COLLECT].getBool();
  bool filtered = !handles[FILTER].isNull();
  auto lists = handles[POSTINGS].getObject(runtime).getArray(runtime);
  size_t listCount = lists.size(runtime);
  if (listCount > UINT32_MAX || listCount > SIZE_MAX / LIST_REGIONS) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TypedElements postingViews(listCount * LIST_REGIONS);
  std::vector<bool> ordered(listCount);
  constexpr std::array<const char*, LIST_REGIONS> listProperties{
    "documents", "fields", "positionStarts", "positionCounts", "positions"
  };
  for (size_t at = 0; at < listCount; at++) {
    auto value = lists.getValueAtIndex(runtime, at);
    if (!value.isObject()) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
    auto list = value.getObject(runtime);
    for (size_t region = 0; region < LIST_REGIONS; region++) {
      postingViews.prepare(runtime, at * LIST_REGIONS + region, list.getProperty(runtime, listProperties[region]));
    }
    auto flag = list.getProperty(runtime, "ordered");
    if (!flag.isBool()) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
    ordered[at] = flag.getBool();
  }
  TypedElements requestViews(PROPERTY_COUNT);
  for (size_t at = STARTS; at <= REMOVED; at++) {
    if (at != FILTER || filtered) requestViews.prepare(runtime, at, handles[at]);
  }
  TypedElements views(ARGUMENT_COUNT);
  for (size_t at = METER; at < ARGUMENT_COUNT; at++) views.prepare(runtime, at, arguments[at]);
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    state.keywordWorkspace.reset(created);
  }
  std::vector<narsil_phrase_postings> postings(listCount);
  for (size_t at = 0; at < listCount; at++) postings[at] = readList(runtime, postingViews, at, ordered[at]);
  auto starts = requestViews.read<const uint32_t>(runtime, STARTS, "The phrase starts");
  auto tokens = requestViews.read<const uint32_t>(runtime, TOKENS, "The phrase tokens");
  auto offsets = requestViews.read<const uint32_t>(runtime, OFFSETS, "The phrase offsets");
  auto searchable = requestViews.read<const uint8_t>(runtime, SEARCHABLE, "The searchable fields");
  auto removed = requestViews.read<const uint32_t>(runtime, REMOVED, "The removed documents");
  Elements<const uint32_t> filter{nullptr, 0};
  if (filtered) filter = requestViews.read<const uint32_t>(runtime, FILTER, "The permitted documents");
  auto meter = views.read<int64_t>(runtime, METER, "The work counter and cap");
  auto stop = views.read<const uint32_t>(runtime, STOP, "The stop flag");
  auto deadline = views.read<const uint64_t>(runtime, DEADLINE, "The search deadline");
  auto matched = views.read<uint32_t>(runtime, MATCHED, "The matching documents");
  auto outStarts = views.read<uint32_t>(runtime, OUT_STARTS, "The phrase row starts");
  auto documents = views.read<uint32_t>(runtime, OUT_DOCUMENTS, "The phrase row documents");
  auto fields = views.read<uint16_t>(runtime, OUT_FIELDS, "The phrase row fields");
  auto frequencies = views.read<uint32_t>(runtime, OUT_FREQUENCIES, "The phrase frequencies");
  if (starts.length == 0 || tokens.length != offsets.length || (filtered && filter.length == 0) ||
      meter.length != 2 || stop.length != 1 || deadline.length != 1) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  narsil_phrase_output output{matched.data, matched.length, outStarts.data, outStarts.length,
    documents.data, fields.data, frequencies.data, documents.length, fields.length, frequencies.length};
  if (!controlsValid(meter, deadline, output)) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  narsil_phrase_request request{postings.data(), postings.size(), starts.data, starts.length - 1,
    tokens.data, offsets.data, tokens.length, searchable.data, searchable.length, filter.data, filter.length,
    removed.data, removed.length, static_cast<uint32_t>(ordinals), collect ? 1 : 0,
    {meter.data, meter.data[1], stop.data, deadline.data[0]}};
  uint32_t rows = 0;
  auto status = narsil_match_phrases(state.keywordWorkspace.get(), &request, &output, &rows);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(rows) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
