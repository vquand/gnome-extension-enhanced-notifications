# Notification History

`notification-history@willdo` extends the GNOME Shell notification indicator
with per-application unread counts and a searchable notification history.

## Scope and behavior

- Supports GNOME Shell 50.
- Shows one icon/count pair for each application with unread notifications in
  the top-bar clock area while the date menu is closed.
- Adds an `All notifications` button beside GNOME's `Clear` button.
- Opens a session-scoped history window with unread-only and all-notifications
  filters, application grouping, chronological ordering, and content search.
- Clicking a history row activates the original notification when it is still
  live, then marks it read. Per-application settings can also mark earlier
  notifications from that app as read.
- The history is held in memory and is reset when the extension or GNOME Shell
  is restarted. Notifications that GNOME discarded before this extension was
  enabled cannot be recovered through the Shell extension API.

## Install locally

```sh
extension_dir="$HOME/.local/share/gnome-shell/extensions/notification-history@willdo"
mkdir -p "$HOME/.local/share/gnome-shell/extensions"
ln -sfn "$PWD/notifications/notification-history@willdo" "$extension_dir"
glib-compile-schemas "$extension_dir/schemas"
gnome-extensions enable notification-history@willdo
```

On Wayland, log out and back in if GNOME Shell does not reload the extension
immediately.

## Package as a zip

From the repository root, build the release bundle:

```sh
gnome-extensions pack --force --out-dir dist --extra-source=LICENSE \
  --extra-source=core.js \
  --schema=schemas/org.gnome.shell.extensions.notification-history.gschema.xml \
  .
```

The Notification History package is written to `dist/`.

## Verification

```sh
glib-compile-schemas schemas
gjs tests/core.test.js
```

## Implementation specification

The extension uses `Main.messageTray` sources as the source of truth. Each
notification is copied into a small in-memory record when observed, and the
live Shell notification is retained only while it can still be activated or
marked acknowledged. Pure filtering/grouping/read-cascade rules live in
`core.js` so they can be tested without a running Shell session.
