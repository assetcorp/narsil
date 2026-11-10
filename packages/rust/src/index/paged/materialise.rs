use super::PagedSections;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::keyword_segment::{
    KeywordSegment, Positions, WriteRecords, decode_keyword_segment, encode_keyword_segment,
};

fn too_large(what: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("A paged segment holds more {what} than a keyword segment can number"),
    )
}

fn as_u32(value: usize, what: &str) -> Result<u32> {
    u32::try_from(value).map_err(|_| too_large(what))
}

impl PagedSections {
    fn fill_postings(&self, out: &mut KeywordSegment) -> Result<()> {
        let mut positions = self.tracks_positions().then(|| Positions {
            offsets: vec![0],
            values: Vec::new(),
        });
        for token in 0..out.token_count() {
            let start = out.posting_offsets.get(token).copied().unwrap_or(0);
            let end = out.posting_offsets.get(token + 1).copied().unwrap_or(0);
            let count = end.saturating_sub(start);
            let list = self.list(token, start, count)?;
            out.posting_documents.extend_from_slice(&list.documents);
            out.posting_frequencies.extend_from_slice(&list.frequencies);
            out.posting_fields.extend_from_slice(&list.fields);
            if let Some(held) = positions.as_mut() {
                let loaded = self.positions(token, start, count)?.unwrap_or_default();
                for row in 0..list.len() {
                    held.values.extend_from_slice(loaded.of(row));
                    held.offsets.push(as_u32(held.values.len(), "positions")?);
                }
            }
        }
        out.positions = positions;
        Ok(())
    }

    fn fill_documents(&self, out: &mut KeywordSegment) -> Result<()> {
        out.id_offsets = vec![0];
        out.document_offsets = vec![0];
        let mut records = self.holds_write_records().then(WriteRecords::default);
        for ordinal in 0..out.document_count {
            out.ids.extend_from_slice(self.id(ordinal)?.as_bytes());
            out.id_offsets.push(as_u32(out.ids.len(), "ID bytes")?);
            out.documents
                .extend_from_slice(&self.document_bytes(ordinal)?);
            out.document_offsets
                .push(as_u32(out.documents.len(), "document bytes")?);
            if let (Some(held), Some((seq_no, term))) =
                (records.as_mut(), self.write_record(ordinal)?)
            {
                held.seq_nos.push(seq_no);
                held.primary_terms.push(term);
            }
        }
        out.id_order = (0..out.document_count)
            .map(|position| self.sorted_ordinal(position))
            .collect::<Result<Vec<u32>>>()?;
        out.write_records = records;
        Ok(())
    }

    /// Reads every page of the segment into one keyword segment and applies every rule of the keyword segment
    /// payload to it, as a merge must before it reads a paged segment.
    pub(crate) fn materialise(&self, resident: &KeywordSegment) -> Result<KeywordSegment> {
        let mut out = KeywordSegment {
            schema: resident.schema.clone(),
            tombstones: Vec::new(),
            document_count: resident.document_count,
            field_names: resident.field_names.clone(),
            tokens: resident.tokens.clone(),
            token_offsets: resident.token_offsets.clone(),
            document_frequencies: resident.document_frequencies.clone(),
            posting_offsets: resident.posting_offsets.clone(),
            field_lengths: resident.field_lengths.clone(),
            numeric: resident.numeric.clone(),
            sizes: resident.sizes.clone(),
            boolean: resident.boolean.clone(),
            enums: resident.enums.clone(),
            geopoint: resident.geopoint.clone(),
            pattern: resident.pattern.clone(),
            surface_forms: resident.surface_forms.clone(),
            partial_words: resident.partial_words.clone(),
            ..KeywordSegment::default()
        };
        self.fill_postings(&mut out)?;
        self.fill_documents(&mut out)?;
        decode_keyword_segment(&encode_keyword_segment(&out)?)
    }
}
