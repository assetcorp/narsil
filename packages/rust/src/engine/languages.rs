use std::collections::HashSet;

use crate::analysis::Language;
use crate::error::Result;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct LanguageList {
    allowed: Option<HashSet<String>>,
}

impl LanguageList {
    pub(crate) fn checked(names: Option<&[String]>) -> Result<LanguageList> {
        let Some(names) = names else {
            return Ok(LanguageList::default());
        };
        for name in names {
            Language::named(name)?;
        }
        Ok(LanguageList {
            allowed: Some(names.iter().cloned().collect()),
        })
    }

    pub(crate) fn resolve(&self, name: &str) -> Result<Language> {
        match &self.allowed {
            Some(allowed) if !allowed.contains(name) => Err(Language::not_registered(name)),
            _ => Language::named(name),
        }
    }
}
