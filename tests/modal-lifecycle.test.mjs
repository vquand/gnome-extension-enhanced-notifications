import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const extensionSource = readFileSync(
    new URL('../extension.js', import.meta.url),
    'utf8'
);

assert.doesNotMatch(
    extensionSource,
    /ModalDialog|pushModal|popModal/,
    'notification history must not participate in the Shell modal lifecycle'
);

console.log('notification history has no Shell modal lifecycle');
