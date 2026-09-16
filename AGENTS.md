# Maintainer Guide

This repository contains `notification-history@willdo`, a GNOME Shell 50
extension.

## Source layout

- `extension.js`: notification-tray integration and history UI.
- `core.js`: filtering, grouping, sorting, and read-state logic.
- `schemas/`: GSettings schema.
- `dist/`: published ZIP and checksum.

## Rules

- Keep notification history in memory for the current Shell session only.
- Retain only the data needed to display, search, group, sort, and activate
  notifications.
- Disconnect notification and Shell signals and destroy every dialog and actor
  during `disable()`.
- Do not add telemetry, remote storage, screenshots, local paths, or personal
  notification data to the repository.
- Keep `metadata.json` targeted to GNOME Shell 50.

## Checks

```bash
node --check extension.js
glib-compile-schemas --strict --dry-run schemas
```

Build the release package with:

```bash
gnome-extensions pack --force --out-dir dist --extra-source=LICENSE \
  --extra-source=core.js \
  --schema=schemas/org.gnome.shell.extensions.notification-history.gschema.xml \
  .
sha256sum dist/notification-history@willdo.shell-extension.zip > dist/SHA256SUMS
```
