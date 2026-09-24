use std::io;
use std::path::{Component, Path};

pub(crate) fn validate_relative(relative: &str) -> io::Result<Vec<&str>> {
    let path = Path::new(relative);
    if relative.is_empty() || path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must be non-empty and relative",
        ));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let Some(part) = part.to_str() else {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "path is not UTF-8",
                    ));
                };
                if part.as_bytes().contains(&0) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "path contains NUL",
                    ));
                }
                parts.push(part);
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "path traversal is forbidden",
                ));
            }
        }
    }
    if parts.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must name an artifact",
        ));
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::validate_relative;

    #[test]
    fn relative_paths_reject_traversal() {
        assert!(validate_relative("artifact/file").is_ok());
        assert!(validate_relative("../escape").is_err());
        assert!(validate_relative("/absolute").is_err());
        assert!(validate_relative(".").is_err());
    }
}
