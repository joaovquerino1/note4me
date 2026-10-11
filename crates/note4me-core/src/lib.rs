//! note4me core: everything that touches the user's files.
//!
//! The Markdown files in a vault are the source of truth. Anything this
//! crate stores elsewhere (index, history, trash, UI state) is optional,
//! lives under `<vault>/.note4me/`, and can be deleted without losing a
//! single character of content.

pub mod attachments;
pub mod collections;
pub mod drafts;
pub mod error;
pub mod fsio;
pub mod history;
pub mod import_export;
pub mod index;
pub mod markdown;
pub mod paths;
pub mod settings;
pub mod state;
pub mod themes;
pub mod trash;
pub mod workspace;

pub use error::{CoreError, Result};
pub use paths::RelPath;
