import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../config.js';

// The mcp-hub desktop app reads this file to warn about settings the Hub file leaves empty. The file names
// key paths only; this test keeps it in the format mcp-hub expects and to the sections this server reads.
type Requirements = { version: number; groups: { id?: string; label: string; anyOf: string[][] }[] };

const requirements = JSON.parse(readFileSync(join(PROJECT_ROOT, 'hub-requirements.json'), 'utf8')) as Requirements;
const KEY_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const SECTIONS = new Set(['openobserve', 'seq']);

test('hub-requirements.json is version 1 with groups of key paths', () => {
  assert.equal(requirements.version, 1);
  assert.ok(requirements.groups.length > 0);
  for (const group of requirements.groups) {
    assert.ok(group.label.trim(), 'every group has a label');
    assert.ok(group.anyOf.length > 0, 'anyOf is not empty');
    for (const alternative of group.anyOf) {
      assert.ok(alternative.length > 0, 'an alternative is not empty');
      for (const key of alternative) assert.match(key, KEY_PATH);
    }
  }
});

test('the log account group has the id config_status reports', () => {
  assert.deepEqual(requirements.groups.map((g) => g.id), ['log_account']);
});

test('every required key sits in a section this server reads from the Hub file', () => {
  for (const group of requirements.groups) {
    for (const key of group.anyOf.flat()) assert.ok(SECTIONS.has(key.split('.')[0]), `unexpected section in ${key}`);
  }
});
