export const FALLBACK_APP_ID = 'unknown-application';
export const FALLBACK_APP_NAME = 'Unknown application';

function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function firstText(...values) {
    return values.find(value => typeof value === 'string' && value.trim() !== '')?.trim() ?? '';
}

function themedIconNames(icon) {
    try {
        const names = icon?.get_names?.();
        return Array.isArray(names) ? names : [];
    } catch {
        return [];
    }
}

function sourceIconNames(source) {
    try {
        return [
            ...themedIconNames(source?.icon),
            ...themedIconNames(source?.gicon),
            ...themedIconNames(source?.app?.get_icon?.()),
        ];
    } catch {
        return [];
    }
}

function datetimeToUnixSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.floor(value);

    try {
        if (typeof value?.to_unix === 'function')
            return value.to_unix();
        if (typeof value?.to_unix_usec === 'function')
            return Math.floor(value.to_unix_usec() / 1_000_000);
        if (typeof value?.get_real_usec === 'function')
            return Math.floor(value.get_real_usec() / 1_000_000);
    } catch {
        return null;
    }

    return null;
}

function sourceAppId(source) {
    return firstText(
        source?.appId,
        source?._appId,
        source?.desktopId,
        source?.app?.id,
        source?.title,
        FALLBACK_APP_ID
    );
}

function sourceAppName(source, appId) {
    return firstText(
        source?.title,
        source?.app?.get_name?.(),
        appId === FALLBACK_APP_ID ? FALLBACK_APP_NAME : appId
    );
}

export function notificationRecord(notification, source, id, fallbackTimestamp = Date.now()) {
    const appId = sourceAppId(source);
    const timestamp = datetimeToUnixSeconds(notification?.datetime)
        ?? Math.floor(fallbackTimestamp / 1000);
    const appIconName = firstText(source?.iconName, ...sourceIconNames(source));
    const notificationIconName = firstText(
        notification?.iconName,
        ...themedIconNames(notification?.gicon)
    );

    return {
        id: `${id}`,
        appId,
        appName: sourceAppName(source, appId),
        iconName: appIconName || notificationIconName || 'dialog-information-symbolic',
        gicon: notification?.gicon ?? source?.icon ?? source?.gicon ??
            source?.app?.get_icon?.() ?? null,
        title: text(notification?.title),
        body: text(notification?.body),
        timestamp,
        // Native Shell acknowledgement also changes when the notification
        // list is opened. Read state is owned by the interaction handlers in
        // extension.js so merely viewing the list does not mark a record read.
        read: false,
        source: source ?? null,
        liveNotification: notification ?? null,
    };
}

export function recordIsRead(record) {
    return Boolean(record?.read);
}

export function filterNotifications(records, options = {}) {
    const showRead = Boolean(options.showRead);
    const chronological = Boolean(options.chronological);
    const query = text(options.searchText).trim().toLocaleLowerCase();
    const filtered = records.filter(record => {
        if (!showRead && recordIsRead(record))
            return false;

        if (!query)
            return true;

        const content = `${record.title} ${record.body}`.toLocaleLowerCase();
        return content.includes(query);
    });

    return filtered.sort((left, right) => {
        const difference = left.timestamp - right.timestamp;
        return chronological ? difference : -difference;
    });
}

export function groupNotifications(records) {
    const groups = new Map();

    for (const record of records) {
        if (!groups.has(record.appId)) {
            groups.set(record.appId, {
                appId: record.appId,
                appName: record.appName,
                iconName: record.iconName,
                gicon: record.gicon,
                notifications: [],
            });
        }

        groups.get(record.appId).notifications.push(record);
    }

    return [...groups.values()];
}

export function applicationSummaries(records) {
    const latestFirst = [...records].sort((left, right) => right.timestamp - left.timestamp);
    return groupNotifications(latestFirst).map(group => ({
        appId: group.appId,
        appName: group.appName,
        iconName: group.iconName,
        gicon: group.gicon,
        unreadCount: group.notifications.filter(record => !recordIsRead(record)).length,
        totalCount: group.notifications.length,
        latestTimestamp: group.notifications[0]?.timestamp ?? 0,
    }));
}

export function markReadWithCascade(records, target, cascadeApps = new Set()) {
    const targetRecord = typeof target === 'object'
        ? target
        : records.find(record => record.id === `${target}`);

    if (!targetRecord)
        return records;

    const cascade = cascadeApps.has(targetRecord.appId);
    for (const record of records) {
        if (record.id !== targetRecord.id &&
            (!cascade || record.appId !== targetRecord.appId || record.timestamp > targetRecord.timestamp))
            continue;

        record.read = true;
        if (record.liveNotification) {
            try {
                record.liveNotification.acknowledged = true;
            } catch {
                // A notification can be destroyed between rendering and clicking.
            }
        }
    }

    return records;
}
