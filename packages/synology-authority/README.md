# DSM authority broker

This Linux-only, static native executable is an owner-only, one-shot privilege
boundary for DSM session, account and ACL checks. It is not a service, shell,
filesystem reader or general command runner. Motrix Server, aria2, plugins and
the finalize filesystem helper remain unprivileged.

DSM `conf/privilege` grants only this file SETUID, SETGID and SETPCAP capabilities.
The broker verifies its caller against its private executable's file owner,
validates a bounded stdin request, and invokes only fixed root/system-owned DSM
programs. After validation, its bounded monitor and child become UID/GID 0 with
no supplementary groups; the package user cannot suspend the monitor. The child's
exec capability bounding set is reduced to DAC_OVERRIDE and DAC_READ_SEARCH.
There is no arbitrary executable, argument, environment or signal target.
Session secrets travel only through stdin and the fixed authentication child's
environment, never argv, logs or error text. Account profile fields and stderr
are discarded. A read-only ACL query uses a held descriptor opened component by
component as the package user before elevation. Root authority never performs
application file reads, writes, deletion or directory creation.

Each child has a three-second parent deadline, CPU/alarm limits, a parent-death
signal and bounded output. The broker also has a parent-death signal and a
six-second alarm covering stdin; inherited blocked/ignored alarms are reset.
Core dumps and dumpability are disabled. It does not read password databases
itself, bind a listener or persist state. The DSM tools remain a vendor trust
boundary; their availability and output contract require device verification.

Build with `node packages/synology-authority/build.mjs`. On Linux x64, use the
repository's Rust version and `x86_64-unknown-linux-musl` target; other hosts use a
matching isolated Rust container. The registry lock is a subset of the reviewed
Rust inventory in the repository's third-party notices. Run cargo fmt, clippy,
and tests in Linux, and the actual-SPK Linux smoke before distribution.
