use super::Value;

const LARGEST_ARRAY_INDEX: u64 = 4_294_967_294;

/// The fields of an object [`Value`], kept in the order that every Narsil implementation iterates them.
///
/// A key that spells an array index, such as `"0"` or `"42"`, comes first in ascending numeric order, and every
/// other key follows in the order of its first insertion. That is the order of an ECMAScript object, so a schema
/// or a document walks its fields in the same order here as in the reference implementation.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Map {
    entries: Vec<(String, Value)>,
}

fn array_index_of(key: &str) -> Option<u64> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    let value = key.parse::<u64>().ok()?;
    (value <= LARGEST_ARRAY_INDEX).then_some(value)
}

impl Map {
    /// Returns an empty map.
    pub fn new() -> Map {
        Map {
            entries: Vec::new(),
        }
    }

    /// Returns an empty map with room for `capacity` fields.
    pub fn with_capacity(capacity: usize) -> Map {
        Map {
            entries: Vec::with_capacity(capacity),
        }
    }

    /// Returns the number of fields.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns true when the map holds no field.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Returns the value of `key`, or `None` when the map lacks it.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    /// Returns a mutable reference to the value of `key`, or `None` when the map lacks it.
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.entries
            .iter_mut()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    /// Returns true when the map holds `key`.
    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(name, _)| name == key)
    }

    /// Sets `key` to `value` and returns the value that the key held before, keeping the key's place when it exists.
    pub fn insert(&mut self, key: impl Into<String>, value: Value) -> Option<Value> {
        let key = key.into();
        if let Some(existing) = self.get_mut(&key) {
            return Some(std::mem::replace(existing, value));
        }
        match array_index_of(&key) {
            Some(index) => {
                let place = self
                    .entries
                    .iter()
                    .position(|(name, _)| array_index_of(name).is_none_or(|other| other > index))
                    .unwrap_or(self.entries.len());
                self.entries.insert(place, (key, value));
            }
            None => self.entries.push((key, value)),
        }
        None
    }

    /// Removes `key` and returns its value, or `None` when the map lacks it.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let place = self.entries.iter().position(|(name, _)| name == key)?;
        Some(self.entries.remove(place).1)
    }

    /// Iterates the fields in order.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&String, &Value)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    /// Iterates the fields in order, with mutable values.
    pub fn iter_mut(&mut self) -> impl ExactSizeIterator<Item = (&String, &mut Value)> {
        self.entries.iter_mut().map(|(key, value)| (&*key, value))
    }

    /// Iterates the keys in order.
    pub fn keys(&self) -> impl ExactSizeIterator<Item = &String> {
        self.entries.iter().map(|(key, _)| key)
    }

    /// Iterates the values in key order.
    pub fn values(&self) -> impl ExactSizeIterator<Item = &Value> {
        self.entries.iter().map(|(_, value)| value)
    }
}

impl IntoIterator for Map {
    type Item = (String, Value);
    type IntoIter = std::vec::IntoIter<(String, Value)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

impl<K: Into<String>> FromIterator<(K, Value)> for Map {
    fn from_iter<I: IntoIterator<Item = (K, Value)>>(iter: I) -> Map {
        let mut map = Map::new();
        for (key, value) in iter {
            map.insert(key, value);
        }
        map
    }
}
