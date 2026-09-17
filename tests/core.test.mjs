import assert from 'node:assert/strict';

import {
    DBUS_XML,
    notificationFromTuple,
    notificationToTuple,
} from '../contract.js';

assert.match(DBUS_XML, /a\(ssssssxbb\)/, 'both trailing state fields must be booleans');

const liveNotification = {acknowledged: true};
const record = {
    id: '42',
    appId: 'org.example.App.desktop',
    appName: 'Example',
    iconName: 'org.example.App',
    title: 'Build complete',
    body: 'Everything passed',
    timestamp: 1_750_000_000,
    read: false,
    gicon: {private: true},
    source: {private: true},
    liveNotification,
};

const tuple = notificationToTuple(record);

assert.deepEqual(tuple, [
    '42',
    'org.example.App.desktop',
    'Example',
    'org.example.App',
    'Build complete',
    'Everything passed',
    1_750_000_000n,
    true,
    true,
]);

assert.deepEqual(notificationFromTuple(tuple), {
    id: '42',
    appId: 'org.example.App.desktop',
    appName: 'Example',
    iconName: 'org.example.App',
    title: 'Build complete',
    body: 'Everything passed',
    timestamp: 1_750_000_000,
    read: true,
    canActivate: true,
});

assert.equal(
    Object.values(notificationFromTuple(tuple)).includes(liveNotification),
    false,
    'the public snapshot must not expose live Shell objects'
);

console.log('notification history core contract tests passed');
