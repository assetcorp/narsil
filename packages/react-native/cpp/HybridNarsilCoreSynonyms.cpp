#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_synonyms.h"

#include <array>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {
namespace {
enum { TOKENS, OFFSETS, RULE_START, RULE_SOURCE, RULE_TOKENS, TOKEN_START, TOKEN_RULES, TABLE_REGIONS };
enum { QUERY_UNITS = TABLE_REGIONS, QUERY_STARTS, OUT_QUERIES, OUT_STARTS, OUT_TOKENS, REGION_COUNT };
}

jsi::Value HybridNarsilCoreImpl::expandSynonyms(jsi::Runtime& runtime, const jsi::Value&,
                                               const jsi::Value* arguments, size_t count) try {
  if (count != EXPAND_SYNONYMS_ARGUMENT_COUNT || !arguments[0].isObject()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  constexpr std::array<const char*, TABLE_REGIONS> properties{
    "tokens", "offsets", "ruleStart", "ruleSource", "ruleTokens", "tokenStart", "tokenRules"
  };
  std::array<jsi::Value, TABLE_REGIONS> handles;
  auto object = arguments[0].getObject(runtime);
  for (size_t at = 0; at < properties.size(); at++) handles[at] = object.getProperty(runtime, properties[at]);
  TypedElements regions(REGION_COUNT);
  for (size_t at = 0; at < properties.size(); at++) regions.prepare(runtime, at, handles[at]);
  for (size_t at = 1; at < count; at++) regions.prepare(runtime, TABLE_REGIONS + at - 1, arguments[at]);
  auto tokens = regions.read<const uint8_t>(runtime, TOKENS, "The synonym tokens");
  auto offsets = regions.read<const uint32_t>(runtime, OFFSETS, "The synonym token offsets");
  auto ruleStart = regions.read<const uint32_t>(runtime, RULE_START, "The synonym rule offsets");
  auto ruleSource = regions.read<const int32_t>(runtime, RULE_SOURCE, "The synonym rule sources");
  auto ruleTokens = regions.read<const uint32_t>(runtime, RULE_TOKENS, "The synonym rule members");
  auto tokenStart = regions.read<const uint32_t>(runtime, TOKEN_START, "The synonym membership offsets");
  auto tokenRules = regions.read<const uint32_t>(runtime, TOKEN_RULES, "The synonym memberships");
  auto units = regions.read<const uint16_t>(runtime, QUERY_UNITS, "The synonym query text");
  auto starts = regions.read<const uint32_t>(runtime, QUERY_STARTS, "The synonym query offsets");
  auto queries = regions.read<uint32_t>(runtime, OUT_QUERIES, "The synonym query positions");
  auto intoStarts = regions.read<uint32_t>(runtime, OUT_STARTS, "The synonym output offsets");
  auto intoTokens = regions.read<uint32_t>(runtime, OUT_TOKENS, "The synonym output members");
  if (offsets.length == 0 || starts.length == 0 || ruleSource.length == UINT32_MAX ||
      ruleStart.length != ruleSource.length + 1 || tokenStart.length != offsets.length) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  narsil_synonym_table table{tokens.data, tokens.length, offsets.data, offsets.length - 1,
    ruleStart.data, ruleSource.data, ruleSource.length, ruleTokens.data, ruleTokens.length,
    tokenStart.data, tokenRules.data, tokenRules.length};
  narsil_synonym_request request{&table, units.data, units.length, starts.data, starts.length - 1};
  narsil_synonym_output output{queries.data, queries.length, intoStarts.data, intoStarts.length,
    intoTokens.data, intoTokens.length};
  uint32_t groups = 0;
  narsil_status status = narsil_expand_synonyms(&request, &output, &groups);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(groups) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
