use super::{MAX_ENCODING_DEPTH, TIMESTAMP_EXTENSION};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Timestamp, Value, number_to_text};

const NANOSECONDS_PER_SECOND: u32 = 1_000_000_000;

/// Reads MessagePack values from a byte slice, borrowing strings and binary values where it can.
pub(crate) struct Decoder<'a> {
    bytes: &'a [u8],
    at: usize,
}

fn malformed(reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The MessagePack data is malformed: {reason}"),
    )
}

impl<'a> Decoder<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Decoder<'a> {
        Decoder { bytes, at: 0 }
    }

    pub(crate) fn position(&self) -> usize {
        self.at
    }

    pub(crate) fn is_finished(&self) -> bool {
        self.at == self.bytes.len()
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len());
        let Some(end) = end else {
            return Err(malformed("a value runs past the end of the data"));
        };
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn be<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut array = [0u8; N];
        array.copy_from_slice(self.take(N)?);
        Ok(array)
    }

    fn length_of(&mut self, width: usize) -> Result<usize> {
        Ok(match width {
            1 => self.byte()? as usize,
            2 => u16::from_be_bytes(self.be()?) as usize,
            _ => u32::from_be_bytes(self.be()?) as usize,
        })
    }

    pub(crate) fn peek(&self) -> Result<u8> {
        self.bytes
            .get(self.at)
            .copied()
            .ok_or_else(|| malformed("the data ends before a value"))
    }

    pub(crate) fn read_nil(&mut self) -> Result<bool> {
        if self.peek()? == 0xc0 {
            self.at += 1;
            return Ok(true);
        }
        Ok(false)
    }

    pub(crate) fn read_map_length(&mut self) -> Result<usize> {
        match self.byte()? {
            marker @ 0x80..=0x8f => Ok((marker & 0x0f) as usize),
            0xde => self.length_of(2),
            0xdf => self.length_of(4),
            _ => Err(malformed("a map was expected")),
        }
    }

    pub(crate) fn read_array_length(&mut self) -> Result<usize> {
        match self.byte()? {
            marker @ 0x90..=0x9f => Ok((marker & 0x0f) as usize),
            0xdc => self.length_of(2),
            0xdd => self.length_of(4),
            _ => Err(malformed("an array was expected")),
        }
    }

    pub(crate) fn read_str(&mut self) -> Result<&'a str> {
        let length = match self.byte()? {
            marker @ 0xa0..=0xbf => (marker & 0x1f) as usize,
            0xd9 => self.length_of(1)?,
            0xda => self.length_of(2)?,
            0xdb => self.length_of(4)?,
            _ => return Err(malformed("a string was expected")),
        };
        let bytes = self.take(length)?;
        std::str::from_utf8(bytes).map_err(|_| malformed("a string is not valid UTF-8"))
    }

    pub(crate) fn read_bin(&mut self) -> Result<&'a [u8]> {
        let length = match self.byte()? {
            0xc4 => self.length_of(1)?,
            0xc5 => self.length_of(2)?,
            0xc6 => self.length_of(4)?,
            _ => return Err(malformed("binary data was expected")),
        };
        self.take(length)
    }

    pub(crate) fn read_number(&mut self) -> Result<f64> {
        let marker = self.byte()?;
        Ok(match marker {
            0x00..=0x7f => marker as f64,
            0xe0..=0xff => marker as i8 as f64,
            0xcc => self.byte()? as f64,
            0xcd => u16::from_be_bytes(self.be()?) as f64,
            0xce => u32::from_be_bytes(self.be()?) as f64,
            0xcf => u64::from_be_bytes(self.be()?) as f64,
            0xd0 => self.byte()? as i8 as f64,
            0xd1 => i16::from_be_bytes(self.be()?) as f64,
            0xd2 => i32::from_be_bytes(self.be()?) as f64,
            0xd3 => i64::from_be_bytes(self.be()?) as f64,
            0xca => f32::from_be_bytes(self.be()?) as f64,
            0xcb => f64::from_be_bytes(self.be()?),
            _ => return Err(malformed("a number was expected")),
        })
    }

    pub(crate) fn read_bool(&mut self) -> Result<bool> {
        match self.byte()? {
            0xc2 => Ok(false),
            0xc3 => Ok(true),
            _ => Err(malformed("a boolean was expected")),
        }
    }

    fn read_extension(&mut self, marker: u8) -> Result<Value> {
        let length = match marker {
            0xd4 => 1,
            0xd5 => 2,
            0xd6 => 4,
            0xd7 => 8,
            0xd8 => 16,
            0xc7 => self.length_of(1)?,
            0xc8 => self.length_of(2)?,
            _ => self.length_of(4)?,
        };
        let kind = self.byte()? as i8;
        let data = self.take(length)?;
        if kind != TIMESTAMP_EXTENSION {
            return Err(malformed(&format!(
                "the extension type {kind} is not a timestamp"
            )));
        }
        let timestamp = match data.len() {
            4 => Timestamp {
                seconds: u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as i64,
                nanoseconds: 0,
            },
            8 => {
                let packed = u64::from_be_bytes(
                    data.try_into()
                        .map_err(|_| malformed("a timestamp is short"))?,
                );
                Timestamp {
                    seconds: (packed & 0x3_ffff_ffff) as i64,
                    nanoseconds: (packed >> 34) as u32,
                }
            }
            12 => Timestamp {
                nanoseconds: u32::from_be_bytes([data[0], data[1], data[2], data[3]]),
                seconds: i64::from_be_bytes(
                    data[4..12]
                        .try_into()
                        .map_err(|_| malformed("a timestamp is short"))?,
                ),
            },
            _ => {
                return Err(malformed(
                    "a timestamp has a length other than 4, 8, or 12 bytes",
                ));
            }
        };
        if timestamp.nanoseconds >= NANOSECONDS_PER_SECOND {
            return Err(malformed(
                "a timestamp holds 1,000,000,000 nanoseconds or more",
            ));
        }
        Ok(Value::Timestamp(timestamp))
    }

    fn read_key(&mut self) -> Result<String> {
        let marker = self.peek()?;
        if matches!(marker, 0xa0..=0xbf | 0xd9..=0xdb) {
            return Ok(self.read_str()?.to_string());
        }
        let number = self
            .read_number()
            .map_err(|_| malformed("a map key is neither a string nor a number"))?;
        Ok(number_to_text(number))
    }

    pub(crate) fn read_value(&mut self, depth: usize) -> Result<Value> {
        if depth > MAX_ENCODING_DEPTH {
            return Err(malformed(&format!(
                "a value nests deeper than {MAX_ENCODING_DEPTH} levels"
            )));
        }
        let marker = self.peek()?;
        match marker {
            0xc0 => {
                self.at += 1;
                Ok(Value::Null)
            }
            0xc2 | 0xc3 => Ok(Value::Bool(self.read_bool()?)),
            0x00..=0x7f | 0xe0..=0xff | 0xca..=0xd3 => Ok(Value::Number(self.read_number()?)),
            0xa0..=0xbf | 0xd9..=0xdb => Ok(Value::String(self.read_str()?.to_string())),
            0xc4..=0xc6 => Ok(Value::Bytes(self.read_bin()?.to_vec())),
            0x90..=0x9f | 0xdc | 0xdd => {
                let length = self.read_array_length()?;
                let mut items = Vec::with_capacity(length.min(self.bytes.len() - self.at));
                for _ in 0..length {
                    items.push(self.read_value(depth + 1)?);
                }
                Ok(Value::Array(items))
            }
            0x80..=0x8f | 0xde | 0xdf => {
                let length = self.read_map_length()?;
                let mut map = Map::with_capacity(length.min(self.bytes.len() - self.at));
                for _ in 0..length {
                    let key = self.read_key()?;
                    let entry = self.read_value(depth + 1)?;
                    map.insert(key, entry);
                }
                Ok(Value::Object(map))
            }
            0xd4..=0xd8 | 0xc7..=0xc9 => {
                self.at += 1;
                self.read_extension(marker)
            }
            _ => Err(malformed(&format!(
                "the byte 0x{marker:02x} starts no value"
            ))),
        }
    }

    pub(crate) fn skip(&mut self) -> Result<()> {
        self.read_value(1).map(|_| ())
    }
}

pub(crate) fn decode_value(bytes: &[u8]) -> Result<Value> {
    let mut decoder = Decoder::new(bytes);
    let value = decoder.read_value(1)?;
    if !decoder.is_finished() {
        return Err(malformed("bytes follow the value"));
    }
    Ok(value)
}

pub(crate) fn decode_document(bytes: &[u8]) -> Result<Map> {
    match decode_value(bytes)? {
        Value::Object(map) => Ok(map),
        _ => Err(malformed("a stored document is not a map")),
    }
}
