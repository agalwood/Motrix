//! Handle registry and request dispatch, independent of platform syscalls.

use crate::error::classify_error;
use crate::platform::{
    ArtifactHandle, RootHandle, copy_opened, open_artifact, open_root, remove_opened,
    rename_no_replace, rename_opened_no_replace, sync_root,
};
use crate::protocol::{Request, Response};
use std::collections::HashMap;

pub(crate) struct State {
    next_handle: u64,
    roots: HashMap<u64, RootHandle>,
    artifacts: HashMap<u64, ArtifactHandle>,
}

impl State {
    pub(crate) fn new() -> Self {
        Self {
            next_handle: 1,
            roots: HashMap::new(),
            artifacts: HashMap::new(),
        }
    }

    pub(crate) fn handle(&mut self, request: Request) -> Response<'static> {
        match request {
            Request::Capabilities => self.capabilities(),
            Request::OpenRoot { request_id, path } => match open_root(&path) {
                Ok(root) => {
                    let handle = self.insert_root(root);
                    let mut response = Response::ok(Some(request_id));
                    response.handle = Some(handle);
                    response
                }
                Err(error) => Response::error(Some(request_id), classify_error(&error), error),
            },
            Request::OpenArtifact {
                request_id,
                root,
                relative,
            } => {
                let Some(root) = self.roots.get(&root) else {
                    return Response::error(Some(request_id), "invalid_handle", "unknown root");
                };
                match open_artifact(root, &relative) {
                    Ok(artifact) => {
                        let handle = self.insert_artifact(artifact);
                        let mut response = Response::ok(Some(request_id));
                        response.handle = Some(handle);
                        response
                    }
                    Err(error) => Response::error(Some(request_id), classify_error(&error), error),
                }
            }
            Request::RenameOpenedNoReplace {
                request_id,
                artifact,
                target_root,
                target_relative,
            } => {
                let Some(artifact) = self.artifacts.get(&artifact) else {
                    return Response::error(Some(request_id), "invalid_handle", "unknown artifact");
                };
                let Some(target) = self.roots.get(&target_root) else {
                    return Response::error(
                        Some(request_id),
                        "invalid_handle",
                        "unknown target root",
                    );
                };
                operation_response(
                    request_id,
                    rename_opened_no_replace(artifact, target, &target_relative),
                )
            }
            Request::CopyOpened {
                request_id,
                artifact,
                target_root,
                target_relative,
            } => {
                let Some(artifact) = self.artifacts.get(&artifact) else {
                    return Response::error(Some(request_id), "invalid_handle", "unknown artifact");
                };
                let Some(target) = self.roots.get(&target_root) else {
                    return Response::error(
                        Some(request_id),
                        "invalid_handle",
                        "unknown target root",
                    );
                };
                operation_response(request_id, copy_opened(artifact, target, &target_relative))
            }
            Request::RenameNoReplace {
                request_id,
                source_root,
                source_relative,
                target_root,
                target_relative,
            } => {
                let Some(source) = self.roots.get(&source_root) else {
                    return Response::error(
                        Some(request_id),
                        "invalid_handle",
                        "unknown source root",
                    );
                };
                let Some(target) = self.roots.get(&target_root) else {
                    return Response::error(
                        Some(request_id),
                        "invalid_handle",
                        "unknown target root",
                    );
                };
                operation_response(
                    request_id,
                    rename_no_replace(source, &source_relative, target, &target_relative),
                )
            }
            Request::RemoveOpened {
                request_id,
                artifact,
                quarantine_relative,
                resume_isolated,
            } => {
                let Some(artifact) = self.artifacts.get(&artifact) else {
                    return Response::error(Some(request_id), "invalid_handle", "unknown artifact");
                };
                operation_response(
                    request_id,
                    remove_opened(artifact, &quarantine_relative, resume_isolated),
                )
            }
            Request::SyncRoot { request_id, root } => {
                let Some(root) = self.roots.get(&root) else {
                    return Response::error(Some(request_id), "invalid_handle", "unknown root");
                };
                operation_response(request_id, sync_root(root))
            }
            Request::Close { request_id, handle } => {
                if self.roots.remove(&handle).is_some() || self.artifacts.remove(&handle).is_some()
                {
                    Response::ok(Some(request_id))
                } else {
                    Response::error(Some(request_id), "invalid_handle", "unknown handle")
                }
            }
        }
    }

    fn capabilities(&self) -> Response<'static> {
        let mut response = Response::ok(None);
        response.platform = Some(std::env::consts::OS);
        response.rename_no_replace =
            Some(cfg!(any(target_os = "macos", target_os = "linux", windows)));
        response.held_roots = Some(cfg!(any(unix, windows)));
        response.directory_sync = Some(cfg!(any(unix, windows)));
        response.held_artifacts = Some(cfg!(any(unix, windows)));
        response
    }

    fn next_handle(&mut self) -> u64 {
        let handle = self.next_handle;
        self.next_handle = self.next_handle.saturating_add(1);
        handle
    }

    fn insert_root(&mut self, root: RootHandle) -> u64 {
        let handle = self.next_handle();
        self.roots.insert(handle, root);
        handle
    }

    fn insert_artifact(&mut self, artifact: ArtifactHandle) -> u64 {
        let handle = self.next_handle();
        self.artifacts.insert(handle, artifact);
        handle
    }
}

fn operation_response(request_id: u64, result: std::io::Result<()>) -> Response<'static> {
    match result {
        Ok(()) => Response::ok(Some(request_id)),
        Err(error) => Response::error(Some(request_id), classify_error(&error), error),
    }
}

#[cfg(test)]
mod tests {
    use super::State;
    use crate::protocol::Request;

    #[test]
    fn capabilities_claim_only_the_implemented_native_boundaries() {
        let response = State::new().handle(Request::Capabilities);
        #[cfg(unix)]
        {
            assert_eq!(response.held_roots, Some(true));
            assert_eq!(response.directory_sync, Some(true));
        }
        #[cfg(windows)]
        {
            assert_eq!(response.held_roots, Some(true));
            assert_eq!(response.directory_sync, Some(true));
        }
    }
}
