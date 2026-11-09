import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountStore, StoreError } from '../dist/src/store.js';

test('accounts persist salted hashes while one-use tickets stay out of the file', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-js-store-'));
  let store;
  t.after(() => { store?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let now = 1000;
  store = new AccountStore(directory, { clock: () => now });
  const alice = store.createAccount('alice', 'first-password');
  const avatar = store.createAvatar(alice, 'Alice');
  assert.equal(store.authenticate('ALICE', 'first-password')?.id, alice.id);
  assert.equal(store.authenticate('alice', 'wrong'), null);
  const token = store.issueToken(alice, avatar, 1);
  const saved = fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8');
  assert.ok(!saved.includes('first-password')); assert.ok(!saved.includes(token));
  assert.equal(store.consumeToken('missing', token), null);
  assert.equal(store.consumeToken('alice', token)?.avatarId, avatar.id);
  assert.equal(store.consumeToken('alice', token), null);
  const expired = store.issueToken(alice, avatar, 1); now += 2000;
  assert.equal(store.consumeToken('alice', expired), null);
  store.close(); store = new AccountStore(directory);
  assert.equal(store.authenticate('alice', 'first-password')?.name, 'alice');
  assert.equal(store.findAvatar(store.account('alice'), 'Alice')?.name, 'Alice');
  assert.equal(store.consumeToken('alice', token), null);
});

test('native name bounds, global avatar uniqueness, capacity and single-writer lock', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-js-limits-'));
  const store = new AccountStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.throws(() => new AccountStore(directory), /locked/);
  for (const name of [7, undefined, null, {}]) assert.throws(() => store.createAccount(name, 'pw'), StoreError);
  for (const [name, password] of [['x'.repeat(25), 'ok'], ['good', 'bad\x7f'], ['good', 'bad\n']]) assert.throws(() => store.createAccount(name, password), StoreError);
  const a = store.createAccount('one', 'pass', { capacity: 1 });
  const b = store.createAccount('two', 'pass');
  const avatar = store.createAvatar(a, 'Owned');
  assert.throws(() => store.createAvatar(a, 'Second'), /capacity/);
  assert.throws(() => store.createAvatar(b, 'owned'), /in use/);
  assert.throws(() => store.createAvatar(b, 'Create New'), StoreError);
  assert.throws(() => store.issueToken(b, avatar), /belong/);
  assert.equal(store.findAvatar(b, 'Owned'), null);
});

test('failed atomic writes do not commit account or avatar state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-js-failure-'));
  const store = new AccountStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const account = store.createAccount('owner', 'pw');
  const before = fs.readFileSync(path.join(directory, 'accounts.json'));
  const nextAccount = store.state.nextAccount, nextAvatar = store.state.nextAvatar;
  t.mock.method(fs, 'renameSync', () => { const error = new Error('injected persistence failure'); error.code = 'EACCES'; throw error; });
  assert.throws(() => store.createAccount('failed', 'pw'), /injected/);
  assert.equal(store.account('failed'), null);
  assert.equal(store.state.nextAccount, nextAccount);
  assert.throws(() => store.createAvatar(account, 'FailedAvatar'), /injected/);
  assert.equal(store.findAvatar(account, 'FailedAvatar'), null);
  assert.equal(store.state.nextAvatar, nextAvatar);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'accounts.json')), before);
  t.mock.restoreAll();
  assert.equal(store.createAvatar(account, 'Works').id, nextAvatar);
});
