use super::digest::Sha256State;
use super::{open_artifact, open_root, remove_opened};
#[cfg(target_os = "macos")]
use super::{rename_no_replace, rename_opened_no_replace};
#[cfg(target_os = "macos")]
use std::io;

#[test]
fn held_file_digest_uses_sha256() {
    let mut hash = Sha256State::new();
    hash.update(b"abc");
    assert_eq!(
        hash.finalize(),
        [
            0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
            0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
            0xf2, 0x00, 0x15, 0xad,
        ]
    );
}

#[test]
fn open_root_rejects_an_intermediate_symbolic_link() {
    use std::os::unix::fs::symlink;

    let base = std::env::temp_dir().join(format!("motrix-finalize-fs-root-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("real/child")).unwrap();
    let base = base.canonicalize().unwrap();
    symlink(base.join("real"), base.join("link")).unwrap();

    let error = match open_root(base.join("link/child").to_str().unwrap()) {
        Ok(_) => panic!("intermediate symbolic link was accepted"),
        Err(error) => error,
    };
    assert!(matches!(
        error.raw_os_error(),
        Some(libc::ELOOP) | Some(libc::ENOTDIR)
    ));
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn held_remove_rejects_a_replaced_name_and_preserves_the_replacement() {
    let base = std::env::temp_dir().join(format!(
        "motrix-finalize-fs-remove-race-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let base = base.canonicalize().unwrap();
    std::fs::write(base.join("artifact"), b"original").unwrap();
    let root = open_root(base.to_str().unwrap()).unwrap();
    let artifact = open_artifact(&root, "artifact").unwrap();
    std::fs::rename(base.join("artifact"), base.join("original-moved")).unwrap();
    std::fs::write(base.join("artifact"), b"replacement").unwrap();

    assert!(remove_opened(&artifact, ".motrix-finalize-remove-race", false).is_err());
    assert_eq!(
        std::fs::read(base.join("artifact")).unwrap(),
        b"replacement"
    );
    assert_eq!(
        std::fs::read(base.join("original-moved")).unwrap(),
        b"original"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn held_remove_deletes_a_verified_directory_tree() {
    let base = std::env::temp_dir().join(format!(
        "motrix-finalize-fs-remove-tree-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("artifact/nested")).unwrap();
    let base = base.canonicalize().unwrap();
    std::fs::write(base.join("artifact/nested/payload"), b"payload").unwrap();
    let root = open_root(base.to_str().unwrap()).unwrap();
    let artifact = open_artifact(&root, "artifact").unwrap();

    remove_opened(&artifact, ".motrix-finalize-remove-tree", false).unwrap();
    assert!(!base.join("artifact").exists());
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn held_remove_preserves_a_tree_changed_after_open() {
    let base = std::env::temp_dir().join(format!(
        "motrix-finalize-fs-remove-tree-race-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("artifact/nested")).unwrap();
    let base = base.canonicalize().unwrap();
    std::fs::write(base.join("artifact/nested/original"), b"original").unwrap();
    let root = open_root(base.to_str().unwrap()).unwrap();
    let artifact = open_artifact(&root, "artifact").unwrap();
    std::fs::write(base.join("artifact/nested/inserted"), b"inserted").unwrap();

    let quarantine_name = ".motrix-finalize-remove-tree-race";
    assert!(remove_opened(&artifact, quarantine_name, false).is_err());
    assert!(!base.join("artifact").exists());
    let quarantined = base.join(quarantine_name);
    assert!(quarantined.exists());
    assert_eq!(
        std::fs::read(quarantined.join("nested/original")).unwrap(),
        b"original"
    );
    assert_eq!(
        std::fs::read(quarantined.join("nested/inserted")).unwrap(),
        b"inserted"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn held_remove_resumes_an_exact_persisted_quarantine() {
    let base = std::env::temp_dir().join(format!(
        "motrix-finalize-fs-remove-resume-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let base = base.canonicalize().unwrap();
    let quarantine_name = ".motrix-finalize-remove-resume";
    std::fs::write(base.join(quarantine_name), b"preserved").unwrap();
    let root = open_root(base.to_str().unwrap()).unwrap();
    let artifact = open_artifact(&root, quarantine_name).unwrap();

    remove_opened(&artifact, quarantine_name, true).unwrap();

    assert!(!base.join(quarantine_name).exists());
    let _ = std::fs::remove_dir_all(&base);
}

#[cfg(target_os = "macos")]
#[test]
fn darwin_rename_is_no_replace_for_files_and_directories() {
    let base = std::env::temp_dir().join(format!("motrix-finalize-fs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("source/tree")).unwrap();
    std::fs::create_dir_all(base.join("target")).unwrap();
    let base = base.canonicalize().unwrap();
    std::fs::write(base.join("source/file"), b"source").unwrap();
    std::fs::write(base.join("target/file"), b"target").unwrap();
    let source = open_root(base.join("source").to_str().unwrap()).unwrap();
    let target = open_root(base.join("target").to_str().unwrap()).unwrap();
    let error = rename_no_replace(&source, "file", &target, "file").unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(std::fs::read(base.join("target/file")).unwrap(), b"target");
    rename_no_replace(&source, "tree", &target, "tree").unwrap();
    assert!(base.join("target/tree").is_dir());

    std::fs::write(base.join("source/opened"), b"held").unwrap();
    let opened = open_artifact(&source, "opened").unwrap();
    rename_opened_no_replace(&opened, &target, "opened").unwrap();
    assert_eq!(std::fs::read(base.join("target/opened")).unwrap(), b"held");
    let _ = std::fs::remove_dir_all(base);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn rename_only_handles_do_not_read_large_payloads_or_authorize_removal() {
    let base = std::env::temp_dir().join(format!("motrix-rename-large-{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();
    let base = base.canonicalize().unwrap();
    let file = std::fs::File::create(base.join("source")).unwrap();
    file.set_len(68 * 1024 * 1024 * 1024).unwrap();
    drop(file);
    let root = open_root(base.to_str().unwrap()).unwrap();
    let artifact = super::open_artifact_for_rename(&root, "source").unwrap();
    assert!(artifact.opened_file_sha256.is_none());
    assert!(artifact.opened_tree.is_none());
    assert!(super::copy_opened(&artifact, &root, "copy").is_err());
    assert!(remove_opened(&artifact, ".quarantine", false).is_err());
    assert!(base.join("source").exists());
    super::rename_opened_no_replace(&artifact, &root, "target").unwrap();
    assert_eq!(
        std::fs::metadata(base.join("target")).unwrap().len(),
        68 * 1024 * 1024 * 1024
    );
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn private_isolation_checks_identity_permissions_and_resumes_removal() {
    use std::os::unix::fs::PermissionsExt;
    let base = std::env::temp_dir().join(format!("motrix-isolate-{}", std::process::id()));
    std::fs::create_dir_all(base.join("private")).unwrap();
    std::fs::set_permissions(base.join("private"), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(base.join("source"), b"complete").unwrap();
    let base = base.canonicalize().unwrap();
    let source = open_root(base.to_str().unwrap()).unwrap();
    let private = open_root(base.join("private").to_str().unwrap()).unwrap();
    let artifact = super::open_artifact_for_rename(&source, "source").unwrap();
    let stat = super::metadata::stat_opened(std::os::fd::AsRawFd::as_raw_fd(&private.0)).unwrap();
    let id = format!("{}:{}", stat.st_dev, stat.st_ino);
    assert!(super::isolate_opened(&artifact, &private, "payload", "wrong-id").is_err());
    std::fs::write(base.join("private/payload"), b"unrelated").unwrap();
    assert!(super::isolate_opened(&artifact, &private, "payload", &id).is_err());
    assert_eq!(
        std::fs::read(base.join("private/payload")).unwrap(),
        b"unrelated"
    );
    std::fs::remove_file(base.join("private/payload")).unwrap();
    std::fs::set_permissions(base.join("private"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(super::isolate_opened(&artifact, &private, "payload", &id).is_err());
    std::fs::set_permissions(base.join("private"), std::fs::Permissions::from_mode(0o700)).unwrap();
    super::isolate_opened(&artifact, &private, "payload", &id).unwrap();
    assert!(!base.join("source").exists());
    drop(artifact);
    let isolated = open_artifact(&private, "payload").unwrap();
    remove_opened(&isolated, "payload", true).unwrap();
    drop(isolated);
    assert!(!base.join("private/payload").exists());
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn held_link_is_exclusive_and_preserves_the_source() {
    let base = std::env::temp_dir().join(format!("motrix-link-{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();
    let base = base.canonicalize().unwrap();
    std::fs::write(base.join("source"), b"complete").unwrap();
    std::fs::write(base.join("conflict"), b"unrelated").unwrap();
    let root = open_root(base.to_str().unwrap()).unwrap();
    let mut artifact = super::open_artifact_for_rename(&root, "source").unwrap();
    assert_eq!(
        super::link_opened_no_replace(&artifact, &root, "conflict")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::AlreadyExists
    );
    super::link_opened_no_replace(&artifact, &root, "target").unwrap();
    assert_eq!(std::fs::read(base.join("source")).unwrap(), b"complete");
    assert_eq!(std::fs::read(base.join("target")).unwrap(), b"complete");
    assert_eq!(std::fs::read(base.join("conflict")).unwrap(), b"unrelated");
    // Model an inode timestamp tick shared by open and link. A real hard link
    // changes nlink even when ctime does not advance; never sleep to force it.
    let linked =
        super::metadata::stat_opened(std::os::fd::AsRawFd::as_raw_fd(&artifact.artifact)).unwrap();
    assert_eq!(linked.st_nlink, 2);
    artifact.opened_stamp.changed_seconds = linked.st_ctime;
    artifact.opened_stamp.changed_nanoseconds = linked.st_ctime_nsec;
    assert_eq!(
        super::link_opened_no_replace(&artifact, &root, "second")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::InvalidData
    );
    assert!(!base.join("second").exists());
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires MOTRIX_FINALIZE_NFS_ROOT pointing at a writable NFS mount"]
fn nfs_supports_link_publication_and_private_removal() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let parent = std::env::var("MOTRIX_FINALIZE_NFS_ROOT").expect("NFS test root");
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base =
        std::path::Path::new(&parent).join(format!("motrix-nfs-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&base).unwrap();
    let root = open_root(base.to_str().unwrap()).unwrap();
    assert_eq!(
        rustix::fs::fstatfs(&root.0).unwrap().f_type as u64,
        0x6969,
        "test root must really be NFS"
    );
    std::fs::write(base.join("source.motrix"), b"complete download").unwrap();
    let artifact = super::open_artifact_for_rename(&root, "source.motrix").unwrap();
    let error = super::rename_opened_no_replace(&artifact, &root, "target").unwrap_err();
    assert_eq!(crate::error::classify_error(&error), "rename_unsupported");
    assert_eq!(crate::error::os_code(&error), Some(libc::EINVAL));
    super::link_opened_no_replace(&artifact, &root, "target").unwrap();
    drop(artifact);
    assert_eq!(
        std::fs::metadata(base.join("source.motrix")).unwrap().ino(),
        std::fs::metadata(base.join("target")).unwrap().ino()
    );
    let source = super::open_artifact_for_rename(&root, "source.motrix").unwrap();
    assert_eq!(
        super::link_opened_no_replace(&source, &root, "target")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::AlreadyExists
    );
    std::fs::create_dir(base.join("private")).unwrap();
    std::fs::set_permissions(base.join("private"), std::fs::Permissions::from_mode(0o700)).unwrap();
    let private = open_root(base.join("private").to_str().unwrap()).unwrap();
    let metadata = std::fs::metadata(base.join("private")).unwrap();
    super::isolate_opened(
        &source,
        &private,
        "payload",
        &format!("{}:{}", metadata.dev(), metadata.ino()),
    )
    .unwrap();
    drop(source);
    let isolated = open_artifact(&private, "payload").unwrap();
    remove_opened(&isolated, "payload", true).unwrap();
    drop(isolated);
    assert!(!base.join("source.motrix").exists());
    assert_eq!(
        std::fs::read(base.join("target")).unwrap(),
        b"complete download"
    );
    std::fs::remove_dir_all(base).unwrap();
}
