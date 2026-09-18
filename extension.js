import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    applicationSummaries,
    markReadWithCascade,
    notificationRecord,
} from './core.js';
import {
    DBUS_NAME,
    DBUS_PATH,
    DBUS_XML,
    notificationToTuple,
} from './contract.js';

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
            this._watchSource(source, true);
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
        const values = [...new Set(appIds.filter(value => typeof value === 'string'))].sort();
        try {
            if (this._settings) {
                this._settings.set_strv(CASCADE_APPS_KEY, values);
                Gio.Settings.sync();
            }
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

    findRecord(id) {
        if (typeof id !== 'string')
            return null;

        return this._records.find(record => record.id === id) ?? null;
    }

    _watchSource(source, captureExisting = true) {
        if (!source || this._sourceSignalIds.has(source))
            return;

        const ids = [
            source.connect('notification-added', (_source, notification) => {
                this._capture(notification, source);
            }),
            source.connect('notification-removed', () => this._notify()),
            source.connect('destroy', () => this._unwatchSource(source, false)),
        ];
        this._sourceSignalIds.set(source, ids);

        if (captureExisting) {
            for (const notification of source.notifications ?? [])
                this._capture(notification, source);
        }
    }

    _unwatchSource(source, disconnectSignals = true) {
        const ids = this._sourceSignalIds.get(source);
        if (!ids)
            return;

        this._sourceSignalIds.delete(source);
        if (disconnectSignals) {
            for (const id of ids) {
                try {
                    source.disconnect(id);
                } catch {
                    // The source may already be disposed during Shell teardown.
                }
            }
        }

        for (const record of this._records) {
            if (record.source === source)
                record.source = null;
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
        const activatedId = notification.connect('activated', () => {
            record.read = true;
            this._notify();
        });
        const destroyId = notification.connect('destroy', (_notification, reason) => {
            if (reason === MessageTray.NotificationDestroyedReason.DISMISSED)
                record.read = true;
            record.liveNotification = null;
            this._notificationSignalIds.delete(notification);
            this._recordByNotification.delete(notification);
            this._notify();
        });
        this._notificationSignalIds.set(notification, [notifyId, activatedId, destroyId]);
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

class NotificationHistoryService {
    constructor(store) {
        this._store = store;
        this._object = null;
        this._ownerId = 0;
        this._changeListener = null;
    }

    start() {
        const implementation = {
            GetSnapshot: () => [
                this._store.records.map(notificationToTuple),
                [...this._store.cascadeApps].sort(),
            ],
            Activate: id => {
                const record = this._store.findRecord(id);
                if (record)
                    this._store.activate(record);
            },
            MarkRead: id => {
                const record = this._store.findRecord(id);
                if (record)
                    this._store.markRead(record);
            },
            SetCascadeApps: appIds => {
                if (Array.isArray(appIds))
                    this._store.setCascadeApps(appIds);
            },
        };

        this._object = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, implementation);
        this._object.export(Gio.DBus.session, DBUS_PATH);
        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            DBUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null,
            null,
            null
        );
        this._changeListener = this._store.addListener(() => {
            this._object?.emit_signal('Changed', null);
        });
    }

    stop() {
        if (this._changeListener)
            this._store.removeListener(this._changeListener);
        this._changeListener = null;

        this._object?.unexport();
        this._object = null;

        if (this._ownerId)
            Gio.bus_unown_name(this._ownerId);
        this._ownerId = 0;
        this._store = null;
    }
}

export default class NotificationHistoryExtension extends Extension {
    enable() {
        this._dateMenu = Main.panel?.statusArea?.dateMenu;
        this._settings = this.getSettings();
        this._store = new NotificationHistoryStore(this._settings);
        this._service = new NotificationHistoryService(this._store);
        this._applicationProcess = null;
        this._menuOpenChangedId = 0;
        this._storeChangeListener = this._store.addListener(() => this._render());

        this._store.start();
        this._service.start();
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
        this._service?.stop();
        this._service = null;
        this._applicationProcess = null;

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
        this._historyButton.connectObject(
            'clicked', () => this._openHistory(), this);

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

        this._historyButton.disconnectObject(this);

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
            this._dateMenu?.menu?.close?.();
            const gjs = GLib.find_program_in_path('gjs');
            if (!gjs)
                throw new Error('gjs is not installed');

            this._applicationProcess = Gio.Subprocess.new(
                ['gjs', '-m', `${this.path}/application.js`],
                Gio.SubprocessFlags.NONE
            );
        } catch (error) {
            logError(error, `${LOG_PREFIX} Could not open notification history`);
            Main.notify('Notification History', 'Could not open notification history.');
        }
    }
}
