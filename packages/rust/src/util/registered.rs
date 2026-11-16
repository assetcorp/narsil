/// The values that an engine holds under names, in the order that each name was first registered, where a second
/// registration under a name replaces its value in place, as a JavaScript `Map` keeps them.
pub(crate) struct RegisteredByName<T> {
    entries: Vec<(String, T)>,
}

impl<T> Default for RegisteredByName<T> {
    fn default() -> RegisteredByName<T> {
        RegisteredByName {
            entries: Vec::new(),
        }
    }
}

impl<T> RegisteredByName<T> {
    /// Holds `value` under `name`, keeping the place of a name that the registry already holds.
    pub(crate) fn insert(&mut self, name: &str, value: T) {
        match self.entries.iter_mut().find(|(held, _)| held == name) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((name.to_string(), value)),
        }
    }

    /// Returns the value held under `name`, if any.
    pub(crate) fn get(&self, name: &str) -> Option<&T> {
        self.entries
            .iter()
            .find(|(held, _)| held == name)
            .map(|(_, value)| value)
    }

    /// Returns every registered name in the order of its first registration.
    pub(crate) fn names(&self) -> Vec<&str> {
        self.entries.iter().map(|(name, _)| name.as_str()).collect()
    }

    /// Drops every value that the registry holds.
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }
}
