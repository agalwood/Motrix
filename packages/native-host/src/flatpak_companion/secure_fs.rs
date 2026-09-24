use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::CompanionError;
use super::paths::{CompanionPaths, ManifestFamily, absolute_root};

pub(super) fn read_limited(path: &Path, maximum: u64) -> Result<Vec<u8>, CompanionError> {
    let file = File::open(path).map_err(|error| CompanionError::io("open", path, error))?;
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CompanionError::io("read", path, error))?;
    if bytes.len() as u64 > maximum {
        return Err(CompanionError::new(format!(
            "{} exceeds {maximum} bytes",
            path.display()
        )));
    }
    Ok(bytes)
}

pub(super) fn path_entry_exists(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

pub(super) fn path_entry_is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
}

#[derive(Clone, Copy)]
pub(super) enum OwnerRequirement {
    Current,
    CurrentOrRoot,
}

#[cfg(unix)]
fn effective_user_id() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }

    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    unsafe { geteuid() }
}

fn entry_metadata(path: &Path) -> Result<Option<fs::Metadata>, CompanionError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CompanionError::io("inspect", path, error)),
    }
}

fn validate_owner(
    path: &Path,
    metadata: &fs::Metadata,
    requirement: OwnerRequirement,
) -> Result<(), CompanionError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let owner = metadata.uid();
        let current = effective_user_id();
        let accepted = owner == current
            || matches!(requirement, OwnerRequirement::CurrentOrRoot) && owner == 0;
        if !accepted {
            return Err(CompanionError::new(format!(
                "{} is not owned by the current user{}",
                path.display(),
                if matches!(requirement, OwnerRequirement::CurrentOrRoot) {
                    " or root"
                } else {
                    ""
                }
            )));
        }
    }
    #[cfg(not(unix))]
    let _ = (path, metadata, requirement);
    Ok(())
}

fn validate_directory(
    path: &Path,
    requirement: OwnerRequirement,
    allow_shared_sticky: bool,
) -> Result<(), CompanionError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CompanionError::io("inspect directory", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CompanionError::new(format!(
            "{} is not a real directory",
            path.display()
        )));
    }
    validate_owner(path, &metadata, requirement)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = metadata.permissions().mode();
        if mode & 0o022 != 0 && !(allow_shared_sticky && mode & 0o1000 != 0) {
            return Err(CompanionError::new(format!(
                "{} is writable by another user",
                path.display()
            )));
        }
    }
    #[cfg(not(unix))]
    let _ = allow_shared_sticky;
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<(), CompanionError> {
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    let created = match builder.create(path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(CompanionError::io("create directory", path, error)),
    };
    if !created {
        return validate_directory(path, OwnerRequirement::Current, false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| CompanionError::io("set directory permissions", path, error))?;
    }
    validate_directory(path, OwnerRequirement::Current, false)
}

fn prepare_private_root(root: &Path, create: bool) -> Result<(), CompanionError> {
    match entry_metadata(root)? {
        Some(_) => {
            validate_executable_parent_chain(root)?;
            return validate_directory(root, OwnerRequirement::Current, false);
        }
        None if !create => {
            return Err(CompanionError::new(format!(
                "private root is missing: {}",
                root.display()
            )));
        }
        None => {}
    }

    let mut missing = vec![root.to_path_buf()];
    let mut cursor = root
        .parent()
        .ok_or_else(|| CompanionError::new(format!("{} has no parent", root.display())))?;
    loop {
        match entry_metadata(cursor)? {
            Some(_) => {
                if cursor.parent().is_some() {
                    validate_executable_parent_chain(cursor)?;
                }
                validate_directory(cursor, OwnerRequirement::CurrentOrRoot, true)?;
                break;
            }
            None => missing.push(cursor.to_path_buf()),
        }
        cursor = cursor.parent().ok_or_else(|| {
            CompanionError::new(format!("no existing ancestor for {}", root.display()))
        })?;
    }

    for directory in missing.iter().rev() {
        create_private_directory(directory)?;
    }
    validate_directory(root, OwnerRequirement::Current, false)
}

pub(super) fn validate_private_parent(
    root: &Path,
    path: &Path,
    create: bool,
) -> Result<(), CompanionError> {
    let parent = path
        .parent()
        .ok_or_else(|| CompanionError::new(format!("{} has no parent", path.display())))?;
    let relative = parent.strip_prefix(root).map_err(|_| {
        CompanionError::new(format!(
            "{} escapes private root {}",
            path.display(),
            root.display()
        ))
    })?;
    prepare_private_root(root, create)?;

    let mut directory = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(CompanionError::new(format!(
                "{} has a non-canonical component",
                path.display()
            )));
        };
        directory.push(name);
        match entry_metadata(&directory)? {
            Some(_) => validate_directory(&directory, OwnerRequirement::Current, false)?,
            None if create => create_private_directory(&directory)?,
            None => {
                return Err(CompanionError::new(format!(
                    "private directory is missing: {}",
                    directory.display()
                )));
            }
        }
    }
    Ok(())
}

pub(super) fn validate_existing_private_parent_prefix(
    root: &Path,
    path: &Path,
) -> Result<(), CompanionError> {
    let parent = path
        .parent()
        .ok_or_else(|| CompanionError::new(format!("{} has no parent", path.display())))?;
    let relative = parent.strip_prefix(root).map_err(|_| {
        CompanionError::new(format!(
            "{} escapes private root {}",
            path.display(),
            root.display()
        ))
    })?;
    if entry_metadata(root)?.is_none() {
        return Ok(());
    }
    validate_directory(root, OwnerRequirement::Current, false)?;

    let mut directory = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(CompanionError::new(format!(
                "{} has a non-canonical component",
                path.display()
            )));
        };
        directory.push(name);
        if entry_metadata(&directory)?.is_none() {
            return Ok(());
        }
        validate_directory(&directory, OwnerRequirement::Current, false)?;
    }
    Ok(())
}

pub(super) fn destination_root<'a>(
    paths: &'a CompanionPaths,
    destination: &Path,
) -> Result<&'a Path, CompanionError> {
    if destination == paths.binary {
        return Ok(&paths.data_root);
    }
    if destination == paths.config {
        return Ok(&paths.config_root);
    }
    if let Some(target) = paths
        .manifests
        .iter()
        .find(|target| target.path == destination)
    {
        return Ok(match target.family {
            ManifestFamily::Chromium => &paths.config_root,
            ManifestFamily::Firefox => &paths.home_root,
        });
    }
    Err(CompanionError::new(format!(
        "unknown companion destination: {}",
        destination.display()
    )))
}

pub(super) fn validate_regular_file(
    path: &Path,
    requirement: OwnerRequirement,
    exact_mode: Option<u32>,
    executable: bool,
) -> Result<(), CompanionError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CompanionError::io("inspect file", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CompanionError::new(format!(
            "{} is not a real regular file",
            path.display()
        )));
    }
    validate_owner(path, &metadata, requirement)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = metadata.permissions().mode();
        if let Some(expected) = exact_mode {
            if mode & 0o7777 != expected {
                return Err(CompanionError::new(format!(
                    "{} has mode {:04o}; expected {expected:04o}",
                    path.display(),
                    mode & 0o7777
                )));
            }
        } else if mode & 0o022 != 0 {
            return Err(CompanionError::new(format!(
                "{} is writable by another user",
                path.display()
            )));
        }
        if executable && mode & 0o111 == 0 {
            return Err(CompanionError::new(format!(
                "{} is not executable",
                path.display()
            )));
        }
    }
    #[cfg(not(unix))]
    let _ = (exact_mode, executable);
    Ok(())
}

pub(super) fn validate_private_file(
    paths: &CompanionPaths,
    path: &Path,
    expected_mode: u32,
) -> Result<(), CompanionError> {
    validate_private_parent(destination_root(paths, path)?, path, false)?;
    validate_regular_file(
        path,
        OwnerRequirement::Current,
        Some(expected_mode),
        expected_mode == 0o700,
    )
}

fn validate_executable_parent_chain(path: &Path) -> Result<(), CompanionError> {
    let parent = path
        .parent()
        .ok_or_else(|| CompanionError::new(format!("{} has no parent", path.display())))?;
    let mut ancestors = parent.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for directory in ancestors {
        validate_directory(directory, OwnerRequirement::CurrentOrRoot, true)?;
    }
    Ok(())
}

pub(super) fn validate_source_executable(path: &Path) -> Result<PathBuf, CompanionError> {
    absolute_root(path.as_os_str(), "companion executable")?;
    validate_regular_file(path, OwnerRequirement::Current, None, true)?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| CompanionError::io("resolve companion executable", path, error))?;
    validate_executable_parent_chain(&canonical)?;
    Ok(canonical)
}

fn temporary_path(destination: &Path, attempt: u32) -> Result<PathBuf, CompanionError> {
    let parent = destination
        .parent()
        .ok_or_else(|| CompanionError::new("destination has no parent"))?;
    let name = destination
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| CompanionError::new("destination name must be UTF-8"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(parent.join(format!(
        ".{name}.{}.{}.{}.tmp",
        std::process::id(),
        timestamp,
        attempt
    )))
}

fn rename_replace(source: &Path, destination: &Path) -> Result<(), CompanionError> {
    #[cfg(windows)]
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| CompanionError::io("remove old file", destination, error))?;
    }
    fs::rename(source, destination)
        .map_err(|error| CompanionError::io("replace file", destination, error))
}

pub(super) fn atomic_write(
    root: &Path,
    destination: &Path,
    bytes: &[u8],
    executable: bool,
) -> Result<(), CompanionError> {
    #[cfg(not(unix))]
    let _ = executable;
    validate_private_parent(root, destination, true)?;
    for attempt in 0..16 {
        let temporary = temporary_path(destination, attempt)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if executable { 0o700 } else { 0o600 });
        }
        let mut file = match options.open(&temporary) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(CompanionError::io(
                    "create temporary file",
                    &temporary,
                    error,
                ));
            }
        };
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            let _ = fs::remove_file(&temporary);
            return Err(CompanionError::io(
                "write temporary file",
                &temporary,
                error,
            ));
        }
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if executable { 0o700 } else { 0o600 };
            if let Err(error) = fs::set_permissions(&temporary, fs::Permissions::from_mode(mode)) {
                let _ = fs::remove_file(&temporary);
                return Err(CompanionError::io("set permissions", &temporary, error));
            }
        }
        if let Err(error) = rename_replace(&temporary, destination) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        validate_regular_file(
            destination,
            OwnerRequirement::Current,
            Some(if executable { 0o700 } else { 0o600 }),
            executable,
        )?;
        return Ok(());
    }
    Err(CompanionError::new(format!(
        "could not allocate a temporary file for {}",
        destination.display()
    )))
}

pub(super) fn atomic_copy(
    source: &Path,
    root: &Path,
    destination: &Path,
) -> Result<(), CompanionError> {
    let bytes = read_limited(source, 64 * 1024 * 1024)?;
    atomic_write(root, destination, &bytes, true)
}

pub(super) fn validate_flatpak_binary(path: &Path) -> Result<PathBuf, CompanionError> {
    absolute_root(path.as_os_str(), "flatpak binary")?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| CompanionError::io("resolve flatpak binary", path, error))?;
    absolute_root(canonical.as_os_str(), "resolved flatpak binary")?;
    validate_executable_parent_chain(&canonical)?;
    validate_regular_file(&canonical, OwnerRequirement::CurrentOrRoot, None, true)?;
    Ok(canonical)
}
