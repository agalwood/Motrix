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
