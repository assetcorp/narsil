use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;

#[derive(Clone, Default)]
pub(crate) struct PackedTokens {
    pub(crate) records: Vec<ffi::narsil_token>,
    pub(crate) units: Vec<u16>,
}

fn too_much_text() -> NarsilError {
    NarsilError::new(
        ErrorCode::DOC_VALIDATION_FAILED,
        "A text field holds more than 4,294,967,295 UTF-16 code units of tokens, which is more than a segment stores",
    )
}

fn stored_at(units: &mut Vec<u16>, text: &[u16]) -> Result<u32> {
    let offset = u32::try_from(units.len()).map_err(|_| too_much_text())?;
    units.extend_from_slice(text);
    u32::try_from(units.len()).map_err(|_| too_much_text())?;
    Ok(offset)
}

impl PackedTokens {
    pub(crate) fn len(&self) -> usize {
        self.records.len()
    }

    pub(crate) fn push(
        &mut self,
        term: &[u16],
        position: u32,
        surface: Option<&[u16]>,
    ) -> Result<()> {
        let term_offset = stored_at(&mut self.units, term)?;
        let (surface_offset, surface_length) = match surface {
            Some(surface) if !surface.is_empty() && surface != term => {
                (stored_at(&mut self.units, surface)?, surface.len() as u32)
            }
            _ => (ffi::NARSIL_NO_SURFACE, 0),
        };
        self.records.push(ffi::narsil_token {
            position,
            term_offset,
            term_length: term.len() as u32,
            surface_offset,
            surface_length,
            original_offset: 0,
            original_length: 0,
            term_slot: ffi::NARSIL_NO_TERM_SLOT,
        });
        Ok(())
    }

    pub(crate) fn term(&self, record: &ffi::narsil_token) -> &[u16] {
        span(&self.units, record.term_offset, record.term_length)
    }

    pub(crate) fn surface(&self, record: &ffi::narsil_token) -> Option<&[u16]> {
        (record.surface_offset != ffi::NARSIL_NO_SURFACE)
            .then(|| span(&self.units, record.surface_offset, record.surface_length))
    }

    pub(crate) fn raw(&self) -> ffi::narsil_tokens {
        ffi::narsil_tokens {
            tokens: self.records.as_ptr(),
            token_count: self.records.len() as u32,
            units: self.units.as_ptr(),
            unit_count: self.units.len() as u32,
        }
    }
}

fn span(units: &[u16], offset: u32, length: u32) -> &[u16] {
    let start = offset as usize;
    units
        .get(start..start.saturating_add(length as usize))
        .unwrap_or_default()
}

impl PackedTokens {
    pub(crate) fn holding_surfaces(&self) -> Result<PackedTokens> {
        let mut kept = PackedTokens::default();
        for record in &self.records {
            if let Some(surface) = self.surface(record) {
                kept.push(self.term(record), record.position, Some(surface))?;
            }
        }
        Ok(kept)
    }
}

pub(crate) struct SegmentFieldTokens<'a> {
    pub(crate) field: u16,
    pub(crate) tokens: &'a PackedTokens,
}

pub(crate) fn raw_fields(fields: &[SegmentFieldTokens<'_>]) -> Vec<ffi::narsil_field_tokens> {
    fields
        .iter()
        .map(|field| ffi::narsil_field_tokens {
            field: field.field,
            tokens: field.tokens.raw(),
        })
        .collect()
}
