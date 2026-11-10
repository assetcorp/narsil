use crate::util::case_fold::append_folded;

pub(crate) fn folded_code_point_count(text: &str) -> usize {
    let mut folded = Vec::with_capacity(text.len());
    for character in text.chars() {
        append_folded(character as u32, &mut folded);
    }
    folded.len()
}
