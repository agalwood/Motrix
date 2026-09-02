use super::{
    copy_opened, open_artifact, open_root, remove_opened, rename_opened_no_replace, sync_root,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "motrix-finalize-fs-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create scratch directory");
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rejects_ambiguous_windows_path_components() {
    for component in [
        "file.",
        "file ",
        "payload:stream",
        "CON",
        "lpt9.txt",
        "COM¹.log",
        "nested/name",
    ] {
        assert!(
            super::nt::wide_name(component).is_err(),
            "{component:?} must be rejected"
        );
    }
    assert!(super::nt::wide_name("资料.zip").is_ok());
}

#[test]
fn copies_and_removes_a_held_directory_without_following_paths() {
    let scratch = Scratch::new("copy-remove");
    let source = scratch.path().join("source");
    fs::create_dir_all(source.join("nested")).expect("create source tree");
    fs::write(source.join("nested").join("payload.bin"), b"payload").expect("write source payload");

    let root =
        open_root(scratch.path().to_str().expect("UTF-8 scratch path")).expect("open held root");
    let source_handle = open_artifact(&root, "source").expect("open source artifact");
    copy_opened(&source_handle, &root, "private-target").expect("copy held tree");
    assert_eq!(
        fs::read(scratch.path().join("private-target/nested/payload.bin"))
            .expect("read copied payload"),
        b"payload"
    );
    sync_root(&root).expect("flush held root");

    let copied = open_artifact(&root, "private-target").expect("open copied artifact");
    remove_opened(&copied, ".motrix-remove", false).expect("remove held copied tree");
    drop(copied);
    assert!(!scratch.path().join("private-target").exists());
    assert!(!scratch.path().join(".motrix-remove").exists());
}

#[test]
fn rename_is_atomic_and_never_replaces_an_existing_target() {
    let scratch = Scratch::new("rename");
    fs::write(scratch.path().join("source.bin"), b"source").expect("write source");
    fs::write(scratch.path().join("target.bin"), b"target").expect("write target");
    let root =
        open_root(scratch.path().to_str().expect("UTF-8 scratch path")).expect("open held root");
    let source = open_artifact(&root, "source.bin").expect("open source");

    assert!(rename_opened_no_replace(&source, &root, "target.bin").is_err());
    assert_eq!(
        fs::read(scratch.path().join("source.bin")).unwrap(),
        b"source"
    );
    assert_eq!(
        fs::read(scratch.path().join("target.bin")).unwrap(),
        b"target"
    );

    rename_opened_no_replace(&source, &root, "published.bin").expect("publish source");
    sync_root(&root).expect("flush rename");
    assert!(!scratch.path().join("source.bin").exists());
    assert_eq!(
        fs::read(scratch.path().join("published.bin")).unwrap(),
        b"source"
    );
}

#[test]
fn rejects_a_junction_in_the_root_path() {
    let scratch = Scratch::new("junction");
    let real = scratch.path().join("real");
    let junction = scratch.path().join("junction");
    fs::create_dir_all(real.join("child")).expect("create junction target");
    let status = Command::new("cmd")
        .arg("/c")
        .arg("mklink")
        .arg("/J")
        .arg(&junction)
        .arg(&real)
        .status()
        .expect("run mklink");
    assert!(
        status.success(),
        "mklink /J must succeed for the contract test"
    );

    let result = open_root(
        junction
            .join("child")
            .to_str()
            .expect("UTF-8 junction path"),
    );
    assert!(result.is_err(), "held root traversal must reject junctions");

    let _ = Command::new("cmd")
        .arg("/c")
        .arg("rmdir")
        .arg(&junction)
        .status();
}
