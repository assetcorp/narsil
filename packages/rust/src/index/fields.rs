/// Ranks each field name by code point order, so that the core adds one document's field scores in the order that
/// Score Arithmetic sets.
pub(crate) fn name_ranks(names: &[String]) -> Vec<u16> {
    let mut order: Vec<usize> = (0..names.len()).collect();
    order.sort_by(|&left, &right| names[left].cmp(&names[right]));
    let mut ranks = vec![0u16; names.len()];
    for (rank, &field) in order.iter().enumerate() {
        ranks[field] = rank.min(u16::MAX as usize) as u16;
    }
    ranks
}
