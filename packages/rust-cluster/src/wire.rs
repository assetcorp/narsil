use std::ops::Range;

use crate::constants::MAX_SAFE_INTEGER;

pub(crate) fn write_map_header(out: &mut Vec<u8>, length: usize) {
    if length < 16 {
        out.push(0x80 | length as u8);
    } else if length < 0x1_0000 {
        out.push(0xde);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        out.push(0xdf);
        out.extend_from_slice(&(length as u32).to_be_bytes());
    }
}

pub(crate) fn write_str(out: &mut Vec<u8>, text: &str) {
    let length = text.len();
    if length < 32 {
        out.push(0xa0 | length as u8);
    } else if length < 0x100 {
        out.extend_from_slice(&[0xd9, length as u8]);
    } else if length < 0x1_0000 {
        out.push(0xda);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        out.push(0xdb);
        out.extend_from_slice(&(length as u32).to_be_bytes());
    }
    out.extend_from_slice(text.as_bytes());
}

pub(crate) fn write_bin(out: &mut Vec<u8>, bytes: &[u8]) {
    write_bin_header(out, bytes.len());
    out.extend_from_slice(bytes);
}

pub(crate) fn write_bin_header(out: &mut Vec<u8>, length: usize) {
    if length < 0x100 {
        out.extend_from_slice(&[0xc4, length as u8]);
    } else if length < 0x1_0000 {
        out.push(0xc5);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        out.push(0xc6);
        out.extend_from_slice(&(length as u32).to_be_bytes());
    }
}

pub(crate) fn write_uint(out: &mut Vec<u8>, number: u64) {
    if number < 0x80 {
        out.push(number as u8);
    } else if number < 0x100 {
        out.extend_from_slice(&[0xcc, number as u8]);
    } else if number < 0x1_0000 {
        out.push(0xcd);
        out.extend_from_slice(&(number as u16).to_be_bytes());
    } else if number < 0x1_0000_0000 {
        out.push(0xce);
        out.extend_from_slice(&(number as u32).to_be_bytes());
    } else {
        out.push(0xcf);
        out.extend_from_slice(&number.to_be_bytes());
    }
}

pub(crate) fn write_number(out: &mut Vec<u8>, number: f64) {
    if number >= 0.0 && number.fract() == 0.0 && number <= MAX_SAFE_INTEGER as f64 {
        write_uint(out, number as u64);
    } else {
        out.push(0xcb);
        out.extend_from_slice(&number.to_be_bytes());
    }
}

pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

pub(crate) struct Malformed;

type Read<T> = Result<T, Malformed>;

struct Header {
    body: usize,
    children: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes, at: 0 }
    }

    pub(crate) fn is_finished(&self) -> bool {
        self.at == self.bytes.len()
    }

    fn take(&mut self, length: usize) -> Read<Range<usize>> {
        let end = self.at.checked_add(length).ok_or(Malformed)?;
        if end > self.bytes.len() {
            return Err(Malformed);
        }
        let range = self.at..end;
        self.at = end;
        Ok(range)
    }

    fn byte(&mut self) -> Read<u8> {
        let range = self.take(1)?;
        Ok(self.bytes[range.start])
    }

    fn be_bytes<const N: usize>(&mut self) -> Read<[u8; N]> {
        let range = self.take(N)?;
        let mut array = [0u8; N];
        array.copy_from_slice(&self.bytes[range]);
        Ok(array)
    }

    fn length(&mut self, width: usize) -> Read<usize> {
        Ok(match width {
            1 => self.byte()? as usize,
            2 => u16::from_be_bytes(self.be_bytes()?) as usize,
            _ => u32::from_be_bytes(self.be_bytes()?) as usize,
        })
    }

    pub(crate) fn read_map_length(&mut self) -> Read<usize> {
        match self.byte()? {
            marker @ 0x80..=0x8f => Ok((marker & 0x0f) as usize),
            0xde => self.length(2),
            0xdf => self.length(4),
            _ => Err(Malformed),
        }
    }

    pub(crate) fn read_str(&mut self) -> Read<&'a str> {
        let length = match self.byte()? {
            marker @ 0xa0..=0xbf => (marker & 0x1f) as usize,
            0xd9 => self.length(1)?,
            0xda => self.length(2)?,
            0xdb => self.length(4)?,
            _ => return Err(Malformed),
        };
        let range = self.take(length)?;
        std::str::from_utf8(&self.bytes[range]).map_err(|_| Malformed)
    }

    pub(crate) fn read_bin(&mut self) -> Read<Range<usize>> {
        let length = match self.byte()? {
            0xc4 => self.length(1)?,
            0xc5 => self.length(2)?,
            0xc6 => self.length(4)?,
            _ => return Err(Malformed),
        };
        self.take(length)
    }

    pub(crate) fn read_uint(&mut self) -> Read<u64> {
        let number = match self.byte()? {
            marker @ 0x00..=0x7f => marker as u64,
            0xcc => self.byte()? as u64,
            0xcd => u16::from_be_bytes(self.be_bytes()?) as u64,
            0xce => u32::from_be_bytes(self.be_bytes()?) as u64,
            0xcf => u64::from_be_bytes(self.be_bytes()?),
            0xcb => {
                let number = f64::from_be_bytes(self.be_bytes()?);
                if !(number >= 0.0 && number.fract() == 0.0 && number <= MAX_SAFE_INTEGER as f64) {
                    return Err(Malformed);
                }
                number as u64
            }
            _ => return Err(Malformed),
        };
        if number > MAX_SAFE_INTEGER {
            return Err(Malformed);
        }
        Ok(number)
    }

    fn header(&mut self) -> Read<Header> {
        let marker = self.byte()?;
        let leaf = |body: usize| Header { body, children: 0 };
        Ok(match marker {
            0x00..=0x7f | 0xe0..=0xff | 0xc0 | 0xc2 | 0xc3 => leaf(0),
            0x80..=0x8f => Header {
                body: 0,
                children: 2 * (marker & 0x0f) as usize,
            },
            0x90..=0x9f => Header {
                body: 0,
                children: (marker & 0x0f) as usize,
            },
            0xa0..=0xbf => leaf((marker & 0x1f) as usize),
            0xc4 | 0xd9 => leaf(self.length(1)?),
            0xc5 | 0xda => leaf(self.length(2)?),
            0xc6 | 0xdb => leaf(self.length(4)?),
            0xc7 => leaf(self.length(1)? + 1),
            0xc8 => leaf(self.length(2)? + 1),
            0xc9 => leaf(self.length(4)? + 1),
            0xca | 0xce | 0xd2 => leaf(4),
            0xcb | 0xcf | 0xd3 => leaf(8),
            0xcc | 0xd0 => leaf(1),
            0xcd | 0xd1 => leaf(2),
            0xd4 => leaf(2),
            0xd5 => leaf(3),
            0xd6 => leaf(5),
            0xd7 => leaf(9),
            0xd8 => leaf(17),
            0xdc => Header {
                body: 0,
                children: self.length(2)?,
            },
            0xdd => Header {
                body: 0,
                children: self.length(4)?,
            },
            0xde => Header {
                body: 0,
                children: 2 * self.length(2)?,
            },
            0xdf => Header {
                body: 0,
                children: 2 * self.length(4)?,
            },
            0xc1 => return Err(Malformed),
        })
    }

    pub(crate) fn skip(&mut self) -> Read<()> {
        let mut pending: usize = 1;
        while pending > 0 {
            let header = self.header()?;
            self.take(header.body)?;
            pending = pending - 1 + header.children;
            if pending > self.bytes.len() - self.at {
                return Err(Malformed);
            }
        }
        Ok(())
    }
}
