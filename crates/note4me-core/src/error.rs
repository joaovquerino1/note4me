//! Structured errors shared by every core operation.
//!
//! Errors are serialised to the UI as `{ kind, message, path }`. Messages never
//! include document content — at most a vault-relative path, which the user
//! already knows about.

use serde::Serialize;
use std::io;

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum CoreError {
    #[error("Não encontrado: {0}")]
    NotFound(String),
    #[error("Já existe: {0}")]
    AlreadyExists(String),
    #[error("Caminho inválido: {0}")]
    InvalidPath(String),
    #[error("Nome inválido: {0}")]
    InvalidName(String),
    #[error("Sem permissão para acessar: {0}")]
    PermissionDenied(String),
    #[error("Não há espaço suficiente no disco")]
    NoSpace,
    #[error("O volume está somente leitura ou indisponível: {0}")]
    ReadOnly(String),
    #[error("O arquivo não está em UTF-8 válido: {0}")]
    InvalidEncoding(String),
    #[error("O arquivo excede o limite configurado: {0}")]
    TooLarge(String),
    #[error("O frontmatter YAML é inválido: {0}")]
    InvalidFrontmatter(String),
    #[error("Dados inválidos: {0}")]
    Validation(String),
    #[error("Erro de E/S em {path}: {message}")]
    Io { path: String, message: String },
}

impl CoreError {
    pub fn kind(&self) -> &'static str {
        match self {
            CoreError::NotFound(_) => "notFound",
            CoreError::AlreadyExists(_) => "alreadyExists",
            CoreError::InvalidPath(_) => "invalidPath",
            CoreError::InvalidName(_) => "invalidName",
            CoreError::PermissionDenied(_) => "permissionDenied",
            CoreError::NoSpace => "noSpace",
            CoreError::ReadOnly(_) => "readOnly",
            CoreError::InvalidEncoding(_) => "invalidEncoding",
            CoreError::TooLarge(_) => "tooLarge",
            CoreError::InvalidFrontmatter(_) => "invalidFrontmatter",
            CoreError::Validation(_) => "validation",
            CoreError::Io { .. } => "io",
        }
    }

    /// Maps an `io::Error` to a user-meaningful variant. `path` must be the
    /// vault-relative path (or a file name) — never an absolute path with the
    /// user's home directory when avoidable.
    pub fn from_io(err: io::Error, path: impl Into<String>) -> Self {
        let path = path.into();
        match err.kind() {
            io::ErrorKind::NotFound => CoreError::NotFound(path),
            io::ErrorKind::AlreadyExists => CoreError::AlreadyExists(path),
            io::ErrorKind::PermissionDenied => CoreError::PermissionDenied(path),
            io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => CoreError::NoSpace,
            io::ErrorKind::ReadOnlyFilesystem => CoreError::ReadOnly(path),
            io::ErrorKind::InvalidData => CoreError::InvalidEncoding(path),
            _ => {
                // ENOSPC / EROFS / ENXIO on platforms where std does not map them.
                match err.raw_os_error() {
                    Some(28) => CoreError::NoSpace,
                    Some(30) => CoreError::ReadOnly(path),
                    Some(6) | Some(5) => CoreError::ReadOnly(path),
                    _ => CoreError::Io {
                        path,
                        message: err.to_string(),
                    },
                }
            }
        }
    }
}

#[derive(Serialize)]
struct WireError<'a> {
    kind: &'a str,
    message: String,
}

impl Serialize for CoreError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        WireError {
            kind: self.kind(),
            message: self.to_string(),
        }
        .serialize(s)
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_io_kinds() {
        let e = CoreError::from_io(io::Error::from(io::ErrorKind::PermissionDenied), "a.md");
        assert_eq!(e.kind(), "permissionDenied");
        let e = CoreError::from_io(io::Error::from_raw_os_error(28), "a.md");
        assert_eq!(e, CoreError::NoSpace);
    }

    #[test]
    fn serialises_without_content() {
        let json = serde_json::to_string(&CoreError::NotFound("Notas/A.md".into())).unwrap();
        assert!(json.contains("\"kind\":\"notFound\""));
    }
}
