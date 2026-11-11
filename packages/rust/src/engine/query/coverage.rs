use std::collections::HashSet;

use super::params::TermMatch;
use crate::search::components::ScoreComponents;
use crate::search::fuzzy::fuzzy_term_matches;
use crate::search::keyword::KeywordHit;
use crate::search::query::TermGroup;

/// The settings that decide whether an index term stands for a query term.
pub(crate) struct CoverageRules<'a> {
    pub(crate) tokens: &'a [String],
    pub(crate) policy: TermMatch,
    pub(crate) tolerance: u32,
    pub(crate) prefix_length: u32,
    pub(crate) exact: bool,
    pub(crate) groups: &'a [TermGroup],
    pub(crate) partial_fields: &'a [String],
    pub(crate) phrase_keys: Option<&'a HashSet<String>>,
}

fn term_satisfied(rules: &CoverageRules<'_>, token: &str, index_tokens: &[&str]) -> bool {
    if rules.exact || rules.tolerance == 0 {
        return index_tokens.contains(&token);
    }
    index_tokens
        .iter()
        .any(|candidate| fuzzy_term_matches(token, candidate, rules.tolerance, rules.prefix_length))
}

fn matched_in_partial_field(
    components: &ScoreComponents,
    token: &str,
    partial_fields: &[String],
) -> bool {
    partial_fields.iter().any(|field| {
        let key = format!("{field}:{token}");
        components
            .term_frequencies
            .iter()
            .any(|(held, _)| *held == key)
    })
}

fn group_satisfied(
    group: &TermGroup,
    components: &ScoreComponents,
    index_tokens: &[&str],
    partial_fields: &[String],
) -> bool {
    index_tokens.iter().any(|&token| {
        let member = group.members.iter().find(|member| member.token == token);
        let is_member = member.is_some() || group.has_synonym(token);
        if !is_member {
            return false;
        }
        let partial_only = group
            .members
            .iter()
            .any(|member| member.token == token && member.factor == 0.0);
        !partial_only || matched_in_partial_field(components, token, partial_fields)
    })
}

fn matched_terms(rules: &CoverageRules<'_>, components: &ScoreComponents) -> usize {
    let index_tokens: Vec<&str> = components
        .idf
        .iter()
        .map(|(key, _)| key.as_str())
        .filter(|key| {
            rules
                .phrase_keys
                .is_none_or(|phrases| !phrases.contains(*key))
        })
        .collect();
    if index_tokens.is_empty() {
        return 0;
    }
    rules
        .tokens
        .iter()
        .filter(
            |token| match rules.groups.iter().find(|group| group.token == **token) {
                None => term_satisfied(rules, token, &index_tokens),
                Some(group) => {
                    group_satisfied(group, components, &index_tokens, rules.partial_fields)
                        || (group.typo_matches && term_satisfied(rules, token, &index_tokens))
                }
            },
        )
        .count()
}

/// Keeps the hits that hold at least as many of the query's terms as the policy asks for.
pub(crate) fn filter_by_term_coverage(
    hits: Vec<KeywordHit>,
    rules: &CoverageRules<'_>,
) -> Vec<KeywordHit> {
    let required = match rules.policy {
        TermMatch::Any => return hits,
        TermMatch::All => rules.tokens.len(),
        TermMatch::AtLeast(count) => count as usize,
    };
    if required == 0 {
        return hits;
    }
    if required > rules.tokens.len() {
        return Vec::new();
    }
    hits.into_iter()
        .filter(|hit| {
            hit.components
                .as_ref()
                .is_some_and(|components| matched_terms(rules, components) >= required)
        })
        .collect()
}
