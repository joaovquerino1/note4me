//! Installed font families, queried at runtime so the UI never offers a
//! font that is not actually available.

#[cfg(target_os = "macos")]
pub fn installed_families() -> Vec<String> {
    let names = core_text::font_collection::get_family_names();
    let mut out: Vec<String> = names.iter().map(|n| n.to_string()).filter(|n| !n.starts_with('.')).collect();
    out.sort_by_key(|n| n.to_lowercase());
    out.dedup();
    out
}

#[cfg(not(target_os = "macos"))]
pub fn installed_families() -> Vec<String> {
    Vec::new()
}
