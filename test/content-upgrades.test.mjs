import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldsAwayServer } from '../dist/src/server.js';
import { ensureContentUpgrades } from '../dist/src/content-upgrades.js';

test('bank repair upgrades saved starter state once while retaining operator changes and player balances', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-upgrade-'));
  const server = createWorldsAwayServer({ dataDir: directory });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = server.worldStore, avatar = store.ensureAvatar(server.store.listAvatars(server.store.account('demo'))[0]);
  const bankId = store.snapshot().contentMigrations['starter-1'].objects.atm;
  const prepareOld = changed => store.transaction(draft => {
    delete draft.contentMigrations['worldsaway-bank-state-1'];
    draft.objects[bankId].fields.choreState = 0;
    if (changed) draft.objects[bankId].fields.name = 'Operator custom bank';
  });
  prepareOld(false); const profile = store.getAvatar(avatar.id), oldIds = Object.keys(store.snapshot().objects);
  assert.equal(ensureContentUpgrades(store).updated, true);
  assert.equal(store.getObject(bankId).fields.choreState, 1);
  assert.deepEqual(store.getAvatar(avatar.id), profile); assert.deepEqual(Object.keys(store.snapshot().objects), oldIds);
  const committed = fs.readFileSync(store.filename);
  assert.equal(ensureContentUpgrades(store).updated, true); assert.deepEqual(fs.readFileSync(store.filename), committed);
  prepareOld(true); assert.equal(ensureContentUpgrades(store).updated, false);
  assert.equal(store.getObject(bankId).fields.choreState, 0);
  assert.equal(store.getObject(bankId).fields.name, 'Operator custom bank');
});

test('device migration write failure retains the complete previous world and retries cleanly', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-upgrade-failure-'));
  const server = createWorldsAwayServer({ dataDir: directory });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = server.worldStore, bankId = store.snapshot().contentMigrations['starter-1'].objects.atm;
  store.transaction(draft => { delete draft.contentMigrations['worldsaway-bank-state-1']; draft.objects[bankId].fields.choreState = 0; });
  const before = store.snapshot(), rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (target === store.filename) throw new Error('simulated disk error'); return rename(source, target); };
  try { assert.throws(() => ensureContentUpgrades(store), /simulated disk error/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(store.snapshot(), before);
  assert.equal(ensureContentUpgrades(store).updated, true);
});
