# Spec: GTK Notification History Window

## Objective

Replace the GNOME Shell modal history and settings dialogs with one normal
GTK 4/libadwaita application window. The window has **History** and
**Preferences** tabs. The Shell extension remains responsible for collecting
notifications, retaining live notification objects, exposing unread counts in
the panel, and opening the application window.

Notification history is session-only. It must never be persisted, and a Shell
restart, extension restart, logout, or login must always begin with an empty
history.

## Tech Stack

- GNOME Shell 50 extension in GJS.
- GTK 4 and libadwaita application in GJS.
- Session D-Bus for communication between the Shell process and GTK process.
- GSettings only for the `cascade-read-apps` preference; never for history.

## Interface Contract

The extension owns `org.gnome.Shell.Extensions.NotificationHistory` at
`/org/gnome/Shell/Extensions/NotificationHistory` and exposes interface
`org.gnome.Shell.Extensions.NotificationHistory`.

- `GetSnapshot() -> (a(ssssssxbb) notifications, as cascadeApps)` returns only
  serializable display data. Notification fields are `id`, `appId`, `appName`,
  `iconName`, `title`, `body`, Unix timestamp, read state, and activation state.
- `Activate(s id)` marks the record read and activates its live Shell
  notification when it still exists.
- `MarkRead(s id)` marks a record read without activation.
- `SetCascadeApps(as appIds)` replaces the cascade-read application set.
- `Changed()` tells the application to request a fresh snapshot.

Inputs are validated at the D-Bus boundary. Unknown record IDs are safe no-ops.
The interface never exposes Shell objects or stores notification content.

## Commands

```bash
node tests/core.test.mjs
node tests/gtk-window-contract.test.mjs
node --check extension.js
node --check application.js
glib-compile-schemas --strict --dry-run schemas
gnome-extensions pack --force --out-dir dist --extra-source=LICENSE \
  --extra-source=core.js --extra-source=contract.js \
  --extra-source=application.js \
  --schema=schemas/org.gnome.shell.extensions.notification-history.gschema.xml .
```

## Project Structure

- `extension.js`: Shell collection, panel integration, D-Bus service, launcher.
- `application.js`: GTK/libadwaita window and both tabs.
- `core.js`: pure record filtering, grouping, and read-state logic.
- `contract.js`: D-Bus constants and record serialization logic.
- `tests/`: Node-based logic and source-contract regression tests.
- `schemas/`: persistent preferences only.
- `dist/`: installable extension package and checksum.

## Code Style

Use four-space indentation, braces on the same line, early returns, and explicit
boundary validation:

```js
function findRecord(records, id) {
    if (typeof id !== 'string')
        return null;

    return records.find(record => record.id === id) ?? null;
}
```

## Testing Strategy

- Pure unit tests cover snapshot serialization and session-only data shape.
- Source-contract tests verify that no modal dialog remains, the D-Bus object is
  unexported on disable, and the GTK window contains both required tabs.
- Syntax, schema, extension packaging, and installed-file checks cover
  integration boundaries.
- Manual verification covers window launch/focus, live updates, activation,
  preferences, and empty history after an extension/session restart.

## Boundaries

- Always: keep live notification objects inside Shell; clear the in-memory store
  during disable; unexport D-Bus during disable; preserve existing user changes.
- Ask first: add runtime dependencies, persist new data, change supported Shell
  versions, or add network access.
- Never: write notification content to disk, hold a Shell modal input grab, or
  expose non-serializable Shell objects over D-Bus.

## Implementation Plan and Tasks

- [x] Define and test snapshot serialization and the D-Bus source contract.
- [x] Export the D-Bus service and launch/focus the GTK application from the
  panel History button.
- [x] Build the History tab with search, unread filtering, ordering, grouping,
  and activation.
- [x] Build the Preferences tab with per-application cascade-read switches.
- [x] Remove the modal dialog implementation. Existing uncommitted Shell styling
  is retained even though the window no longer consumes those dialog classes.
- [x] Package and install the extension; smoke-test typed D-Bus snapshots and
  the GTK window. A logout/login is required for Shell to drop its old module
  cache and load the installed implementation.

## Success Criteria

- Clicking **History** opens or focuses one normal application window.
- The window has History and Preferences tabs and never creates a Shell modal.
- The History tab updates when records or read state change and preserves the
  existing search/filter/group/order behavior.
- Activating an available record invokes its live notification; stale records
  remain viewable without crashing.
- Preference changes take effect immediately and survive extension restarts.
- Notification records do not survive extension restart, Shell restart, logout,
  or login.
- Super and Alt+Tab continue working before, during, and after using the window.

## Open Questions

None. The user approved the architecture and session-clearing behavior.
