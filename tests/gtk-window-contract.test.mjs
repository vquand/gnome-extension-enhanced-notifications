import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const extensionSource = readFileSync(
    new URL('../extension.js', import.meta.url),
    'utf8'
);
const applicationSource = readFileSync(
    new URL('../application.js', import.meta.url),
    'utf8'
);
const schemaSource = readFileSync(
    new URL('../schemas/org.gnome.shell.extensions.notification-history.gschema.xml', import.meta.url),
    'utf8'
);

assert.doesNotMatch(
    extensionSource,
    /ModalDialog|NotificationHistoryDialog|NotificationHistorySettingsDialog/,
    'the extension must not create Shell modal dialogs'
);
assert.match(extensionSource, /Gio\.DBusExportedObject\.wrapJSObject/);
assert.match(extensionSource, /\.unexport\(\)/, 'disable must unexport the D-Bus object');
assert.match(extensionSource, /Gio\.bus_unown_name/, 'disable must release the D-Bus name');
assert.match(extensionSource, /Gio\.Subprocess\.new/);
assert.match(
    extensionSource,
    /for \(const source of Main\.messageTray\.getSources\(\)\)\s*this\._watchSource\(source, false\)/,
    'startup must watch existing sources without backfilling old notifications'
);
assert.match(
    extensionSource,
    /connect\('destroy',[\s\S]*?_notificationSignalIds\.delete\(notification\)[\s\S]*?_recordByNotification\.delete\(notification\)/,
    'destroyed notification objects must be forgotten before extension teardown'
);
assert.match(
    extensionSource,
    /_unwatchSource\(source,[\s\S]*?record\.source === source[\s\S]*?record\.source = null/,
    'historical records must release disposed Shell source objects'
);

assert.match(applicationSource, /Adw\.ApplicationWindow/);
assert.match(applicationSource, /add_titled_with_icon\([\s\S]*'history',[\s\S]*'History',[\s\S]*'view-list-symbolic'/);
assert.match(applicationSource, /add_titled_with_icon\([\s\S]*'preferences',[\s\S]*'Preferences',[\s\S]*'preferences-system-symbolic'/);
assert.match(applicationSource, /Adw\.ViewStack/);
assert.match(applicationSource, /Adw\.ViewSwitcher/);
assert.match(applicationSource, /Gtk\.EventControllerKey/, 'the window must handle keyboard shortcuts');
assert.match(applicationSource, /Gdk\.KEY_Escape/, 'Escape must be the window close shortcut');
assert.match(applicationSource, /this\._window\.close\(\)/, 'Escape must close the window');
assert.match(applicationSource, /'SetCascadeApps'/, 'preferences must save selected applications');

assert.match(schemaSource, /<key name="cascade-read-apps"/);
assert.match(extensionSource, /get_strv\(CASCADE_APPS_KEY\)/, 'the extension must reload saved application settings');
assert.match(extensionSource, /set_strv\(CASCADE_APPS_KEY, values\)/, 'the extension must persist application settings');
assert.match(extensionSource, /Gio\.Settings\.sync\(\)/, 'saved application settings must be flushed');
assert.doesNotMatch(
    schemaSource,
    /<key name="(?:notifications|history|records)"/i,
    'GSettings must contain preferences only, never notification history'
);

console.log('notification history GTK window contract tests passed');
