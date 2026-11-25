use crate::config::Bm25Params;

/// One token that a term group scores, with the factors that it applies in ordinary and partial-word fields.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GroupMember {
    pub(crate) token: String,
    pub(crate) factor: f64,
    pub(crate) partial_factor: f64,
}

/// The tokens that one query token stands for, such as its synonyms and the words that its prefix reaches; a
/// document scores the best member that it holds.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TermGroup {
    pub(crate) token: String,
    pub(crate) members: Vec<GroupMember>,
    pub(crate) typo_matches: bool,
    pub(crate) synonyms: Option<Vec<String>>,
}

impl TermGroup {
    pub(crate) fn has_synonym(&self, token: &str) -> bool {
        self.synonyms
            .as_ref()
            .is_some_and(|synonyms| synonyms.iter().any(|synonym| synonym == token))
    }
}

/// A query term that folded matching widens in one partition: the words that fold to its key, and the words within
/// its typo tolerance of that key, each in code point order.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FoldedQueryTerm {
    pub(crate) token: String,
    pub(crate) variants: Vec<String>,
    pub(crate) typo_matches: Vec<String>,
}

impl FoldedQueryTerm {
    /// Returns the group that scores the term's token together with its variants, as one combined term.
    pub(crate) fn group(&self) -> Option<TermGroup> {
        (!self.variants.is_empty()).then(|| TermGroup {
            token: self.token.clone(),
            members: vec![GroupMember {
                token: self.token.clone(),
                factor: 1.0,
                partial_factor: 1.0,
            }],
            typo_matches: false,
            synonyms: Some(self.variants.clone()),
        })
    }

    pub(crate) fn is_variant(&self, token: &str) -> bool {
        self.variants.iter().any(|variant| variant == token)
    }
}

/// The rows of one quoted phrase in one segment, found by the phrase matcher, with the tokens that each position
/// of the phrase matches.
#[derive(Clone, Debug, Default)]
pub(crate) struct PhraseRows {
    pub(crate) key: String,
    pub(crate) tokens: Vec<String>,
    pub(crate) variants: Vec<Vec<String>>,
    pub(crate) rows: Vec<super::request::Row>,
}

/// Everything that a keyword search of one partition needs, after the engine has analysed the query.
pub(crate) struct KeywordQuery<'a> {
    pub(crate) tokens: &'a [String],
    pub(crate) groups: &'a [TermGroup],
    pub(crate) folded: &'a [FoldedQueryTerm],
    pub(crate) phrases: &'a [super::phrase::AnalysedPhrase],
    pub(crate) exact: bool,
    pub(crate) tolerance: u32,
    pub(crate) prefix_length: u32,
    pub(crate) fields: Option<&'a [String]>,
    pub(crate) boost: &'a [(String, f64)],
    pub(crate) bm25: &'a Bm25Params,
    pub(crate) partial_fields: &'a [String],
    pub(crate) max_results: Option<usize>,
    pub(crate) collect: bool,
    pub(crate) components: bool,
}

impl KeywordQuery<'_> {
    pub(crate) fn group_of(&self, token: &str) -> Option<&TermGroup> {
        self.groups.iter().find(|group| group.token == token)
    }

    pub(crate) fn folded_of(&self, token: &str) -> Option<&FoldedQueryTerm> {
        self.folded.iter().find(|folded| folded.token == token)
    }
}
