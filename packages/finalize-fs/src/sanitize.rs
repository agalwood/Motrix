//! Cross-platform filename sanitization for published artifacts.
//!
//! Download names are authored anywhere — HTTP `Content-Disposition`,
//! BitTorrent metadata, magnet links or user edits — and only have to be
//! representable on the origin system. The published file, however, must be
//! usable on every filesystem Motrix supports, including ones the user copies
//! it to later. This module maps any candidate final path component onto a
//! name that is simultaneously valid on Windows (reserved device names,
//! forbidden characters, trailing dots and spaces, per-component limits),
//! macOS (where `:` is legal but Finder renders it as `/`) and Unix
//! (`NAME_MAX`).
//!
//! The character and reserved-name rules follow Chromium's
//! `net/base/filename_util.cc`, tightened to one shared domain instead of
//! per-OS masks. Differences from Chromium are recorded in the package
//! README. Sanitization is idempotent and never inspects the filesystem.

/// UTF-8 byte budget that stays under Unix `NAME_MAX` (255 bytes) and the
/// Windows per-component limit (255 UTF-16 code units, which always covers
/// fewer bytes than the UTF-8 encoding of the same text). The budget is one
/// byte short of the hard limit so a published name can still grow a conflict
/// suffix — ` (1)` or `.N` — without breaking `NAME_MAX`; Firefox's
/// `kDefaultMaxFileNameLength` keeps the same 254-byte margin.
const MAX_COMPONENT_BYTES: usize = 254;
/// Extensions longer than this are treated as payload, not worth preserving.
const MAX_EXTENSION_BYTES: usize = 24;
/// Result when every character of the input is stripped (for example `.`).
const FALLBACK_NAME: &str = "download";
const REPLACEMENT: char = '_';

pub(crate) fn sanitize_filename(component: &str) -> String {
    // 1. Replace characters that are illegal or ambiguous on any supported
    //    platform. `/` and `\` are replaced rather than rejected so a caller
    //    that passes a slash-bearing name cannot smuggle in directory levels.
    let replaced: String = component
        .chars()
        .map(|character| {
            if is_forbidden_character(character) {
                REPLACEMENT
            } else {
                character
            }
        })
        .collect();
    // 2. Strip trailing dots and spaces, which Windows drops silently: a
    //    name published as `file.` would otherwise round-trip as `file`.
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    // 3. Windows reserves whole device names including `CON.txt` forms; the
    //    stem keeps its extension but gains an underscore suffix.
    let dereserved = dereserve_name(trimmed);
    // 4. Clamp the component length, keeping a short extension when present.
    let clamped = clamp_component(&dereserved);
    if clamped.is_empty() {
        FALLBACK_NAME.to_string()
    } else {
        clamped
    }
}

fn is_forbidden_character(character: char) -> bool {
    matches!(
        character,
        '\0'..='\u{1f}' | '\u{7f}' | '<' | '>' | '"' | '|' | '?' | '*' | '/' | '\\' | ':'
    )
}

fn dereserve_name(name: &str) -> String {
    let stem_end = name.find('.').unwrap_or(name.len());
    let (stem, rest) = name.split_at(stem_end);
    if is_reserved_stem(stem) {
        format!("{stem}_{rest}")
    } else {
        name.to_string()
    }
}

fn is_reserved_stem(stem: &str) -> bool {
    let upper = stem.to_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let Some(suffix) = upper
        .strip_prefix("COM")
        .or_else(|| upper.strip_prefix("LPT"))
    else {
        return false;
    };
    matches!(
        suffix,
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
    )
}

fn clamp_component(name: &str) -> String {
    if name.len() <= MAX_COMPONENT_BYTES {
        return name.to_string();
    }
    if let Some(dot) = name.rfind('.')
        && dot > 0
    {
        let extension_bytes = name.len() - dot - 1;
        if extension_bytes > 0 && extension_bytes <= MAX_EXTENSION_BYTES {
            let stem_budget = MAX_COMPONENT_BYTES - extension_bytes - 1;
            let stem = truncate_utf8(&name[..dot], stem_budget);
            // Truncation can expose a fresh trailing dot or space.
            let stem = stem.trim_end_matches(['.', ' ']);
            let extension = &name[dot + 1..];
            return format!("{stem}.{extension}");
        }
    }
    truncate_utf8(name, MAX_COMPONENT_BYTES)
        .trim_end_matches(['.', ' '])
        .to_string()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

#[cfg(test)]
mod tests {
    use super::{MAX_COMPONENT_BYTES, sanitize_filename};

    // The same matrix is mirrored by the host-side
    // `sanitizeFinalizeFilename` tests; keep both tables in sync.
    #[test]
    fn sanitizes_the_cross_platform_filename_matrix() {
        let cases: &[(&str, &str)] = &[
            ("normal.zip", "normal.zip"),
            ("资料.tar.gz", "资料.tar.gz"),
            ("movie🎬.mp4", "movie🎬.mp4"),
            ("file<name>.mp4", "file_name_.mp4"),
            ("a:b.txt", "a_b.txt"),
            ("say \"hi\"?", "say _hi__"),
            ("star*|dot>", "star__dot_"),
            ("path/injection.txt", "path_injection.txt"),
            ("win\\dows.txt", "win_dows.txt"),
            ("CON", "CON_"),
            ("con.txt", "con_.txt"),
            ("Com5", "Com5_"),
            ("LPT9.tar.gz", "LPT9_.tar.gz"),
            ("COM¹.log", "COM¹_.log"),
            ("lpt².dat", "lpt²_.dat"),
            ("aux", "aux_"),
            ("nul.image.iso", "nul_.image.iso"),
            ("conin$.txt", "conin$_.txt"),
            ("CONOUT$.log", "CONOUT$_.log"),
            ("trailing. ", "trailing"),
            ("trailing...   ", "trailing"),
            ("trailing.", "trailing"),
            ("spaces   .txt", "spaces   .txt"),
            (".hidden", ".hidden"),
            (".", "download"),
            ("..", "download"),
            ("", "download"),
            ("   ", "download"),
            ("???", "___"),
            ("control\tchar\n", "control_char_"),
            ("console\u{7f}.log", "console_.log"),
            ("CON. ", "CON_"),
            ("degree°name", "degree°name"),
        ];
        for (input, expected) in cases {
            assert_eq!(sanitize_filename(input), *expected, "input {input:?}");
        }
    }

    #[test]
    fn sanitization_is_idempotent() {
        for input in ["CON", "file.", "a/b\\c:d", "spaces . ", "name<?>.txt", ""] {
            let once = sanitize_filename(input);
            assert_eq!(sanitize_filename(&once), once, "input {input:?}");
        }
    }

    #[test]
    fn long_components_are_clamped_on_character_boundaries() {
        let long_stem = "a".repeat(300);
        let clamped = sanitize_filename(&long_stem);
        assert_eq!(clamped.len(), MAX_COMPONENT_BYTES);
        assert!(clamped.chars().all(|character| character == 'a'));

        let named = format!("{}.zip", "字".repeat(100));
        let clamped = sanitize_filename(&named);
        assert!(clamped.len() <= MAX_COMPONENT_BYTES, "{}", clamped.len());
        assert!(clamped.ends_with(".zip"), "{clamped}");
        assert!(clamped.trim_end_matches('字').ends_with(".zip"));
        // 83 CJK characters (249 bytes) + ".zip" fits in 254 bytes; the
        // 84th character would exceed the budget.
        assert_eq!(clamped, format!("{}.zip", "字".repeat(83)));

        // A giant "extension" is payload: clamp the whole name instead.
        let giant_extension = format!("{}.{}", "d".repeat(300), "x".repeat(200));
        let clamped = sanitize_filename(&giant_extension);
        assert_eq!(clamped.len(), MAX_COMPONENT_BYTES);

        // Truncation landing on a trailing dot or space strips it.
        let dotted = format!("{}.", "b".repeat(300));
        let clamped = sanitize_filename(&dotted);
        assert_eq!(clamped.len(), MAX_COMPONENT_BYTES);
        assert!(!clamped.ends_with('.'));
    }

    #[test]
    fn components_at_the_byte_budget_boundary_are_clamped_exactly() {
        // 253 and 254 bytes are at or under the budget and survive untouched;
        // 255 bytes is one over and clamps to exactly 254, leaving room for a
        // conflict suffix (` (1)`, `.N`) that publication may append later.
        for bytes in [253, 254] {
            let name = "a".repeat(bytes);
            assert_eq!(sanitize_filename(&name), name);
        }
        assert_eq!(sanitize_filename(&"a".repeat(255)), "a".repeat(254));

        // With a kept extension the stem absorbs the clamp: a 251-byte stem
        // plus ".zip" totals 255, so the stem drops exactly one byte.
        let kept = sanitize_filename(&format!("{}.zip", "a".repeat(251)));
        assert_eq!(kept, format!("{}.zip", "a".repeat(250)));
        assert_eq!(kept.len(), MAX_COMPONENT_BYTES);
    }

    #[test]
    fn sanitized_names_always_pass_the_windows_component_contract() {
        for input in ["CON", "x".repeat(300).as_str(), "a:b", "tail. "] {
            let sanitized = sanitize_filename(input);
            assert!(!sanitized.is_empty());
            assert!(!sanitized.ends_with([' ', '.']), "{sanitized:?}");
            assert!(
                !sanitized.chars().any(super::is_forbidden_character),
                "{sanitized:?}"
            );
            let stem = sanitized.split('.').next().unwrap_or_default();
            assert!(!super::is_reserved_stem(stem), "{sanitized:?}");
            assert!(sanitized.len() <= super::MAX_COMPONENT_BYTES);
        }
    }
}
