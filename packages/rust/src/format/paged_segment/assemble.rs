use super::head::{PagedHead, PlannedSection, SectionPlan, encode_paged_head};
use super::sink::FinishedSection;
use super::write::padding_before;
use crate::error::Result;

/// One section of a paged segment that a streaming writer assembles: held in memory, or in a scratch file.
pub(crate) enum AssembledSection {
    Held(PlannedSection),
    Spilled(FinishedSection),
}

impl AssembledSection {
    fn plan(&self) -> SectionPlan {
        match self {
            AssembledSection::Held(section) => SectionPlan::of(section),
            AssembledSection::Spilled(section) => SectionPlan {
                name: section.name,
                length: section.length,
                checksums: section.checksums.clone(),
            },
        }
    }
}

/// Hands every byte of the payload of a paged segment with head `head` and `sections` to `write` in order,
/// copying each spilled section from its scratch file a chunk at a time.
pub(crate) fn write_assembled(
    head: &PagedHead,
    sections: &mut [AssembledSection],
    write: &mut dyn FnMut(&[u8]) -> Result<()>,
) -> Result<()> {
    let plans: Vec<SectionPlan> = sections.iter().map(AssembledSection::plan).collect();
    let encoded = encode_paged_head(head, &plans)?;
    write(&encoded.prefix)?;
    write(&encoded.head)?;
    let mut cursor = (encoded.prefix.len() + encoded.head.len()) as u64;
    let mut chunk = Vec::new();
    for ((section, plan), &offset) in sections.iter_mut().zip(&plans).zip(&encoded.offsets) {
        write(&padding_before(offset, cursor)?)?;
        match section {
            AssembledSection::Held(held) => write(&held.bytes)?,
            AssembledSection::Spilled(spilled) => spilled.copy_into(&mut chunk, write)?,
        }
        cursor = offset + plan.length;
    }
    Ok(())
}
