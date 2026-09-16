# Enhanced Notifications

Keep a searchable history of notifications from the current GNOME session.

## Features

- Show unread notification counts by application beside the top-bar clock.
- Open a full notification history from the notification panel.
- Start with unread notifications, or include read notifications.
- Group by application or sort chronologically.
- Search notification titles and content.
- Choose per application whether opening a notification also marks earlier
  notifications from that application as read.

Notification history is kept in memory for the current GNOME session. It is
cleared when GNOME Shell or the extension restarts, and cannot recover
notifications that were removed before the extension was enabled.

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
