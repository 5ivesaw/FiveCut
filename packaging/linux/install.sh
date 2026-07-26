#!/bin/sh
set -eu

bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
bin_dir=${FIVECUT_BIN_DIR:-"$HOME/.local/bin"}
install_dir=${FIVECUT_INSTALL_DIR:-"$data_home/fivecut"}
applications_dir="$data_home/applications"
icon_dir="$data_home/icons/hicolor/scalable/apps"

mkdir -p "$install_dir" "$bin_dir" "$applications_dir" "$icon_dir"
cp -R "$bundle_dir/app" "$bundle_dir/runtime" "$install_dir/"
install -m 0755 "$bundle_dir/fivecut" "$install_dir/fivecut"
install -m 0644 "$bundle_dir/LICENSE" "$bundle_dir/NOTICE.md" "$install_dir/"
install -m 0755 "$bundle_dir/fivecut" "$bin_dir/fivecut"

# The user-local command delegates to the installed portable bundle.
sed "s|bundle_dir=.*|bundle_dir=\"$install_dir\"|" \
    "$bundle_dir/fivecut" > "$bin_dir/fivecut"
chmod 0755 "$bin_dir/fivecut"

install -m 0644 "$bundle_dir/icon.svg" "$icon_dir/fivecut.svg"
sed "s|@EXEC@|$bin_dir/fivecut|g" \
    "$bundle_dir/app.fivecut.FiveCut.desktop" \
    > "$applications_dir/app.fivecut.FiveCut.desktop"
chmod 0644 "$applications_dir/app.fivecut.FiveCut.desktop"

if command -v desktop-file-validate >/dev/null 2>&1; then
    desktop-file-validate "$applications_dir/app.fivecut.FiveCut.desktop"
fi
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications_dir"
fi

printf 'FiveCut installed.\n'
printf 'Terminal: %s/fivecut\n' "$bin_dir"
printf 'App menu: search for FiveCut\n'
