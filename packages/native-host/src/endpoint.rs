use std::fs::File;
use std::io::{Read, Take};
use std::path::Path;

use serde::Deserialize;

pub const MAX_ENDPOINT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct EndpointFile {
    pub port: u16,
    #[serde(rename = "localToken", default)]
    pub local_token: Option<String>,
    #[serde(default)]
    pub generation: Option<String>,
}

#[cfg(unix)]
fn effective_user_id() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }

    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    unsafe { geteuid() }
}

/// Spec §9.1: `endpoint.json`'s 0600 owner-only mode *is* the attestation
/// root. Reads metadata from the already-open handle, avoiding a TOCTOU
/// window between checking the file and reading its contents.
#[cfg(unix)]
fn is_owner_only(file: &File) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let Ok(metadata) = file.metadata() else {
        return false;
    };
    metadata.uid() == effective_user_id() && metadata.permissions().mode() & 0o077 == 0
}

/// The Windows counterpart of the 0600 check, and **deliberately weaker than
/// it** — the difference is documented here rather than glossed, because the
/// spec's attestation root is stated in POSIX terms and Windows cannot express
/// exactly that.
///
/// What §9.1 actually needs is "nobody who is not already omnipotent could have
/// written this file", because a file a third party can write cannot root an
/// attestation. So this requires:
///
///   1. the file's owner SID is the current process user, and
///   2. every DACL entry is either a deny-family ACE (which can only subtract
///      access) or a plain `ACCESS_ALLOWED_ACE` whose SID is that user,
///      `LocalSystem`, or `BUILTIN\Administrators`. Any other ACE type —
///      the conditional/object allow variants included — fails the check
///      closed, because it can grant access under rules this code does not
///      evaluate (see `ace_policy`).
///
/// SYSTEM and Administrators are admitted because they can already rewrite
/// anything the user owns; excluding them would reject every normal file in
/// `%APPDATA%` and buy no security. That is the weakening: unlike mode 0600,
/// this permits an administrator to *read* the file's `localToken`. An
/// administrator could read it anyway.
///
/// A missing DACL (`ppDacl` null with the call succeeding) means "no
/// protection at all" in Win32, so it is rejected rather than treated as
/// empty-and-therefore-safe — the one place where the permissive reading of a
/// Win32 API is the dangerous one.
///
/// Reads from the already-open handle, like the Unix path, so there is no
/// TOCTOU window between the check and the read.
#[cfg(windows)]
fn is_owner_only(file: &File) -> bool {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    };

    let handle = file.as_raw_handle() as HANDLE;
    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();

    // SAFETY: `handle` is a live file handle owned by `file`, which outlives
    // this call. The out-params are all correctly typed null-initialised
    // pointers; on success Win32 fills them with pointers *into* the
    // descriptor it allocates, which is why nothing here may outlive the
    // `LocalFree` below.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return false;
    }

    let verdict = dacl_is_owner_only(owner, dacl);

    // SAFETY: `descriptor` is the buffer `GetSecurityInfo` allocated on
    // success, and `verdict` already copied out everything derived from it.
    unsafe { LocalFree(descriptor as *mut _) };
    verdict
}

/// How one DACL ACE bears on the owner-only question, decided purely by its
/// `AceType` byte. Split from the FFI walk so the policy is a total function
/// unit-tested on every platform, not just where the FFI compiles.
#[cfg_attr(not(windows), allow(dead_code))]
mod ace_policy {
    /// `AceType` byte values from `winnt.h`. The ACE format is stable ABI, so
    /// restating them keeps this policy decidable off Windows; the
    /// `#[cfg(windows)]` assertions below pin each one to `windows_sys` so
    /// the two can never drift on the platform that matters.
    const ACE_ACCESS_ALLOWED: u8 = 0;
    const ACE_ACCESS_DENIED: u8 = 1;
    const ACE_ACCESS_DENIED_OBJECT: u8 = 6;
    const ACE_ACCESS_DENIED_CALLBACK: u8 = 10;
    const ACE_ACCESS_DENIED_CALLBACK_OBJECT: u8 = 12;

    #[cfg(windows)]
    const _: () = {
        use windows_sys::Win32::System::SystemServices as ss;
        assert!(ss::ACCESS_ALLOWED_ACE_TYPE == ACE_ACCESS_ALLOWED as u32);
        assert!(ss::ACCESS_DENIED_ACE_TYPE == ACE_ACCESS_DENIED as u32);
        assert!(ss::ACCESS_DENIED_OBJECT_ACE_TYPE == ACE_ACCESS_DENIED_OBJECT as u32);
        assert!(ss::ACCESS_DENIED_CALLBACK_ACE_TYPE == ACE_ACCESS_DENIED_CALLBACK as u32);
        assert!(
            ss::ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE == ACE_ACCESS_DENIED_CALLBACK_OBJECT as u32
        );
    };

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(super) enum AceDisposition {
        /// A plain `ACCESS_ALLOWED_ACE`: grants to its SID, which must
        /// therefore be one of the admitted SIDs.
        GrantsToSid,
        /// A deny-family ACE: whatever its condition or object filter, a deny
        /// can only subtract access, so it can never widen who may write.
        NeverGrants,
        /// Everything else: the conditional/object allow variants
        /// (`ACCESS_ALLOWED_OBJECT/CALLBACK[_OBJECT]`, compound), audit/alarm
        /// types that belong in a SACL rather than a DACL, and every type
        /// newer than this binary. Any of these can (or might) grant access
        /// under rules this code does not evaluate, so a file carrying one
        /// cannot be proven owner-only: fail closed rather than
        /// allow-by-omission.
        Unsupported,
    }

    pub(super) fn classify_ace_type(ace_type: u8) -> AceDisposition {
        match ace_type {
            ACE_ACCESS_ALLOWED => AceDisposition::GrantsToSid,
            ACE_ACCESS_DENIED
            | ACE_ACCESS_DENIED_OBJECT
            | ACE_ACCESS_DENIED_CALLBACK
            | ACE_ACCESS_DENIED_CALLBACK_OBJECT => AceDisposition::NeverGrants,
            _ => AceDisposition::Unsupported,
        }
    }
}

/// The decision itself, split out so the `unsafe` above stays about resource
/// lifetime and this stays about policy.
#[cfg(windows)]
fn dacl_is_owner_only(
    owner: windows_sys::Win32::Security::PSID,
    dacl: *mut windows_sys::Win32::Security::ACL,
) -> bool {
    use windows_sys::Win32::Security::{ACCESS_ALLOWED_ACE, ACE_HEADER, EqualSid, GetAce, PSID};

    if owner.is_null() || dacl.is_null() {
        // A null DACL is Win32 for "unprotected", not "empty".
        return false;
    }
    let Some(user) = current_user_sid() else {
        return false;
    };
    // SAFETY: `user.as_ptr()` points at a live, correctly sized SID buffer this
    // function owns, and `owner` is a SID inside the caller's live descriptor.
    if unsafe { EqualSid(owner, user.as_ptr() as PSID) } == 0 {
        return false;
    }

    let allowed = [
        user,
        match well_known_sid(windows_sys::Win32::Security::WinLocalSystemSid) {
            Some(sid) => sid,
            None => return false,
        },
        match well_known_sid(windows_sys::Win32::Security::WinBuiltinAdministratorsSid) {
            Some(sid) => sid,
            None => return false,
        },
    ];

    // SAFETY: `dacl` is non-null and points into the caller's live descriptor.
    let count = unsafe { (*dacl).AceCount };
    for index in 0..u32::from(count) {
        let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: `index` is below `AceCount`, which is the documented
        // precondition for `GetAce`.
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            return false;
        }
        // SAFETY: every ACE begins with an `ACE_HEADER`, whatever its type.
        let ace_type = unsafe { (*(ace as *const ACE_HEADER)).AceType };
        match ace_policy::classify_ace_type(ace_type) {
            ace_policy::AceDisposition::NeverGrants => continue,
            // An ACE this code cannot prove harmless could widen who may
            // write the file, so the file cannot root an attestation.
            ace_policy::AceDisposition::Unsupported => return false,
            ace_policy::AceDisposition::GrantsToSid => {}
        }
        // SAFETY: `GrantsToSid` establishes this ACE is a plain
        // ACCESS_ALLOWED_ACE, whose `SidStart` is the first DWORD of its SID.
        let sid = unsafe { &raw const (*(ace as *const ACCESS_ALLOWED_ACE)).SidStart } as PSID;
        // SAFETY: both operands are live SIDs — `sid` inside the caller's
        // descriptor, the candidates in buffers `allowed` owns.
        if !allowed
            .iter()
            .any(|candidate| unsafe { EqualSid(sid, candidate.as_ptr() as PSID) } != 0)
        {
            return false;
        }
    }
    true
}

/// The current process user's SID, as an owned byte buffer.
#[cfg(windows)]
fn current_user_sid() -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `GetCurrentProcess` returns a pseudo-handle that needs no
    // release, and `token` is a correctly typed out-param.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let mut needed: u32 = 0;
    // SAFETY: a null buffer with zero length is the documented way to ask
    // GetTokenInformation for the required size; it fails with
    // ERROR_INSUFFICIENT_BUFFER and writes `needed`.
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        // SAFETY: `token` is the handle OpenProcessToken just returned.
        unsafe { CloseHandle(token) };
        return None;
    }
    let mut buffer = vec![0u8; needed as usize];
    // SAFETY: `buffer` is `needed` bytes long, which is exactly what the
    // sizing call above asked for.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } != 0;
    // SAFETY: `token` is the handle OpenProcessToken returned and is not used
    // again after this point.
    unsafe { CloseHandle(token) };
    if !ok {
        return None;
    }
    // SAFETY: on success the buffer holds a TOKEN_USER whose `User.Sid` points
    // into a variable-length SID that follows it in the same buffer.
    let sid = unsafe { (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid };
    copy_sid(sid)
}

/// A well-known SID (`LocalSystem`, `BUILTIN\Administrators`) as an owned buffer.
#[cfg(windows)]
fn well_known_sid(kind: windows_sys::Win32::Security::WELL_KNOWN_SID_TYPE) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::CreateWellKnownSid;

    // 68 bytes is `SECURITY_MAX_SID_SIZE`; both SIDs used here are far shorter,
    // and sizing to the maximum avoids a two-call dance for a fixed constant.
    let mut buffer = vec![0u8; 68];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` is SECURITY_MAX_SID_SIZE bytes, the documented upper
    // bound for any SID this function can produce.
    let ok = unsafe {
        CreateWellKnownSid(
            kind,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut length,
        )
    } != 0;
    if !ok {
        return None;
    }
    buffer.truncate(length as usize);
    Some(buffer)
}

/// Copies a borrowed SID into an owned buffer so it can outlive its source.
#[cfg(windows)]
fn copy_sid(sid: windows_sys::Win32::Security::PSID) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::{GetLengthSid, IsValidSid};

    if sid.is_null() {
        return None;
    }
    // SAFETY: `sid` is non-null; `IsValidSid` is precisely the call that
    // establishes it is safe to ask for its length.
    if unsafe { IsValidSid(sid) } == 0 {
        return None;
    }
    // SAFETY: validated immediately above.
    let length = unsafe { GetLengthSid(sid) } as usize;
    if length == 0 {
        return None;
    }
    let mut buffer = vec![0u8; length];
    // SAFETY: `sid` is a valid SID of exactly `length` bytes and `buffer` is
    // that long; the regions cannot overlap because `buffer` was just created.
    unsafe { std::ptr::copy_nonoverlapping(sid as *const u8, buffer.as_mut_ptr(), length) };
    Some(buffer)
}

/// Reads `endpoint.json`, keeping the ticket-minting fields only when the
/// file passes the platform's `is_owner_only` above (§9.1): Unix mode-0600
/// owner check, or its deliberately-weaker Windows owner+DACL analogue.
pub fn read_endpoint(file_path: &Path) -> Option<EndpointFile> {
    let file = File::open(file_path).ok()?;
    let owner_only = is_owner_only(&file);
    let mut limited: Take<File> = file.take((MAX_ENDPOINT_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).ok()?;
    if bytes.len() > MAX_ENDPOINT_BYTES {
        return None;
    }
    let mut endpoint: EndpointFile = serde_json::from_slice(&bytes).ok()?;
    if endpoint.port == 0 {
        return None;
    }
    // Degrade, don't fail: a non-0600 file still reports its port so the
    // host can bootstrap, but cannot serve as the attestation root, so the
    // ticket-minting fields are dropped rather than trusted.
    if !owner_only {
        endpoint.local_token = None;
        endpoint.generation = None;
    }
    Some(endpoint)
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{EndpointFile, MAX_ENDPOINT_BYTES, read_endpoint};

    fn temp_file(name: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "motrix-native-host-endpoint-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp directory");
        dir.join(name)
    }

    #[test]
    fn plain_allow_aces_carry_the_sid_check() {
        use super::ace_policy::{AceDisposition, classify_ace_type};
        assert_eq!(classify_ace_type(0), AceDisposition::GrantsToSid);
    }

    #[test]
    fn deny_family_aces_never_grant() {
        use super::ace_policy::{AceDisposition, classify_ace_type};
        // ACCESS_DENIED (1), ACCESS_DENIED_OBJECT (6),
        // ACCESS_DENIED_CALLBACK (10), ACCESS_DENIED_CALLBACK_OBJECT (12):
        // whatever their condition or object filter, a deny can only subtract
        // access, so skipping them can never hide a widening grant.
        for deny in [1u8, 6, 10, 12] {
            assert_eq!(
                classify_ace_type(deny),
                AceDisposition::NeverGrants,
                "type {deny}"
            );
        }
    }

    #[test]
    fn conditional_object_and_unknown_ace_types_fail_closed() {
        use super::ace_policy::{AceDisposition, classify_ace_type};
        // The allow variants a conditional or object-filtered grant rides in:
        // ACCESS_ALLOWED_COMPOUND (4), ACCESS_ALLOWED_OBJECT (5),
        // ACCESS_ALLOWED_CALLBACK (9), ACCESS_ALLOWED_CALLBACK_OBJECT (11).
        // Each grants access under rules this code does not evaluate, so
        // treating any of them as harmless would be allow-by-omission.
        for granting in [4u8, 5, 9, 11] {
            assert_eq!(
                classify_ace_type(granting),
                AceDisposition::Unsupported,
                "type {granting}"
            );
        }
        // Audit/alarm types belong in a SACL, not a DACL; 17+ are label,
        // attribute, and future types. Fail closed on every one of them.
        for other in [2u8, 3, 7, 8, 13, 14, 15, 16, 17, 18, 19, 20, 21, 42, 255] {
            assert_eq!(
                classify_ace_type(other),
                AceDisposition::Unsupported,
                "type {other}"
            );
        }
    }

    #[test]
    fn returns_none_for_missing_or_malformed_file() {
        let missing = temp_file("missing.json");
        assert_eq!(read_endpoint(&missing), None);

        let malformed = temp_file("malformed.json");
        fs::write(&malformed, b"{").expect("write malformed fixture");
        assert_eq!(read_endpoint(&malformed), None);
    }

    #[test]
    fn parses_local_token_and_generation_from_owner_only_file() {
        let path = temp_file("endpoint.json");
        fs::write(
            &path,
            br#"{"port":55809,"pid":1,"writtenAt":0,"localToken":"tok-abc","generation":"gen-1"}"#,
        )
        .expect("write endpoint fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod 0600");
        }
        // Same intent as the chmod above: this test is about parsing, so pin
        // the permissions rather than inherit whatever %TEMP% happens to grant.
        #[cfg(windows)]
        {
            set_owner_only_dacl(&path);
        }
        let endpoint = read_endpoint(&path).expect("endpoint parses");
        assert_eq!(endpoint.port, 55_809);
        assert_eq!(endpoint.local_token.as_deref(), Some("tok-abc"));
        assert_eq!(endpoint.generation.as_deref(), Some("gen-1"));
    }

    /// Windows has no `chmod`, so the DACL is set with `icacls` — present on
    /// every Windows install, and it exercises the same code path a tampered
    /// file would. Two details are load-bearing. `/inheritance:r` in both
    /// tests: without it the file keeps whatever `%TEMP%` grants, which
    /// differs between a developer machine and a CI runner and would make
    /// these tests environment-dependent rather than assertions about
    /// `is_owner_only`. And `icacls`'s grammar makes `/grant[:r]` and its
    /// `Sid:perm` two separate argv entries — fused into one token, `icacls`
    /// exits non-zero and the `assert!` below aborts the test before it can
    /// assert anything about the DACL.
    #[cfg(windows)]
    fn set_dacl(path: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .args(args)
            .status()
            .expect("run icacls");
        assert!(status.success(), "icacls {args:?} failed");
    }

    #[cfg(windows)]
    fn current_windows_user() -> String {
        let output = std::process::Command::new("whoami")
            .output()
            .expect("run whoami");
        assert!(output.status.success(), "whoami failed");
        String::from_utf8(output.stdout)
            .expect("whoami emits UTF-8")
            .trim()
            .to_owned()
    }

    #[cfg(windows)]
    fn set_owner_only_dacl(path: &std::path::Path) {
        let user = current_windows_user();
        set_dacl(path, &["/setowner", &user]);
        set_dacl(path, &["/inheritance:r"]);
        set_dacl(path, &["/grant:r", &format!("{user}:F")]);
    }

    #[cfg(windows)]
    fn write_endpoint_fixture(name: &str) -> PathBuf {
        let path = temp_file(name);
        fs::write(
            &path,
            br#"{"port":55809,"localToken":"tok-abc","generation":"gen-1"}"#,
        )
        .expect("write endpoint fixture");
        path
    }

    #[cfg(windows)]
    #[test]
    fn owner_only_dacl_keeps_token_and_generation() {
        let path = write_endpoint_fixture("endpoint-win-strict.json");
        // Drop inheritance, then grant the current user alone full control.
        set_owner_only_dacl(&path);

        let endpoint = read_endpoint(&path).expect("endpoint parses");
        assert_eq!(endpoint.port, 55_809);
        assert_eq!(endpoint.local_token.as_deref(), Some("tok-abc"));
        assert_eq!(endpoint.generation.as_deref(), Some("gen-1"));
    }

    /// The Windows analogue of `group_readable_file_keeps_token_but_drops...`:
    /// a third party who is *not* already omnipotent can write the file, so it
    /// cannot root an attestation (§9.1) and the ticket-minting fields must be
    /// dropped while the port still comes through.
    #[cfg(windows)]
    #[test]
    fn dacl_granting_a_third_party_drops_token_fields() {
        let path = write_endpoint_fixture("endpoint-win-lax.json");
        set_owner_only_dacl(&path);
        // `*S-1-1-0` is Everyone, by SID so the test does not depend on the
        // runner's display language.
        set_dacl(&path, &["/grant", "*S-1-1-0:(W)"]);

        let endpoint = read_endpoint(&path).expect("endpoint parses");
        assert_eq!(endpoint.port, 55_809);
        assert_eq!(endpoint.local_token, None);
        assert_eq!(endpoint.generation, None);
    }

    #[cfg(unix)]
    #[test]
    fn group_readable_file_keeps_port_but_drops_token_fields() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_file("endpoint-lax.json");
        fs::write(
            &path,
            br#"{"port":55809,"localToken":"tok-abc","generation":"gen-1"}"#,
        )
        .expect("write endpoint fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod 0644");
        let endpoint = read_endpoint(&path).expect("endpoint parses");
        assert_eq!(endpoint.port, 55_809);
        assert_eq!(endpoint.local_token, None);
        assert_eq!(endpoint.generation, None);
    }

    #[test]
    fn missing_token_fields_deserialize_as_none() {
        let path = temp_file("endpoint-min.json");
        fs::write(&path, br#"{"port":55809}"#).expect("write endpoint fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod 0600");
        }
        assert_eq!(
            read_endpoint(&path),
            Some(EndpointFile {
                port: 55_809,
                local_token: None,
                generation: None
            })
        );
    }

    #[test]
    fn rejects_zero_negative_fractional_and_out_of_range_ports() {
        for (index, value) in ["0", "-1", "1.5", "65536", "\"80\""].iter().enumerate() {
            let path = temp_file(&format!("invalid-{index}.json"));
            fs::write(&path, format!(r#"{{"port":{value}}}"#))
                .expect("write invalid endpoint fixture");
            assert_eq!(read_endpoint(&path), None, "accepted port {value}");
        }
    }

    #[test]
    fn rejects_oversized_endpoint_file() {
        let path = temp_file("oversized.json");
        let mut file = File::create(&path).expect("create oversized fixture");
        file.write_all(&vec![b' '; MAX_ENDPOINT_BYTES + 1])
            .expect("write oversized fixture");
        assert_eq!(read_endpoint(&path), None);
    }
}
