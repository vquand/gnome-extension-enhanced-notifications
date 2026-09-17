import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {
    APPLICATION_ID,
    DBUS_INTERFACE,
    DBUS_NAME,
    DBUS_PATH,
    notificationFromTuple,
} from './contract.js';
import {
    applicationSummaries,
    filterNotifications,
    groupNotifications,
    recordIsRead,
} from './core.js';

function clearListBox(listBox) {
    let child = listBox.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        listBox.remove(child);
        child = next;
    }
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

const NotificationHistoryApplication = GObject.registerClass(
class NotificationHistoryApplication extends Adw.Application {
    constructor() {
        super({
            application_id: APPLICATION_ID,
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });
        this._window = null;
        this._proxy = null;
        this._records = [];
        this._cascadeApps = new Set();
        this._showRead = false;
        this._chronological = false;
    }

    vfunc_activate() {
        if (!this._window)
            this._buildWindow();

        this._connectToExtension();
        this._window.present();
    }

    _buildWindow() {
        this._window = new Adw.ApplicationWindow({
            application: this,
            title: 'Notification History',
            default_width: 760,
            default_height: 680,
        });
        const escapeController = new Gtk.EventControllerKey();
        escapeController.propagation_phase = Gtk.PropagationPhase.CAPTURE;
        escapeController.connect('key-pressed', (_controller, keyval) => {
            if (keyval !== Gdk.KEY_Escape)
                return false;

            this._window.close();
            return true;
        });
        this._window.add_controller(escapeController);

        const toolbarView = new Adw.ToolbarView();
        const headerBar = new Adw.HeaderBar();
        this._stack = new Adw.ViewStack();
        const viewSwitcher = new Adw.ViewSwitcher({
            stack: this._stack,
            policy: Adw.ViewSwitcherPolicy.WIDE,
        });
        headerBar.set_title_widget(viewSwitcher);
        toolbarView.add_top_bar(headerBar);

        this._historyPage = this._buildHistoryPage();
        this._preferencesPage = new Adw.PreferencesPage();
        this._renderPreferences();

        this._stack.add_titled_with_icon(
            this._historyPage,
            'history',
            'History',
            'view-list-symbolic'
        );
        this._stack.add_titled_with_icon(
            this._preferencesPage,
            'preferences',
            'Preferences',
            'preferences-system-symbolic'
        );
        toolbarView.set_content(this._stack);
        this._window.set_content(toolbarView);
    }

    _buildHistoryPage() {
        const page = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });

        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 9,
        });
        this._searchEntry = new Gtk.SearchEntry({
            hexpand: true,
            placeholder_text: 'Search notification content',
        });
        this._searchEntry.connect('search-changed', () => this._renderHistory());
        controls.append(this._searchEntry);

        this._readButton = new Gtk.ToggleButton({label: 'Show read'});
        this._readButton.connect('toggled', button => {
            this._showRead = button.active;
            this._renderHistory();
        });
        controls.append(this._readButton);

        this._orderButton = new Gtk.ToggleButton({label: 'Chronological'});
        this._orderButton.connect('toggled', button => {
            this._chronological = button.active;
            this._renderHistory();
        });
        controls.append(this._orderButton);
        page.append(controls);

        this._historyState = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            vexpand: true,
        });
        this._emptyPage = new Adw.StatusPage({
            title: 'No notifications yet',
            description: 'Notifications from this login session will appear here.',
            icon_name: 'view-list-symbolic',
        });
        this._historyState.add_named(this._emptyPage, 'empty');

        this._historyList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
        });
        this._historyList.add_css_class('boxed-list');
        this._historyList.connect('row-activated', (_list, row) => {
            if (row.notificationId)
                this._call('Activate', new GLib.Variant('(s)', [row.notificationId]));
        });
        const scroller = new Gtk.ScrolledWindow({
            child: this._historyList,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vexpand: true,
        });
        this._historyState.add_named(scroller, 'list');
        page.append(this._historyState);
        return page;
    }

    _call(method, parameters = null) {
        if (!this._proxy)
            return null;

        try {
            return this._proxy.call_sync(
                method,
                parameters,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
        } catch (error) {
            console.error(`Notification History ${method} failed: ${error.message}`);
            return null;
        }
    }

    _connectToExtension() {
        if (this._proxy)
            return;

        try {
            this._proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                DBUS_NAME,
                DBUS_PATH,
                DBUS_INTERFACE,
                null
            );
            this._proxy.connect('g-signal', (_proxy, _sender, signalName) => {
                if (signalName === 'Changed')
                    this._refreshSnapshot();
            });
            this._proxy.connect('notify::g-name-owner', () => {
                if (this._proxy.get_name_owner())
                    this._refreshSnapshot();
                else
                    this._showUnavailable();
            });
            this._refreshSnapshot();
        } catch (error) {
            console.error(`Could not connect to Notification History: ${error.message}`);
            this._showUnavailable();
        }
    }

    _refreshSnapshot() {
        const result = this._call('GetSnapshot');
        if (!result) {
            this._showUnavailable();
            return;
        }

        try {
            const [notifications, cascadeApps] = result.deepUnpack();
            this._records = notifications.map(notificationFromTuple);
            this._cascadeApps = new Set(cascadeApps);
            this._renderHistory();
            this._renderPreferences();
        } catch (error) {
            console.error(`Could not refresh Notification History: ${error.message}`);
            this._showUnavailable();
        }
    }

    _showUnavailable() {
        this._records = [];
        this._emptyPage.title = 'Extension unavailable';
        this._emptyPage.description = 'Enable Notification History, then reopen this window.';
        this._emptyPage.icon_name = 'dialog-warning-symbolic';
        this._historyState.visible_child_name = 'empty';
    }

    _renderHistory() {
        clearListBox(this._historyList);
        const searchText = this._searchEntry.text;
        const records = filterNotifications(this._records, {
            showRead: this._showRead,
            chronological: this._chronological,
            searchText,
        });

        if (records.length === 0) {
            this._emptyPage.title = searchText.trim()
                ? 'No matching notifications'
                : 'No notifications to show';
            this._emptyPage.description = searchText.trim()
                ? 'Try another search term or include read notifications.'
                : 'Notifications from this login session will appear here.';
            this._emptyPage.icon_name = 'view-list-symbolic';
            this._historyState.visible_child_name = 'empty';
            return;
        }

        if (this._chronological) {
            for (const record of records)
                this._historyList.append(this._notificationRow(record));
        } else {
            for (const group of groupNotifications(records)) {
                this._historyList.append(this._groupRow(group));
                for (const record of group.notifications)
                    this._historyList.append(this._notificationRow(record));
            }
        }

        this._historyState.visible_child_name = 'list';
    }

    _groupRow(group) {
        const unreadCount = group.notifications.filter(record => !recordIsRead(record)).length;
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 9,
            margin_top: 9,
            margin_bottom: 6,
            margin_start: 12,
            margin_end: 12,
        });
        box.append(new Gtk.Image({
            icon_name: group.iconName || 'dialog-information-symbolic',
            pixel_size: 18,
        }));
        const label = new Gtk.Label({
            label: group.appName,
            xalign: 0,
            hexpand: true,
        });
        label.add_css_class('heading');
        box.append(label);
        if (unreadCount > 0) {
            const count = new Gtk.Label({label: `${unreadCount} unread`});
            count.add_css_class('dim-label');
            box.append(count);
        }

        return new Gtk.ListBoxRow({
            child: box,
            activatable: false,
            selectable: false,
        });
    }

    _notificationRow(record) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 12,
            margin_end: 12,
        });
        box.append(new Gtk.Image({
            icon_name: record.iconName || 'dialog-information-symbolic',
            pixel_size: 28,
        }));

        const text = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            hexpand: true,
        });
        const title = new Gtk.Label({
            label: record.title || 'Notification',
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
        });
        title.add_css_class(recordIsRead(record) ? 'dim-label' : 'heading');
        text.append(title);
        if (record.body) {
            const body = new Gtk.Label({
                label: record.body,
                xalign: 0,
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                max_width_chars: 64,
                lines: 2,
                ellipsize: Pango.EllipsizeMode.END,
            });
            body.add_css_class('dim-label');
            text.append(body);
        }
        box.append(text);

        const time = new Gtk.Label({
            label: formatTimestamp(record.timestamp),
            valign: Gtk.Align.START,
        });
        time.add_css_class('dim-label');
        box.append(time);

        const row = new Gtk.ListBoxRow({
            child: box,
            activatable: true,
            selectable: false,
            tooltip_text: record.canActivate
                ? 'Open notification'
                : 'The original notification is no longer active',
        });
        row.notificationId = record.id;
        return row;
    }

    _renderPreferences() {
        if (this._preferencesGroup)
            this._preferencesPage.remove(this._preferencesGroup);

        this._preferencesGroup = new Adw.PreferencesGroup({
            title: 'Read behavior by app',
            description: 'When enabled, opening a notification also marks earlier notifications from that app as read.',
        });
        this._preferencesPage.add(this._preferencesGroup);

        const summaries = applicationSummaries(this._records);
        if (summaries.length === 0) {
            this._preferencesGroup.add(new Adw.ActionRow({
                title: 'No applications yet',
                subtitle: 'Apps appear after they send a notification in this session.',
            }));
            return;
        }

        for (const summary of summaries) {
            const row = new Adw.SwitchRow({
                title: summary.appName,
                subtitle: `${summary.totalCount} notification${summary.totalCount === 1 ? '' : 's'} this session`,
                active: this._cascadeApps.has(summary.appId),
            });
            row.add_prefix(new Gtk.Image({
                icon_name: summary.iconName || 'dialog-information-symbolic',
                pixel_size: 24,
            }));
            row.connect('notify::active', () => {
                if (row.active)
                    this._cascadeApps.add(summary.appId);
                else
                    this._cascadeApps.delete(summary.appId);

                this._call(
                    'SetCascadeApps',
                    new GLib.Variant('(as)', [[...this._cascadeApps].sort()])
                );
            });
            this._preferencesGroup.add(row);
        }
    }
});

const application = new NotificationHistoryApplication();
application.run(ARGV);
