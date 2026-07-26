#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)

data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
bin_dir=${OPENCUT_BIN_DIR:-"$HOME/.local/bin"}
applications_dir="$data_home/applications"
icon_dir="$data_home/icons/hicolor/scalable/apps"
typelib_dir="$data_home/opencut/girepository-1.0"

mkdir -p "$bin_dir" "$applications_dir" "$icon_dir" "$typelib_dir"

install -m 0755 "$script_dir/opencut" "$bin_dir/opencut"
install -m 0644 "$repo_root/brand/marks/icon.svg" "$icon_dir/opencut.svg"
install -m 0644 "$script_dir/girepository-1.0/"*.typelib "$typelib_dir/"

# Exec paths in desktop entries are not shell-expanded, so write the absolute
# user-local command path into the installed copy.
sed "s|@EXEC@|$bin_dir/opencut|g" \
    "$script_dir/app.opencut.OpenCut.desktop" \
    > "$applications_dir/app.opencut.OpenCut.desktop"
chmod 0644 "$applications_dir/app.opencut.OpenCut.desktop"

if command -v desktop-file-validate >/dev/null 2>&1; then
    desktop-file-validate "$applications_dir/app.opencut.OpenCut.desktop"
fi
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications_dir"
fi

printf 'OpenCut installed.\n'
printf 'Terminal: %s/opencut\n' "$bin_dir"
printf 'App menu: search for OpenCut\n'
