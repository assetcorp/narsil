use crate::format::manifest::SegmentManifest;

/// The bytes that the files of an index's current manifest hold, in total and for the segments of each partition.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SavedSize {
    pub(crate) bytes: u64,
    partitions: Vec<(u32, u64)>,
}

impl SavedSize {
    /// Sums the bytes of every segment, vector file, and graph part that `manifest` lists.
    pub(crate) fn of(manifest: &SegmentManifest) -> SavedSize {
        let mut bytes = 0u64;
        let mut partitions = Vec::with_capacity(manifest.partitions.len());
        for partition in &manifest.partitions {
            let held = partition.segments.iter().fold(0u64, |total, segment| {
                total.saturating_add(segment.file.bytes)
            });
            partitions.push((partition.partition_id, held));
            bytes = bytes.saturating_add(held);
        }
        for field in &manifest.vectors {
            for file in &field.files {
                bytes = bytes.saturating_add(file.file.bytes);
            }
            for part in &field.graph_parts {
                bytes = bytes.saturating_add(part.bytes);
            }
        }
        SavedSize { bytes, partitions }
    }

    /// Returns the bytes of the segments that the manifest lists for `partition_id`.
    pub(crate) fn partition_bytes(&self, partition_id: u32) -> u64 {
        self.partitions
            .iter()
            .find(|(id, _)| *id == partition_id)
            .map_or(0, |(_, bytes)| *bytes)
    }
}
