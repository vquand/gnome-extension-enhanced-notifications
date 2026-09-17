import {recordIsRead} from './core.js';

export const DBUS_NAME = 'org.gnome.Shell.Extensions.NotificationHistory';
export const DBUS_PATH = '/org/gnome/Shell/Extensions/NotificationHistory';
export const DBUS_INTERFACE = 'org.gnome.Shell.Extensions.NotificationHistory';
export const APPLICATION_ID = 'org.gnome.Shell.Extensions.NotificationHistory.Window';

export const DBUS_XML = `
<node>
  <interface name="${DBUS_INTERFACE}">
    <method name="GetSnapshot">
      <arg name="notifications" type="a(ssssssxbb)" direction="out"/>
      <arg name="cascadeApps" type="as" direction="out"/>
    </method>
    <method name="Activate">
      <arg name="id" type="s" direction="in"/>
    </method>
    <method name="MarkRead">
      <arg name="id" type="s" direction="in"/>
    </method>
    <method name="SetCascadeApps">
      <arg name="appIds" type="as" direction="in"/>
    </method>
    <signal name="Changed"/>
  </interface>
</node>`;

function stringValue(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

export function notificationToTuple(record) {
    return [
        stringValue(record?.id),
        stringValue(record?.appId),
        stringValue(record?.appName),
        stringValue(record?.iconName, 'dialog-information-symbolic'),
        stringValue(record?.title),
        stringValue(record?.body),
        BigInt(Number.isFinite(record?.timestamp) ? Math.trunc(record.timestamp) : 0),
        recordIsRead(record),
        Boolean(record?.liveNotification || record?.source?.open),
    ];
}

export function notificationFromTuple(tuple) {
    const [
        id,
        appId,
        appName,
        iconName,
        title,
        body,
        timestamp,
        read,
        canActivate,
    ] = tuple;

    return {
        id,
        appId,
        appName,
        iconName,
        title,
        body,
        timestamp: Number(timestamp),
        read,
        canActivate,
    };
}
