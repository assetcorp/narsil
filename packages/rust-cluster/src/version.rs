use crate::constants::{MAX_SAFE_INTEGER, SPEC_VERSION};

fn whole_part(digits: &str) -> Option<f64> {
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: f64 = digits.parse().ok()?;
    (value <= MAX_SAFE_INTEGER as f64).then_some(value)
}

fn split_version(version: &str) -> Option<(&str, &str)> {
    let (major, minor) = version.split_once('.')?;
    let well_formed = !major.is_empty()
        && !minor.is_empty()
        && major.bytes().all(|byte| byte.is_ascii_digit())
        && minor.bytes().all(|byte| byte.is_ascii_digit());
    well_formed.then_some((major, minor))
}

fn version_parts(version: &str) -> Option<(f64, f64)> {
    let (major, minor) = split_version(version)?;
    Some((whole_part(major)?, whole_part(minor)?))
}

fn major_of(version: &str) -> Option<f64> {
    whole_part(split_version(version)?.0)
}

pub(crate) fn reaches_version(version: &str, minimum: &str) -> bool {
    let (Some(parts), Some(required)) = (version_parts(version), version_parts(minimum)) else {
        return false;
    };
    parts.0 > required.0 || (parts.0 == required.0 && parts.1 >= required.1)
}

pub(crate) fn shares_major_version_with(version: &str, reference: &str) -> bool {
    match (major_of(version), major_of(reference)) {
        (Some(major), Some(reference_major)) => major == reference_major,
        _ => false,
    }
}

pub(crate) fn shares_major_version(version: &str) -> bool {
    shares_major_version_with(version, SPEC_VERSION)
}
