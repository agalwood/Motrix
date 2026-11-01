"""Offline fault-injection tests for Store uploads and artifact provenance."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import snap_publication as publication
import upload_snap_revision as upload
from verify_snap_credential_scope import verify_scope


def revision(**changes):
    return {"revision": 119, "sha3-384": "a" * 96, "size": 12,
            "version": "2.2.0", "architectures": ["amd64"], "confinement": "strict",
            "grade": "stable", "status": "Unpublished", **changes}


class UploadRecoveryTests(unittest.TestCase):
    def run_reconcile(self, lookups, error=False):
        lookup = Mock(side_effect=lookups)
        mutation = Mock(side_effect=RuntimeError("response lost") if error else None)
        states = []
        result = upload.reconcile(lookup=lookup, upload=mutation, save_state=states.append, sleep=lambda _: None)
        return result, mutation, states

    def test_upload_scope_requires_push_and_read_permissions(self):
        def whoami(permissions):
            return f"email: publisher@example.com\nusername: publisher\nid: 1\npermissions: {permissions}\nchannels: edge\nexpires: 2027-01-01T00:00:00Z\n"
        self.assertEqual(verify_scope(whoami("package_access, package_push, package_release"), "latest/edge", True), "edge")
        for permissions in ["package_release", "package_access, package_release", "package_push, package_release"]:
            with self.subTest(permissions=permissions), self.assertRaises(ValueError):
                verify_scope(whoami(permissions), "latest/edge", True)

    def test_target_architecture_survives_snap_runtime_host_environment(self):
        for target in ["amd64", "arm64"]:
            for host in ["amd64", "arm64"]:
                with self.subTest(target=target, host=host), patch.dict(upload.os.environ, {"MOTRIX_SNAP_ARCH": target, "SNAP_ARCH": host}):
                    self.assertEqual(upload.publication_architecture(), target)
        with patch.dict(upload.os.environ, {"SNAP_ARCH": "amd64"}, clear=True), self.assertRaises(KeyError):
            upload.publication_architecture()

    def test_existing_hash_never_uploads_again(self):
        result, mutation, _ = self.run_reconcile([revision()])
        self.assertEqual(result["revision"], 119)
        mutation.assert_not_called()

    def test_fresh_upload_records_store_verified_revision(self):
        _, mutation, states = self.run_reconcile([None, revision()])
        mutation.assert_called_once()
        self.assertEqual(states[-1]["state"], "reconciled")

    def test_lost_response_recovers_without_second_write(self):
        _, mutation, states = self.run_reconcile([None, None, revision()], True)
        mutation.assert_called_once()
        self.assertEqual(states[1]["state"], "upload_outcome_unknown")

    def test_read_error_prevents_upload(self):
        mutation = Mock()
        with self.assertRaises(RuntimeError):
            upload.reconcile(lookup=Mock(side_effect=RuntimeError()), upload=mutation, save_state=Mock())
        mutation.assert_not_called()

    def test_ambiguous_write_is_not_retried(self):
        mutation = Mock(side_effect=RuntimeError())
        with self.assertRaisesRegex(ValueError, 'unresolved'):
            upload.reconcile(lookup=Mock(return_value=None), upload=mutation, save_state=Mock(), sleep=lambda _: None)
        mutation.assert_called_once()

    def test_pending_or_rejected_revision_blocks_reupload(self):
        for status in ["ManualReviewPending", "NeedsInformation", "AutomaticallyRejected", "Rejected", "unknown"]:
            with self.subTest(status=status):
                mutation = Mock()
                with self.assertRaises(ValueError):
                    upload.reconcile(lookup=lambda: revision(status=status), upload=mutation, save_state=Mock())
                mutation.assert_not_called()

    def test_hash_match_requires_arch_version_size_and_policy(self):
        for changes in [{"size": 13}, {"architectures": ["arm64"]}, {"version": "2.2.1"},
                        {"confinement": "classic"}, {"grade": "devel"}, {"revision": 0}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                upload.matching_revision([revision(**changes)], "a" * 96, 12, "amd64", "2.2.0")
        with self.assertRaises(ValueError):
            upload.matching_revision([revision(), revision(revision=120)], "a" * 96, 12, "amd64", "2.2.0")
        self.assertIsNone(upload.matching_revision([revision()], "b" * 96, 12, "amd64", "2.2.0"))

    def test_reads_all_pages_including_unreleased_revisions(self):
        get = Mock(side_effect=[
            {"snap": {"name": "motrix"}, "revisions": [revision()], "_links": {"next": "?page=2"}},
            {"snap": {"name": "motrix"}, "revisions": [revision(revision=120)], "_links": {}},
        ])
        self.assertEqual(len(upload.list_revisions(get)), 2)
        self.assertEqual(get.call_args.args[0], upload.ENDPOINT + "?page=2")

    def test_pagination_never_sends_credentials_to_other_hosts(self):
        for link in ["https://evil.example/api", "//evil.example/path", "http://dashboard.snapcraft.io/x", "/other"]:
            get = Mock(return_value={"snap": {"name": "motrix"}, "revisions": [], "_links": {"next": link}})
            with self.subTest(link=link), self.assertRaises(ValueError):
                upload.list_revisions(get)
            get.assert_called_once()

    def test_changed_or_looping_snapshot_stops(self):
        data = {"snap": {"name": "motrix"}, "revisions": [revision()], "_links": {"next": "?size=500"}}
        with self.assertRaises(ValueError):
            upload.list_revisions(Mock(return_value=data))


class StoreClientAdapterTests(unittest.TestCase):
    def factory_module(self, client):
        # Snapcraft 9 requires this argument; preserve its real signature.
        def get_client(ephemeral):
            self.assertIs(ephemeral, False)
            return client
        return {"snapcraft": SimpleNamespace(), "snapcraft.store": SimpleNamespace(),
                "snapcraft.store.client": SimpleNamespace(get_client=get_client)}

    def test_constructs_real_signature_without_network_and_binds_safe_request_options(self):
        client = Mock()
        client.request.return_value = SimpleNamespace(status_code=200, json=lambda: {"revisions": []})
        with patch.dict(sys.modules, self.factory_module(client)):
            get = upload.store_getter()
            client.request.assert_not_called()
            self.assertEqual(get(upload.ENDPOINT), {"revisions": []})
        client.request.assert_called_once_with("GET", upload.ENDPOINT, headers={"Accept": "application/json"},
                                               timeout=60, allow_redirects=False)

    def test_compatibility_command_constructs_client_without_authentication_or_request(self):
        client = Mock()
        keyring = Mock()
        modules = {**self.factory_module(client), "keyring": keyring,
                   "craft_store": SimpleNamespace(),
                   "craft_store.auth": SimpleNamespace(MemoryKeyring=lambda: "memory-only")}
        with patch.dict(sys.modules, modules), \
             patch.dict(upload.os.environ, {"MOTRIX_SNAP_ARCH": "arm64", "SNAP_ARCH": "amd64"}), \
             patch.object(sys, "argv", ["upload_snap_revision.py", "check-client"]):
            upload.main()
        keyring.set_keyring.assert_called_once_with("memory-only")
        client.request.assert_not_called()

    def test_does_not_expose_request_exception_payloads(self):
        client = Mock()
        client.request.side_effect = RuntimeError("sensitive authentication response")
        with patch.dict(sys.modules, self.factory_module(client)):
            with self.assertRaises(publication.PublicationError) as error:
                upload.store_getter()(upload.ENDPOINT)
        self.assertNotIn("sensitive", str(error.exception))
        self.assertIn("Store read failed", str(error.exception))


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.run = {"id": 42, "event": "push", "head_branch": "v2.2.0", "head_sha": "a" * 40}
        self.jobs = [{"name": "Validate Snap source", "conclusion": "success"}]
        self.artifacts = []
        for index, arch in enumerate(publication.ARCHES):
            self.jobs.append({"name": f"Build Snap / {arch}", "conclusion": "success", "run_attempt": 1,
                              "started_at": "2026-11-01T01:00:00Z", "completed_at": "2026-11-01T01:10:00Z"})
            self.artifacts.append({"name": f"snap-input-{arch}", "id": index + 1, "expired": False,
                                   "digest": "sha256:" + "b" * 64, "workflow_run": {"id": 42, "head_sha": "a" * 40},
                                   "created_at": "2026-11-01T01:09:00Z"})

    def validate(self):
        return publication.validate_source(self.run, self.jobs, self.artifacts, "agalwood/Motrix", "2.2.0", "a" * 40)

    def test_failed_publication_can_reuse_successful_original_builds(self):
        self.run["conclusion"] = "failure"
        self.assertEqual(self.validate()["run_id"], "42")

    def test_carried_forward_jobs_keep_original_build_attempt(self):
        for j in self.jobs[1:].copy():
            self.jobs.append({**j, "run_attempt": 2})
        self.assertEqual(self.validate()["artifacts"]["amd64"]["build_attempt"], 1)

    def test_rejects_wrong_tag_commit_or_event(self):
        for key, value in [("event", "pull_request"), ("event", "workflow_dispatch"),
                           ("head_branch", "main"), ("head_sha", "b" * 40)]:
            with self.subTest(key=key, value=value), patch.dict(self.run, {key: value}), self.assertRaises(ValueError):
                self.validate()

    def test_rejects_expired_mutated_or_unbound_artifact(self):
        for changes in [{"expired": True}, {"digest": ""}, {"created_at": "2026-11-02T01:09:00Z"},
                        {"workflow_run": {"id": 43, "head_sha": "a" * 40}}]:
            with self.subTest(changes=changes), patch.dict(self.artifacts[0], changes), self.assertRaises(ValueError):
                self.validate()

    def test_rejects_incomplete_or_failed_builds(self):
        with patch.dict(self.jobs[1], {"conclusion": "failure"}), self.assertRaises(ValueError):
            self.validate()
        self.artifacts.pop()
        with self.assertRaises(ValueError):
            self.validate()

    def test_receipts_cannot_mix_builds_architectures_or_publication_runs(self):
        source = self.validate()
        receipt = {"source": source, "architecture": "amd64", "publication_run_id": "45",
                   "sha3_384": "c" * 96, "size": 12, "status": "verified", "revision": "119"}
        self.assertEqual(publication.validate_receipt(receipt, source, "amd64", "45", "c" * 96, 12), "119")
        for changes in [{"source": {}}, {"architecture": "arm64"}, {"publication_run_id": "46"},
                        {"sha3_384": "d" * 96}, {"size": 13}, {"status": "pending"}]:
            with self.subTest(changes=changes), patch.dict(receipt, changes), self.assertRaises(ValueError):
                publication.validate_receipt(receipt, source, "amd64", "45", "c" * 96, 12)

    def test_archive_digest_checked_before_extracting(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as zipped:
            zipped.writestr("snap-amd64/motrix_2.2.0_amd64.snap", b"original snap")
        data = payload.getvalue()
        artifact = {"id": 1, "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
        def download(args, **kwargs):
            kwargs["stdout"].write(data)
        with patch.object(subprocess, "run", side_effect=download):
            self.assertEqual(len(publication.archive("agalwood/Motrix", artifact)), 1)
            artifact["digest"] = "sha256:" + "0" * 64
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                publication.archive("agalwood/Motrix", artifact)

    def test_zip_paths_cannot_escape_destination(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as zipped:
            zipped.writestr("../escape.snap", b"invalid")
        data = payload.getvalue()
        def download(args, **kwargs):
            kwargs["stdout"].write(data)
        with patch.object(subprocess, "run", side_effect=download), self.assertRaises(ValueError):
            publication.archive("agalwood/Motrix", {"id": 1, "digest": "sha256:" + hashlib.sha256(data).hexdigest()})


class PromotionRecoveryTests(unittest.TestCase):
    def test_recovery_requires_successful_protected_main_workflow_and_exact_receipts(self):
        run = {"event": "workflow_dispatch", "head_branch": "main", "status": "completed",
               "conclusion": "success", "run_attempt": 2, "head_sha": "b" * 40}
        source = {"run_id": "42", "version": "2.2.0"}
        receipts = {arch: {"source": source, "architecture": arch, "publication_run_id": "45",
                          "sha3_384": "c" * 96, "size": 12, "status": "verified", "revision": str(119 + index)}
                    for index, arch in enumerate(publication.ARCHES)}
        proof = {"source": source, "publication_run_id": "45", "receipts": receipts}
        revisions = {arch: receipt["revision"] for arch, receipt in receipts.items()}
        def files(*_):
            return {"snap-provenance.json": json.dumps(proof), "motrix-snap-revisions.json": json.dumps(revisions)}
        with patch.object(publication, "workflow_run", return_value=run), \
             patch.object(publication, "check_ancestry"), \
             patch.object(publication, "api", return_value=[{"artifacts": [{"name": "snap-release-revisions-2", "expired": False}]}]), \
             patch.object(publication, "archive", side_effect=files), \
             patch.object(publication, "original_source", return_value=source), \
             patch.object(publication, "download_snap", return_value=("c" * 96, 12)):
            def verify():
                publication.verify_recovery_promotion("agalwood/Motrix", "45", "2", "2.2.0")
            verify()
            for change in [{"event": "pull_request"}, {"head_branch": "feature"}, {"status": "in_progress"},
                           {"conclusion": "failure"}, {"run_attempt": 1}]:
                with self.subTest(change=change), patch.dict(run, change), self.assertRaises(ValueError):
                    verify()
            with patch.dict(revisions, {"arm64": "121"}), self.assertRaises(ValueError):
                verify()
            with patch.dict(proof, {"publication_run_id": "46"}), self.assertRaises(ValueError):
                verify()
            with patch.dict(receipts["amd64"], {"sha3_384": "d" * 96}), self.assertRaises(ValueError):
                verify()


if __name__ == "__main__":
    unittest.main()
