use serde::{Serialize, Serializer};

/// Unified error type returned across the Tauri IPC boundary.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("{0}")]
    Msg(String),
    #[error("windows api error: {0}")]
    Win(#[from] windows::core::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl Serialize for CoreError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<String> for CoreError {
    fn from(value: String) -> Self {
        CoreError::Msg(value)
    }
}

impl From<&str> for CoreError {
    fn from(value: &str) -> Self {
        CoreError::Msg(value.to_string())
    }
}

pub type CoreResult<T> = Result<T, CoreError>;
