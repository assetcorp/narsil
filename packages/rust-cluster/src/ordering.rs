use std::cmp::Ordering;

pub(crate) fn utf16_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub(crate) fn utf16_difference(left: &str, right: &str) -> f64 {
    match utf16_order(left, right) {
        Ordering::Less => -1.0,
        Ordering::Greater => 1.0,
        Ordering::Equal => 0.0,
    }
}

fn leading_run<T>(items: &mut [T], compare: &mut impl FnMut(&T, &T) -> f64) -> usize {
    if items.len() < 2 {
        return items.len();
    }
    let descending = compare(&items[1], &items[0]) < 0.0;
    let mut length = 2;
    while length < items.len() {
        let order = compare(&items[length], &items[length - 1]);
        let continues = if descending {
            order < 0.0
        } else {
            order >= 0.0
        };
        if !continues {
            break;
        }
        length += 1;
    }
    if descending {
        items[..length].reverse();
    }
    length
}

pub(crate) fn comparator_sort<T>(items: &mut [T], mut compare: impl FnMut(&T, &T) -> f64) {
    let sorted = leading_run(items, &mut compare);
    for start in sorted.max(1)..items.len() {
        let mut left = 0;
        let mut right = start;
        while left < right {
            let middle = left + ((right - left) >> 1);
            if compare(&items[start], &items[middle]) < 0.0 {
                right = middle;
            } else {
                left = middle + 1;
            }
        }
        items[left..=start].rotate_right(1);
    }
}
