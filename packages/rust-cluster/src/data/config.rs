use narsil::NarsilConfig;

/// The settings that a node with the `data` role keeps its copies of partitions with.
#[derive(Debug, Clone)]
pub struct DataNodeConfig {
    /// What the node opens its local engine with as it joins. The node closes that engine as it leaves, and no
    /// other engine may hold the same directory meanwhile.
    pub engine: NarsilConfig,
}

impl DataNodeConfig {
    /// Returns the settings of a data node whose local engine opens with `engine`.
    pub fn new(engine: NarsilConfig) -> DataNodeConfig {
        DataNodeConfig { engine }
    }
}
