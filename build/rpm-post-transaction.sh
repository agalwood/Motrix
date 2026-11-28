#!/bin/sh
set -eu

# A renamed package's old %postun runs after the new %post and removes the
# shared launcher and AppArmor profile. Restore them once all removals finish.
test -x /opt/Motrix/motrix || exit 0

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --install /usr/bin/motrix motrix /opt/Motrix/motrix 100
else
  ln -sf /opt/Motrix/motrix /usr/bin/motrix
fi

profile_source=/opt/Motrix/resources/apparmor-profile
profile_target=/etc/apparmor.d/motrix
if test -f "$profile_source" &&
  command -v apparmor_parser >/dev/null 2>&1 &&
  apparmor_status --enabled >/dev/null 2>&1 &&
  apparmor_parser --skip-kernel-load --debug "$profile_source" >/dev/null 2>&1; then
  install -m 644 "$profile_source" "$profile_target"
  if ! { test -x /usr/bin/ischroot && /usr/bin/ischroot; }; then
    apparmor_parser --replace --write-cache --skip-read-cache "$profile_target"
  fi
fi
