# Maintainer Guide

This repository contains `notification-history@willdo`, a GNOME Shell 50
extension.

## Source layout

- `extension.js`: notification-tray integration, D-Bus service, and app launcher.
- `application.js`: GTK 4/libadwaita history and preferences window.
- `contract.js`: typed D-Bus contract and record serialization.
- `core.js`: filtering, grouping, sorting, and read-state logic.
- `schemas/`: GSettings schema.
- `dist/`: published ZIP and checksum.

## Rules

- Keep notification history in memory for the current Shell session only.
- Retain only the data needed to display, search, group, sort, and activate
  notifications.
- Disconnect notification and Shell signals, unexport D-Bus, and destroy every
  Shell actor during `disable()`.
- Do not add telemetry, remote storage, screenshots, local paths, or personal
  notification data to the repository.
- Keep `metadata.json` targeted to GNOME Shell 50.

## Checks

```bash
node tests/core.test.mjs
node tests/gtk-window-contract.test.mjs
node tests/modal-lifecycle.test.mjs
node --check extension.js
node --check application.js
glib-compile-schemas --strict --dry-run schemas
```

Build the release package with:

```bash
gnome-extensions pack --force --out-dir dist --extra-source=LICENSE \
  --extra-source=core.js \
  --extra-source=contract.js \
  --extra-source=application.js \
  --schema=schemas/org.gnome.shell.extensions.notification-history.gschema.xml \
  .
sha256sum dist/notification-history@willdo.shell-extension.zip > dist/SHA256SUMS
```
