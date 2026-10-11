//! Markdown processing that the core needs: frontmatter, links and plain
//! text for indexing. Rich editing happens in the UI layer; the core treats
//! bodies as opaque text and only edits the exact byte ranges it owns.

pub mod frontmatter;
pub mod links;
pub mod text;
