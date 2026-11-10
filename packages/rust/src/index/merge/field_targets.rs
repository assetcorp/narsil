use super::field_regions::{FieldTargets, RegionLengths, region_length, target_region};
use crate::ffi;

fn sized<T: Clone + Default>(lengths: &RegionLengths, at: usize) -> Vec<T> {
    vec![T::default(); region_length(lengths, at)]
}

pub(super) struct ValueTargets {
    pub(super) values: Vec<f64>,
    pub(super) documents: Vec<u32>,
}

impl FieldTargets for ValueTargets {
    fn sized(lengths: &RegionLengths) -> Self {
        ValueTargets {
            values: sized(lengths, 0),
            documents: sized(lengths, 1),
        }
    }

    fn targets(&mut self) -> Vec<ffi::narsil_field_merge_target> {
        vec![
            target_region(&mut self.values),
            target_region(&mut self.documents),
        ]
    }
}

pub(super) struct BitTargets {
    pub(super) true_bits: Vec<u32>,
    pub(super) false_bits: Vec<u32>,
}

impl FieldTargets for BitTargets {
    fn sized(lengths: &RegionLengths) -> Self {
        BitTargets {
            true_bits: sized(lengths, 0),
            false_bits: sized(lengths, 1),
        }
    }

    fn targets(&mut self) -> Vec<ffi::narsil_field_merge_target> {
        vec![
            target_region(&mut self.true_bits),
            target_region(&mut self.false_bits),
        ]
    }
}

pub(super) struct EnumTargets {
    pub(super) units: Vec<u16>,
    pub(super) text_offsets: Vec<u32>,
    pub(super) posting_offsets: Vec<u32>,
    pub(super) postings: Vec<u32>,
    pub(super) suffixes: Vec<u32>,
}

impl FieldTargets for EnumTargets {
    fn sized(lengths: &RegionLengths) -> Self {
        EnumTargets {
            units: sized(lengths, 0),
            text_offsets: sized(lengths, 1),
            posting_offsets: sized(lengths, 2),
            postings: sized(lengths, 3),
            suffixes: sized(lengths, 4),
        }
    }

    fn targets(&mut self) -> Vec<ffi::narsil_field_merge_target> {
        vec![
            target_region(&mut self.units),
            target_region(&mut self.text_offsets),
            target_region(&mut self.posting_offsets),
            target_region(&mut self.postings),
            target_region(&mut self.suffixes),
        ]
    }
}

pub(super) struct GeoTargets {
    pub(super) codes: Vec<u64>,
    pub(super) latitudes: Vec<f64>,
    pub(super) longitudes: Vec<f64>,
    pub(super) documents: Vec<u32>,
}

impl FieldTargets for GeoTargets {
    fn sized(lengths: &RegionLengths) -> Self {
        GeoTargets {
            codes: sized(lengths, 0),
            latitudes: sized(lengths, 1),
            longitudes: sized(lengths, 2),
            documents: sized(lengths, 3),
        }
    }

    fn targets(&mut self) -> Vec<ffi::narsil_field_merge_target> {
        vec![
            target_region(&mut self.codes),
            target_region(&mut self.latitudes),
            target_region(&mut self.longitudes),
            target_region(&mut self.documents),
        ]
    }
}

pub(super) struct PatternTargets {
    pub(super) documents: Vec<u32>,
    pub(super) runs: Vec<u32>,
    pub(super) offsets: Vec<u32>,
    pub(super) postings: Vec<u32>,
}

impl FieldTargets for PatternTargets {
    fn sized(lengths: &RegionLengths) -> Self {
        PatternTargets {
            documents: sized(lengths, 0),
            runs: sized(lengths, 1),
            offsets: sized(lengths, 2),
            postings: sized(lengths, 3),
        }
    }

    fn targets(&mut self) -> Vec<ffi::narsil_field_merge_target> {
        vec![
            target_region(&mut self.documents),
            target_region(&mut self.runs),
            target_region(&mut self.offsets),
            target_region(&mut self.postings),
        ]
    }
}
