use narsil::{Map, Value, decode_msgpack};

use crate::wire::Reader;

const NIL: &[u8] = &[0xc0];

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Field<'a> {
    raw: Option<&'a [u8]>,
}

pub(crate) fn fields_of<'a, const N: usize>(
    value: &'a [u8],
    names: [&str; N],
) -> Option<[Field<'a>; N]> {
    let mut reader = Reader::new(value);
    let length = reader.read_map_length().ok()?;
    let mut found = [Field::default(); N];
    for _ in 0..length {
        let key = reader.read_str().ok()?;
        let raw = reader.read_value().ok()?;
        if let Some(at) = names.iter().position(|name| *name == key) {
            found[at].raw = Some(raw);
        }
    }
    Some(found)
}

impl<'a> Field<'a> {
    pub(crate) fn present(self) -> Option<&'a [u8]> {
        self.raw.filter(|raw| *raw != NIL)
    }

    pub(crate) fn text(self) -> Option<&'a str> {
        Reader::new(self.present()?).read_str().ok()
    }

    pub(crate) fn filled_text(self) -> Option<&'a str> {
        self.text().filter(|text| !text.is_empty())
    }

    pub(crate) fn count(self) -> Option<u64> {
        Reader::new(self.present()?).read_whole_number().ok()
    }

    pub(crate) fn count_u32(self) -> Option<u32> {
        u32::try_from(self.count()?).ok()
    }

    pub(crate) fn flag(self) -> Option<bool> {
        Reader::new(self.present()?).read_bool().ok()
    }

    pub(crate) fn binary(self) -> Option<&'a [u8]> {
        let raw = self.present()?;
        let range = Reader::new(raw).read_bin().ok()?;
        raw.get(range)
    }

    pub(crate) fn map(self) -> Option<Map> {
        let raw = self.present()?;
        Reader::new(raw).read_map_length().ok()?;
        match decode_msgpack(raw) {
            Ok(Value::Object(map)) => Some(map),
            _ => None,
        }
    }

    pub(crate) fn items(self) -> Option<Items<'a>> {
        let mut reader = Reader::new(self.present()?);
        let remaining = reader.read_array_length().ok()?;
        Some(Items { reader, remaining })
    }

    pub(crate) fn optional<T>(
        self,
        read: impl FnOnce(Field<'a>) -> Option<T>,
    ) -> Option<Option<T>> {
        match self.present() {
            None => Some(None),
            Some(_) => read(self).map(Some),
        }
    }
}

pub(crate) struct Items<'a> {
    reader: Reader<'a>,
    remaining: usize,
}

impl Items<'_> {
    pub(crate) fn len(&self) -> usize {
        self.remaining
    }
}

impl<'a> Iterator for Items<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<&'a [u8]> {
        self.remaining = self.remaining.checked_sub(1)?;
        self.reader.read_value().ok()
    }
}
