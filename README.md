# Enhanced Notifications

Keep a searchable history of notifications from the current GNOME session.

## Features

- Show unread notification counts by application beside the top-bar clock.
- Open a full GTK 4/libadwaita window from the notification panel.
- Switch between History and Preferences in the same window.
- Start with unread notifications, or include read notifications.
- Group by application or sort chronologically.
- Search notification titles and content.
- Follow native read state: opening the notification list does not mark an item
  read; clicking or closing the notification does.
- Choose per application whether opening a notification also marks earlier
  notifications from that application as read.

Notification history is kept only in the GNOME Shell extension's memory. It is
cleared on extension restart, Shell restart, logout, and login. Notifications
still present in the native notification center are imported when the extension
starts so the history matches the center. Per-application read-behavior
preferences are stored in GSettings and persist across extension restarts.

## Install

This release supports GNOME Shell 50.

Install the package from `dist/`:

```bash
gnome-extensions install --force \
  dist/notification-history@willdo.shell-extension.zip
gnome-extensions enable notification-history@willdo
```

On Wayland, log out and back in if GNOME Shell does not discover the extension
immediately.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
