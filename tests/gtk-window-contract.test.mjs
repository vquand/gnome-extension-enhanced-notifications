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
    /this\._historyButton\.connectObject\(\s*'clicked'/,
    'the history button signal must be owned by the extension for clean teardown'
);
assert.match(
    extensionSource,
    /Gio\.Subprocess\.new\(\s*\[\s*'gjs',\s*'-m',\s*`\$\{this\.path\}\/application\.js`\s*\]/,
    'the GTK application launch must remain statically discoverable for packaging checks'
);
assert.match(
    extensionSource,
    /for \(const source of Main\.messageTray\.getSources\(\)\)\s*this\._watchSource\(source, true\)/,
    'startup must capture notifications already present in the native center'
);
assert.match(
    extensionSource,
    /connect\('destroy',[\s\S]*?_notificationSignalIds\.delete\(notification\)[\s\S]*?_recordByNotification\.delete\(notification\)/,
    'destroyed notification objects must be forgotten before extension teardown'
);
assert.match(
    extensionSource,
    /notification\.connect\('activated',[\s\S]*?record\.read = true/,
    'native notification activation must mark the record read'
);
assert.match(
    extensionSource,
    /connect\('destroy',[\s\S]*?markNotificationRemoved\(record\)/,
    'every notification removed from the native center must be marked read'
);
assert.doesNotMatch(
    extensionSource,
    /NotificationDestroyedReason\.DISMISSED/,
    'native-center synchronization must not ignore non-dismissal removal reasons'
);
assert.match(
    extensionSource,
    /_unwatchSource\(source,[\s\S]*?record\.source === source[\s\S]*?record\.source = null/,
    'historical records must release disposed Shell source objects'
);
assert.match(
    extensionSource,
    /const insertIndex = clockBox\.get_children\(\)\.indexOf\(clockDisplay\);\s*clockBox\.insert_child_at_index\(this\._topIndicator, Math\.max\(0, insertIndex\)\)/,
    'the notification indicator must be inserted before the centered clock'
);
assert.match(
    extensionSource,
    /this\._topIndicatorPad\.add_constraint\(new Clutter\.BindConstraint\(\{\s*source: this\._topIndicator,\s*coordinate: Clutter\.BindCoordinate\.SIZE,/,
    'the clock must have a matching right-side size pad when the left indicator is visible'
);
assert.match(
    extensionSource,
    /this\._topIndicatorPad\.visible = this\._topIndicator\.visible/,
    'the balancing pad must only reserve space while the indicator is visible'
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
assert.match(
    applicationSource,
    /function main\(\)\s*\{[\s\S]*new NotificationHistoryApplication\(\)/,
    'the separately launched GTK application must initialize from its entrypoint'
);

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
