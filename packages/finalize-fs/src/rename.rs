//! Rename completion describes namespace mutation separately from durability.

use crate::error::operation_error;
use std::io;

#[derive(Debug)]
pub(crate) struct RenameOutcome {
    pub(crate) directory_sync_mode: &'static str,
}

/// Compare held directory identities before mutation; never deduplicate by path.
pub(crate) fn sync_parents(
    same_parent: bool,
    mut sync: impl FnMut(bool) -> io::Result<&'static str>,
) -> io::Result<RenameOutcome> {
    let target =
        sync(true).map_err(|e| operation_error(e, "sync_target_parent", "applied", None))?;
    let source = if same_parent {
        target
    } else {
        sync(false).map_err(|e| operation_error(e, "sync_source_parent", "applied", None))?
    };
    Ok(RenameOutcome {
        directory_sync_mode: if target == "remote_acknowledged" || source == "remote_acknowledged" {
            "remote_acknowledged"
        } else {
            "directory_flushed"
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_directory_flushes_once_and_distinct_directories_flush_target_first() {
        for same in [true, false] {
            let mut calls = Vec::new();
            let outcome = sync_parents(same, |target| {
                calls.push(target);
                Ok("directory_flushed")
            })
            .unwrap();
            assert_eq!(calls, if same { vec![true] } else { vec![true, false] });
            assert_eq!(outcome.directory_sync_mode, "directory_flushed");
        }
    }

    #[test]
    fn sync_failure_preserves_the_applied_mutation_and_native_error() {
        for fail_target in [true, false] {
            let error = sync_parents(false, |target| {
                if target == fail_target {
                    Err(io::Error::from_raw_os_error(5))
                } else {
                    Ok("directory_flushed")
                }
            })
            .unwrap_err();
            let context = crate::error::operation_context(&error).unwrap();
            assert_eq!(context.mutation, "applied");
            assert_eq!(
                context.stage,
                if fail_target {
                    "sync_target_parent"
                } else {
                    "sync_source_parent"
                }
            );
            assert_eq!(crate::error::os_code(&error), Some(5));
        }
    }

    #[test]
    fn remote_acknowledgement_is_not_reported_as_a_directory_flush() {
        for remote_target in [true, false] {
            let outcome = sync_parents(false, |target| {
                Ok(if target == remote_target {
                    "remote_acknowledged"
                } else {
                    "directory_flushed"
                })
            })
            .unwrap();
            assert_eq!(outcome.directory_sync_mode, "remote_acknowledged");
        }
    }
}
