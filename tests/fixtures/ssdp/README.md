# SSDP Fixtures

Real router SSDP M-SEARCH response captures for regression testing.

Format: raw UDP payload bytes, one capture per file.
Sanitize before committing: the sender IP and any serial numbers.

Capture tool: Wireshark filter `udp.port == 1900` then export as binary.

Filenames: `<vendor>-<model>.bin` (e.g. `tplink-ax73.bin`).

This directory seeds the codec fixture tests and serves as corpus for fuzzing.
