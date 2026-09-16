import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    applicationSummaries,
    filterNotifications,
    groupNotifications,
    markReadWithCascade,
    notificationRecord,
    recordIsRead,
} from './core.js';

const CASCADE_APPS_KEY = 'cascade-read-apps';
const LOG_PREFIX = '[Notification History]';

function childrenOf(actor) {
    try {
        return actor?.get_children?.() ?? [];
    } catch {
        return [];
    }
}

function styleClassName(actor) {
    try {
        return actor?.get_style_class_name?.() ?? '';
    } catch {
        return '';
    }
}

function findActor(actor, predicate) {
    if (!actor)
        return null;
    if (predicate(actor))
        return actor;

    for (const child of childrenOf(actor)) {
        const match = findActor(child, predicate);
        if (match)
            return match;
    }

    return null;
}

function notificationIcon(record, iconSize = 18, styleClass = 'notification-history-icon') {
    const params = {
        icon_size: iconSize,
        style_class: styleClass,
    };

    if (record.gicon)
        params.gicon = record.gicon;
    else
        params.icon_name = record.iconName || 'dialog-information-symbolic';

    return new St.Icon(params);
}

function formatTimestamp(timestamp) {
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime()))
        return '';

    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

function setLabelEllipsize(label, mode = Pango.EllipsizeMode.END) {
    label.clutter_text.ellipsize = mode;
    return label;
}

function setActorChild(actor, child) {
    if (typeof actor?.set_child === 'function')
        actor.set_child(child);
    else if (typeof actor?.set_child_actor === 'function')
        actor.set_child_actor(child);
    else
        actor.add_child(child);
}

function addSelectedStyle(actor, selected) {
    if (selected)
        actor.add_style_class_name('selected');
    else
        actor.remove_style_class_name('selected');
}

class NotificationHistoryStore {
    constructor(settings) {
        this._settings = settings;
        this._records = [];
        this._recordByNotification = new Map();
        this._notificationSignalIds = new Map();
        this._sourceSignalIds = new Map();
        this._listeners = new Set();
        this._traySignalIds = [];
        this._nextId = 1;
    }

    addListener(listener) {
        this._listeners.add(listener);
        return listener;
    }

    removeListener(listener) {
        this._listeners.delete(listener);
    }

    start() {
        if (!Main.messageTray)
            return;

        this._traySignalIds.push(Main.messageTray.connect(
            'source-added', (_tray, source) => this._watchSource(source)
        ));
        this._traySignalIds.push(Main.messageTray.connect(
            'source-removed', (_tray, source) => this._unwatchSource(source)
        ));
        this._traySignalIds.push(Main.messageTray.connect(
            'queue-changed', () => this._notify()
        ));

        for (const source of Main.messageTray.getSources())
            this._watchSource(source);
    }

    stop() {
        for (const id of this._traySignalIds) {
            try {
                Main.messageTray?.disconnect(id);
            } catch {
                // The Shell may already be tearing down the message tray.
            }
        }
        this._traySignalIds = [];

        for (const [source, ids] of this._sourceSignalIds) {
            for (const id of ids) {
                try {
                    source.disconnect(id);
                } catch {
                    // Source objects can be disposed before the extension.
                }
            }
        }
        this._sourceSignalIds.clear();

        for (const [notification, ids] of this._notificationSignalIds) {
            for (const id of ids) {
                try {
                    notification.disconnect(id);
                } catch {
                    // Notification objects can be disposed before the extension.
                }
            }
        }
        this._notificationSignalIds.clear();
        this._recordByNotification.clear();
        this._records = [];
        this._listeners.clear();
    }

    get records() {
        return this._records;
    }

    get appSummaries() {
        return applicationSummaries(this._records);
    }

    get cascadeApps() {
        try {
            return new Set(this._settings?.get_strv(CASCADE_APPS_KEY) ?? []);
        } catch {
            return new Set();
        }
    }

    setCascadeApps(appIds) {
        const values = [...new Set(appIds)].sort();
        try {
            this._settings?.set_strv(CASCADE_APPS_KEY, values);
        } catch (error) {
            logError(error, `${LOG_PREFIX} Could not save per-app read settings`);
        }
        this._notify();
    }

    markRead(record) {
        markReadWithCascade(this._records, record, this.cascadeApps);
        this._notify();
    }

    activate(record) {
        this.markRead(record);

        const liveNotification = record.liveNotification;
        try {
            if (liveNotification?.activate)
                liveNotification.activate();
            else if (record.source?.open)
                record.source.open();
        } catch (error) {
            logError(error, `${LOG_PREFIX} Could not activate notification`);
        }
    }

    _watchSource(source) {
        if (!source || this._sourceSignalIds.has(source))
            return;

        const ids = [
            source.connect('notification-added', (_source, notification) => {
                this._capture(notification, source);
            }),
            source.connect('notification-removed', () => this._notify()),
            source.connect('destroy', () => this._unwatchSource(source)),
        ];
        this._sourceSignalIds.set(source, ids);

        for (const notification of source.notifications ?? [])
            this._capture(notification, source);
    }

    _unwatchSource(source) {
        const ids = this._sourceSignalIds.get(source);
        if (!ids)
            return;

        this._sourceSignalIds.delete(source);
        for (const id of ids) {
            try {
                source.disconnect(id);
            } catch {
                // The source is normally already disposed at this point.
            }
        }
        this._notify();
    }

    _capture(notification, source) {
        if (!notification)
            return;

        const existing = this._recordByNotification.get(notification);
        if (existing) {
            this._refreshRecord(existing, notification, source);
            return;
        }

        const record = notificationRecord(notification, source, this._nextId++);
        this._records.push(record);
        this._recordByNotification.set(notification, record);

        const notifyId = notification.connect('notify', () => {
            this._refreshRecord(record, notification, source);
            this._notify();
        });
        const destroyId = notification.connect('destroy', () => {
            record.liveNotification = null;
            this._notify();
        });
        this._notificationSignalIds.set(notification, [notifyId, destroyId]);
        this._notify();
    }

    _refreshRecord(record, notification, source) {
        const refreshed = notificationRecord(
            notification,
            source,
            record.id,
            record.timestamp * 1000
        );
        record.appId = refreshed.appId;
        record.appName = refreshed.appName;
        record.iconName = refreshed.iconName;
        record.gicon = refreshed.gicon;
        record.title = refreshed.title;
        record.body = refreshed.body;
        record.timestamp = refreshed.timestamp;
        record.read = record.read || refreshed.read;
        record.liveNotification = notification;
        record.source = source;
    }

    _notify() {
        for (const listener of this._listeners)
            listener();
    }
}

const NotificationHistoryDialog = GObject.registerClass(
class NotificationHistoryDialog extends ModalDialog.ModalDialog {
    constructor(store, handlers) {
        super({styleClass: 'notification-history-dialog'});
        this._store = store;
        this._handlers = handlers;
        this._showRead = false;
        this._chronological = false;
        this._changeListener = this._store.addListener(() => this._render());
        this._buildContent();
    }

    _buildContent() {
        const root = new St.BoxLayout({
            vertical: true,
            style_class: 'notification-history-content',
            x_expand: true,
            y_expand: true,
        });
        this.contentLayout.add_child(root);

        const header = new St.BoxLayout({
            style_class: 'notification-history-header',
            x_expand: true,
        });
        header.add_child(new St.Label({
            text: 'Notification history',
            style_class: 'notification-history-title',
            x_expand: true,
        }));
        this._settingsButton = new St.Button({
            child: new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 18}),
            style_class: 'notification-history-icon-button',
            can_focus: true,
            accessible_name: 'Notification history settings',
        });
        this._settingsButton.connect('clicked', () => this._handlers?.settings());
        header.add_child(this._settingsButton);
        root.add_child(header);

        const filters = new St.BoxLayout({
            style_class: 'notification-history-filters',
            x_expand: true,
        });
        this._searchEntry = new St.Entry({
            hint_text: 'Search notification content',
            style_class: 'notification-history-search',
            can_focus: true,
            x_expand: true,
        });
        this._searchEntry.clutter_text.connect('text-changed', () => this._render());
        filters.add_child(this._searchEntry);

        this._readButton = new St.Button({
            label: 'Show read',
            style_class: 'notification-history-filter-button',
            can_focus: true,
        });
        this._readButton.connect('clicked', () => {
            this._showRead = !this._showRead;
            this._render();
        });
        filters.add_child(this._readButton);

        this._orderButton = new St.Button({
            label: 'By app',
            style_class: 'notification-history-filter-button',
            can_focus: true,
        });
        this._orderButton.connect('clicked', () => {
            this._chronological = !this._chronological;
            this._render();
        });
        filters.add_child(this._orderButton);
        root.add_child(filters);

        this._scrollView = new St.ScrollView({
            style_class: 'notification-history-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'notification-history-list',
            x_expand: true,
        });
        setActorChild(this._scrollView, this._listBox);
        root.add_child(this._scrollView);

        this.setButtons([
            {
                action: () => this._close(),
                key: Clutter.KEY_Escape,
                label: 'Close',
            },
        ]);
        this._render();
    }

    _close() {
        this._handlers?.close();
        this.close();
    }

    _render() {
        if (!this._listBox)
            return;

        this._listBox.destroy_all_children();
        this._readButton.label = this._showRead ? 'Unread only' : 'Show read';
        this._orderButton.label = this._chronological ? 'By app' : 'Chronological';
        addSelectedStyle(this._readButton, this._showRead);
        addSelectedStyle(this._orderButton, this._chronological);

        const searchText = this._searchEntry.clutter_text.get_text();
        const records = filterNotifications(this._store.records, {
            showRead: this._showRead,
            chronological: this._chronological,
            searchText,
        });

        if (records.length === 0) {
            this._listBox.add_child(new St.Label({
                text: searchText.trim()
                    ? 'No notifications match your search.'
                    : 'No notifications to show.',
                style_class: 'notification-history-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        if (this._chronological) {
            records.forEach(record => this._listBox.add_child(this._recordRow(record)));
            return;
        }

        for (const group of groupNotifications(records)) {
            this._listBox.add_child(this._groupHeader(group));
            for (const record of group.notifications)
                this._listBox.add_child(this._recordRow(record));
        }
    }

    _groupHeader(group) {
        const header = new St.BoxLayout({
            style_class: 'notification-history-group-header',
            x_expand: true,
        });
        header.add_child(notificationIcon(group, 18));
        header.add_child(new St.Label({
            text: group.appName,
            style_class: 'notification-history-group-name',
            x_expand: true,
        }));
        const unreadCount = group.notifications.filter(record => !recordIsRead(record)).length;
        if (unreadCount > 0)
            header.add_child(new St.Label({
                text: `${unreadCount} unread`,
                style_class: 'notification-history-group-count',
            }));
        return header;
    }

    _recordRow(record) {
        const read = recordIsRead(record);
        const title = record.title || 'Notification';
        const body = record.body || '';
        const button = new St.Button({
            style_class: read
                ? 'notification-history-row notification-history-row-read'
                : 'notification-history-row',
            can_focus: true,
            x_expand: true,
            accessible_name: `${record.appName}: ${title}`,
        });
        const row = new St.BoxLayout({
            style_class: 'notification-history-row-box',
            x_expand: true,
        });
        row.add_child(notificationIcon(record, 22, 'notification-history-row-icon'));

        const textBox = new St.BoxLayout({
            vertical: true,
            style_class: 'notification-history-row-text',
            x_expand: true,
        });
        textBox.add_child(setLabelEllipsize(new St.Label({
            text: title,
            style_class: 'notification-history-row-title',
            x_expand: true,
        })));
        textBox.add_child(setLabelEllipsize(new St.Label({
            text: body,
            style_class: 'notification-history-row-body',
            x_expand: true,
        })));
        row.add_child(textBox);
        row.add_child(new St.Label({
            text: formatTimestamp(record.timestamp),
            style_class: 'notification-history-row-time',
            y_align: Clutter.ActorAlign.START,
        }));
        setActorChild(button, row);
        button.connect('clicked', () => this._store.activate(record));
        return button;
    }

    destroy() {
        this._store.removeListener(this._changeListener);
        this._handlers = null;
        super.destroy();
    }
});

const NotificationHistorySettingsDialog = GObject.registerClass(
class NotificationHistorySettingsDialog extends ModalDialog.ModalDialog {
    constructor(store, onDone) {
        super({styleClass: 'notification-history-settings-dialog'});
        this._store = store;
        this._onDone = onDone;
        this._selectedApps = new Set(store.cascadeApps);
        this._buildContent();
    }

    _buildContent() {
        this.contentLayout.add_child(new St.Label({
            text: 'Read behavior by app',
            style_class: 'notification-history-title',
        }));
        this.contentLayout.add_child(new St.Label({
            text: 'When enabled, clicking a notification marks earlier notifications from the same app as read.',
            style_class: 'notification-history-description',
            x_expand: true,
        }));

        this._appList = new St.BoxLayout({
            vertical: true,
            style_class: 'notification-history-app-list',
            x_expand: true,
        });
        this.contentLayout.add_child(this._appList);
        this._renderApps();

        this.setButtons([
            {
                action: () => this._cancel(),
                key: Clutter.KEY_Escape,
                label: 'Cancel',
            },
            {
                action: () => this._save(),
                default: true,
                key: Clutter.KEY_Return,
                label: 'Save',
            },
        ]);
    }

    _renderApps() {
        this._appList.destroy_all_children();
        const summaries = applicationSummaries(this._store.records);

        if (summaries.length === 0) {
            this._appList.add_child(new St.Label({
                text: 'Apps will appear here after they send notifications.',
                style_class: 'notification-history-empty',
            }));
            return;
        }

        for (const summary of summaries) {
            const row = new St.BoxLayout({
                style_class: 'notification-history-app-row',
                x_expand: true,
            });
            row.add_child(notificationIcon(summary, 20));
            row.add_child(new St.Label({
                text: summary.appName,
                style_class: 'notification-history-app-name',
                x_expand: true,
            }));

            const enabled = this._selectedApps.has(summary.appId);
            const toggle = new St.Button({
                label: enabled ? 'On' : 'Off',
                style_class: 'notification-history-switch',
                can_focus: true,
                accessible_name: `${summary.appName} cascade read setting`,
            });
            addSelectedStyle(toggle, enabled);
            toggle.connect('clicked', () => {
                if (this._selectedApps.has(summary.appId))
                    this._selectedApps.delete(summary.appId);
                else
                    this._selectedApps.add(summary.appId);
                this._renderApps();
            });
            row.add_child(toggle);
            this._appList.add_child(row);
        }
    }

    _cancel() {
        this.close();
        this._onDone?.(false);
    }

    _save() {
        this._store.setCascadeApps(this._selectedApps);
        this.close();
        this._onDone?.(true);
    }

    destroy() {
        this._onDone = null;
        super.destroy();
    }
});

export default class NotificationHistoryExtension extends Extension {
    enable() {
        this._dateMenu = Main.panel?.statusArea?.dateMenu;
        this._settings = this.getSettings();
        this._store = new NotificationHistoryStore(this._settings);
        this._historyDialog = null;
        this._settingsDialog = null;
        this._historyOpen = false;
        this._menuOpenChangedId = 0;
        this._storeChangeListener = this._store.addListener(() => this._render());

        this._store.start();
        this._installTopBarIndicator();
        this._installHistoryButton();

        if (this._dateMenu?.menu) {
            this._menuOpenChangedId = this._dateMenu.menu.connect(
                'open-state-changed', () => this._render()
            );
        }

        this._render();
    }

    disable() {
        this._historyOpen = false;
        this._settingsDialog?.close();
        this._settingsDialog?.destroy();
        this._settingsDialog = null;
        this._historyDialog?.close();
        this._historyDialog?.destroy();
        this._historyDialog = null;

        if (this._menuOpenChangedId) {
            try {
                this._dateMenu?.menu?.disconnect(this._menuOpenChangedId);
            } catch {
                // The menu can already be disposed during a Shell restart.
            }
            this._menuOpenChangedId = 0;
        }

        this._removeHistoryButton();
        this._removeTopBarIndicator();
        this._store?.removeListener(this._storeChangeListener);
        this._store?.stop();
        this._settings = null;
        this._store = null;
        this._dateMenu = null;
    }

    _installTopBarIndicator() {
        const clockDisplay = this._dateMenu?._clockDisplay;
        const clockBox = clockDisplay?.get_parent?.();
        if (!clockDisplay || !clockBox?.insert_child_at_index)
            return;

        this._originalIndicator = this._dateMenu?._indicator ?? null;
        if (this._originalIndicator)
            this._originalIndicator.visible = false;

        this._topIndicator = new St.BoxLayout({
            style_class: 'notification-history-top-indicator',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const insertIndex = clockBox.get_children().indexOf(clockDisplay) + 1;
        clockBox.insert_child_at_index(this._topIndicator, Math.max(0, insertIndex));
    }

    _removeTopBarIndicator() {
        this._topIndicator?.destroy();
        this._topIndicator = null;
        if (this._originalIndicator) {
            if (this._originalIndicator._sync)
                this._originalIndicator._sync();
            else
                this._originalIndicator.visible = true;
        }
        this._originalIndicator = null;
    }

    _installHistoryButton() {
        const messageList = this._dateMenu?._messageList;
        if (!messageList)
            return;

        const clearButton = messageList._clearButton ?? findActor(
            messageList,
            actor => styleClassName(actor).split(' ').includes('message-list-clear-button')
        );
        const parent = clearButton?.get_parent?.();
        if (!clearButton || !parent)
            return;

        this._clearButton = clearButton;
        this._historyButton = new St.Button({
            child: this._historyButtonContent(),
            style_class: 'notification-history-button button',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            accessible_name: 'Open notification history',
        });
        this._historyButton.connect('clicked', () => this._openHistory());

        if (parent.layout_manager?.orientation === Clutter.Orientation.HORIZONTAL) {
            parent.add_style_class_name('notification-history-controls');
            parent.x_expand = true;
            parent.add_child(this._historyButton);
            this._historyButtonParent = parent;
            return;
        }

        const index = childrenOf(parent).indexOf(clearButton);
        this._clearOriginalIndex = Math.max(0, index);
        this._historyFooter = new St.BoxLayout({
            style_class: 'notification-history-controls',
            x_expand: true,
        });
        parent.remove_child(clearButton);
        this._historyFooter.add_child(clearButton);
        this._historyFooter.add_child(this._historyButton);
        if (parent.insert_child_at_index)
            parent.insert_child_at_index(this._historyFooter, Math.max(0, index));
        else
            parent.add_child(this._historyFooter);
        this._historyButtonParent = parent;
    }

    _historyButtonContent() {
        const content = new St.BoxLayout({
            style_class: 'notification-history-button-content',
        });
        content.add_child(new St.Icon({icon_name: 'view-list-symbolic', icon_size: 16}));
        content.add_child(new St.Label({text: 'History'}));
        return content;
    }

    _removeHistoryButton() {
        if (!this._historyButton)
            return;

        if (this._historyFooter) {
            const parent = this._historyButtonParent;
            this._historyFooter.remove_child(this._clearButton);
            if (parent?.insert_child_at_index)
                parent.insert_child_at_index(this._clearButton, this._clearOriginalIndex ?? 0);
            else
                parent?.add_child(this._clearButton);
            this._historyFooter.destroy();
        } else {
            this._historyButtonParent?.remove_child(this._historyButton);
            this._historyButtonParent?.remove_style_class_name('notification-history-controls');
            this._historyButton.destroy();
        }

        this._historyButton = null;
        this._historyButtonParent = null;
        this._historyFooter = null;
        this._clearOriginalIndex = null;
        this._clearButton = null;
    }

    _render() {
        if (!this._store)
            return;

        if (this._topIndicator) {
            this._topIndicator.destroy_all_children();
            for (const summary of this._store.appSummaries.filter(item => item.unreadCount > 0)) {
                this._topIndicator.add_child(notificationIcon(
                    summary,
                    14,
                    'notification-history-top-icon'
                ));
                this._topIndicator.add_child(new St.Label({
                    text: `${summary.unreadCount}`,
                    style_class: 'notification-history-top-count',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            this._topIndicator.visible = this._topIndicator.get_n_children() > 0 &&
                !this._dateMenu?.menu?.isOpen;
        }

    }

    _openHistory() {
        try {
            if (!this._historyDialog) {
                this._historyDialog = new NotificationHistoryDialog(this._store, {
                    close: () => {
                        this._historyOpen = false;
                    },
                    settings: () => this._openSettings(true),
                });
            }

            this._historyOpen = true;
            this._dateMenu?.menu?.close?.();
            this._historyDialog.open();
        } catch (error) {
            logError(error, `${LOG_PREFIX} Could not open notification history`);
            this._historyDialog?.destroy();
            this._historyDialog = null;
            this._historyOpen = false;
            Main.notify('Notification History', 'Could not open notification history.');
        }
    }

    _openSettings(reopenHistory = false) {
        if (this._settingsDialog)
            return;

        try {
            this._historyDialog?.close();
            this._settingsDialog = new NotificationHistorySettingsDialog(
                this._store,
                () => {
                    this._settingsDialog?.destroy();
                    this._settingsDialog = null;
                    if (reopenHistory)
                        this._openHistory();
                }
            );
            this._settingsDialog.open();
        } catch (error) {
            logError(error, `${LOG_PREFIX} Could not open notification settings`);
            this._settingsDialog?.destroy();
            this._settingsDialog = null;
            Main.notify('Notification History', 'Could not open notification settings.');
        }
    }
}
