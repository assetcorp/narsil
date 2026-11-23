use super::DataRole;

impl DataRole {
    pub(crate) fn keeps_write_ahead_log(&self) -> bool {
        self.config
            .engine
            .durability
            .as_ref()
            .is_some_and(|durability| {
                durability.directory.is_some()
                    && durability.tier != Some(narsil::DurabilityTier::Snapshot)
            })
    }
}
