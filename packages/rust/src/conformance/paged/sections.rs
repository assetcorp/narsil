use super::WHAT;
use crate::conformance::forms::form_error;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::paged_segment::PAYLOAD_PREFIX_BYTES;
use crate::format::paged_segment::head::{PagedHead, PagedSection, decode_paged_head};
use crate::util::bytes::u32_list;
use crate::util::hash::crc32;

/// The payload of a paged segment with its decoded head, which hands out each section's bytes once every page of
/// the section passes its checksum.
pub(super) struct Sections<'p> {
    payload: &'p [u8],
    pub(super) head: PagedHead,
}

impl<'p> Sections<'p> {
    pub(super) fn bytes(&self, section: &PagedSection) -> Result<&'p [u8]> {
        let start = usize::try_from(section.offset).ok();
        let end = start.and_then(|start| start.checked_add(usize::try_from(section.length).ok()?));
        let bytes = match (start, end) {
            (Some(start), Some(end)) => self.payload.get(start..end),
            _ => None,
        }
        .ok_or_else(|| {
            form_error(format!(
                "the {WHAT} ends section {} outside its payload",
                section.name
            ))
        })?;
        let page_bytes = usize::try_from(section.page_bytes.max(1)).unwrap_or(usize::MAX);
        for (page, chunk) in bytes.chunks(page_bytes).enumerate() {
            if section.checksum_of_page(page as u64) != Some(crc32(chunk)) {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_CRC_MISMATCH,
                    format!(
                        "Page {page} of section \"{}\" fails its checksum",
                        section.name
                    ),
                ));
            }
        }
        Ok(bytes)
    }

    pub(super) fn named(&self, name: &str) -> Result<&'p [u8]> {
        let section = self
            .head
            .section(name)
            .ok_or_else(|| form_error(format!("the {WHAT} holds no {name} section")))?;
        self.bytes(section)
    }

    pub(super) fn u32s(&self, name: &str) -> Result<Vec<u32>> {
        u32_list(self.named(name)?, name)
    }
}

/// Splits the payload of a paged segment into its head, which must pass its checksum, and its sections.
pub(super) fn opened(payload: &[u8]) -> Result<Sections<'_>> {
    let prefix = payload
        .get(..PAYLOAD_PREFIX_BYTES)
        .ok_or_else(|| form_error(format!("the {WHAT} ends inside its payload prefix")))?;
    let head_length = u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    let head_checksum = u32::from_le_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]);
    let head = PAYLOAD_PREFIX_BYTES
        .checked_add(head_length)
        .and_then(|end| payload.get(PAYLOAD_PREFIX_BYTES..end))
        .ok_or_else(|| form_error(format!("the {WHAT} ends its head outside the payload")))?;
    if crc32(head) != head_checksum {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_CRC_MISMATCH,
            format!("The head of the {WHAT} fails its checksum"),
        ));
    }
    let head = decode_paged_head(head, payload.len() as u64, &format!("the {WHAT}"))?;
    Ok(Sections { payload, head })
}
