import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SpecialActions, SUPPORTED_REQUESTS, applySpecialAction, applySpecialTimer } from '../dist/src/special-actions.js';
import { ClassRegistry } from '../dist/src/classes.js';
import { ResourceStore } from './helpers/fixtures.mjs';
import { WorldStore } from '../dist/src/world-store.js';
import { encodeContentsVector } from '../dist/src/world.js';

const clientDir = fileURLToPath(new URL('../../wa/', import.meta.url));
const registry = new ClassRegistry(new ResourceStore({ clientDir }));

function fixture(t, { role = 'player' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-special-'));
  const store = new WorldStore(directory, { clock: () => 1000 });
  const profile = store.ensureAvatar({ id: 1, accountId: 1, name: 'Alice' }, { classNumber: 21, role, balance: 0 });
  const other = store.ensureAvatar({ id: 2, accountId: 2, name: 'Bob' }, { classNumber: 21, balance: 0 });
  const session = { avatar: { id: 1, name: 'Alice' } };
  const replies = [], notices = [], refreshes = [], travel = [];
  const noid = id => typeof id === 'object' ? id.id + 100 : id + 100;
  const context = { worldStore: store, registry, now: () => 1000, random: () => 0,
    actorObject: () => store.getObject(profile.objectId), resolveObject: (ignored, local) => store.getObject(local - 100),
    nativeNoid: (ignored, id) => noid(id), ref: id => noid(id), isAdmin: () => ['admin', 'builder'].includes(store.getAvatar(1).role),
    canEnterRegion: async () => true,
    reply: async (ignored, target, id, fields) => replies.push({ target, id, fields,
      decoded: registry.decodeMessage(id, registry.encodeMessage(id, fields)) }),
    broadcastObject: async (...args) => notices.push(args),
    refreshRegion: async regionId => refreshes.push(regionId),
    teleport: async (ignored, regionId) => travel.push(regionId),
    contentsVector: async (ignored, objects) => encodeContentsVector(objects.map(object => registry.encodeObject({
      classNumber: object.classNumber, fields: { ...registry.defaults(object.classNumber), ...object.fields,
        noid: noid(object.id), container_noid: object.containerId == null ? 0 : noid(object.containerId) } }))),
  };
  const actions = new SpecialActions(context);
  const add = (classNumber, fields = {}, extra = {}) => {
    const def = registry.get(classNumber);
    const item = store.createObject({ classNumber, regionId: 1, ownerId: 1, capacity: def.capacity,
      fields: { ...registry.defaults(classNumber), name: def.name, position: [256, 220, 0], ...fields }, ...extra });
    if (Object.keys(extra).some(key => !['regionId', 'ownerId', 'capacity', 'containerId', 'portable', 'locked'].includes(key))) store.transaction(draft => Object.assign(draft.objects[item.id], extra));
    return item.id;
  };
  const cash = amount => add(26, { name: 'Tokens', denom: amount, position: [0, 0, 0] }, { containerId: profile.objectId, capacity: 0 });
  const invoke = async (id, objectId, fields = {}) => {
    const result = await actions.handle(session, { noid: noid(objectId), id, payload: registry.encodeMessage(id, fields) });
    return { handled: result, ...replies.at(-1) };
  };
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, profile, other, session, replies, notices, refreshes, travel, context, actions, add, cash, invoke, noid };
}

test('special class contracts are real recovered schemas and cannot be sent to another class', { skip: !registry }, async t => {
  const f = fixture(t);
  for (const item of SUPPORTED_REQUESTS) {
    assert.ok(registry.getMessage(item.id)); assert.ok(registry.getMessage(item.replyId));
  }
  assert.equal(SUPPORTED_REQUESTS.length, 22);
  const potion = f.add(203, { potionType: 'heal', charges: 2 });
  const before = f.store.snapshot();
  assert.equal((await f.invoke(21004, potion)).decoded.success, 2);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(await f.actions.handle(f.session, { id: 99999, noid: f.noid(potion), fields: {} }), false);
});

test('NPC dialogue is literal data and broadcasts the real NPC speech method to the caller too', { skip: !registry }, async t => {
  const f = fixture(t), npc = f.add(200, { name: 'Greeter' }, { ownerId: null,
    dialogue: { hello: 'Welcome, traveler.', default: 'A quiet day.' } });
  assert.ok(registry.methodContract(200, 74));
  const reply = await f.invoke(20010, npc, { text: 'Well, hello!' });
  assert.equal(reply.decoded.success, 0); assert.equal(reply.decoded.fail_msg, '');
  assert.equal(f.notices.at(-1)[2], 74);
  assert.equal(f.notices.at(-1)[3].speaker, f.noid(npc));
  assert.equal(f.notices.at(-1)[3].text, 'Welcome, traveler.');
  assert.equal(f.notices.at(-1)[4], undefined);
  assert.equal(f.store.getObject(npc).npcState.talks, 1);
});

test('pet adoption transfers an unowned pet into an empty hand and persists its owner', { skip: !registry }, async t => {
  const f = fixture(t), pet = f.add(201, { name: 'Dog', owner: 0 }, { ownerId: null });
  assert.equal((await f.invoke(20103, pet)).decoded.name, '');
  assert.equal((await f.invoke(20105, pet, { target: f.noid(pet), name: 'Biscuit' })).decoded.success, 0);
  assert.equal(f.store.getObject(pet).ownerId, 1);
  assert.equal(f.store.getObject(pet).containerId, f.profile.objectId);
  assert.equal(f.store.getObject(pet).fields.owner, f.profile.objectId);
  assert.equal((await f.invoke(20103, pet)).decoded.name, 'Alice');
  const restored = new WorldStore(f.directory); assert.equal(restored.getObject(pet).fields.name, 'Biscuit'); restored.close();
  const occupied = f.add(201, { name: 'Cat' }, { ownerId: null });
  const before = f.store.snapshot();
  assert.notEqual((await f.invoke(20105, occupied, { target: f.noid(occupied), name: 'Kit' })).decoded.success, 0);
  assert.deepEqual(f.store.snapshot(), before);
});

test('potion charges and repeated visual effects expire without restoring stale state', { skip: !registry }, async t => {
  const f = fixture(t), potion = f.add(203, { potionType: 'invisibility', potionDuration: 2, charges: 2 });
  assert.equal((await f.invoke(20302, potion)).decoded.success, 0);
  const first = f.store.getAvatar(1).effects.invisibility;
  assert.equal(f.store.getObject(f.profile.objectId).fields.common_flags & 1, 1);
  assert.equal((await f.invoke(20302, potion)).decoded.success, 0);
  const second = f.store.getAvatar(1).effects.invisibility;
  f.store.transaction(draft => {
    applySpecialTimer(draft, draft.timers[first.id]); delete draft.timers[first.id];
    assert.equal(draft.objects[f.profile.objectId].fields.common_flags & 1, 1);
    draft.objects[f.profile.objectId].fields.common_flags |= 16;
    applySpecialTimer(draft, draft.timers[second.id]); delete draft.timers[second.id];
  });
  assert.equal(f.store.getObject(f.profile.objectId).fields.common_flags, 16);
  assert.equal(f.store.getAvatar(1).effects.invisibility, undefined);
  assert.equal(f.store.getObject(potion).fields.charges, 0);
  const before = f.store.snapshot(); assert.equal((await f.invoke(20302, potion)).decoded.success, 5);
  assert.deepEqual(f.store.snapshot(), before);
  const heal = f.add(203, { potionType: 'heal', charges: 1 }); await f.invoke(20302, heal);
  assert.equal(f.store.getObject(f.profile.objectId).fields.health, 255);
});

test('bus route editing requires owner authority and broadcasts bounded identifiers', { skip: !registry }, async t => {
  const f = fixture(t), bus = f.add(204, { routeNumbers: '' });
  assert.equal((await f.invoke(20404, bus, { newRoutes: '1 20 300' })).decoded.success, 0);
  assert.equal(f.store.getObject(bus).fields.routeNumbers, '1 20 300');
  assert.equal(f.notices.at(-1)[2], 20405);
  const before = f.store.snapshot();
  assert.notEqual((await f.invoke(20404, bus, { newRoutes: '1 1' })).decoded.success, 0);
  assert.deepEqual(f.store.snapshot(), before);
  f.store.transaction(draft => { draft.objects[bus].ownerId = 2; });
  assert.equal((await f.invoke(20404, bus, { newRoutes: '1' })).decoded.success, 16);
});

test('cashier bills only explicit pending purchases and payment is exact and replay safe', { skip: !registry }, async t => {
  const f = fixture(t), cashier = f.add(205);
  const owned = f.add(27, { salePrice: 99 }, { containerId: f.profile.objectId });
  f.store.transaction(draft => { draft.objects[owned].slot = 2; draft.objects[owned].fields.position = [2, 0, 0]; });
  const merchandise = f.add(27, { name: 'Gift {box}', salePrice: 7, position: [3, 0, 0] }, { containerId: f.profile.objectId,
    pendingSale: { cashierId: cashier, buyerId: 1, price: 7, sellerId: 2, paid: false } });
  const bill = await f.invoke(20502, cashier); assert.equal(bill.decoded.total, 7); assert.match(bill.decoded.itemlist, /Gift/);
  f.cash(8); const before = f.store.snapshot();
  assert.equal((await f.invoke(20504, cashier)).decoded.success, 6); assert.deepEqual(f.store.snapshot(), before);
  f.store.transaction(draft => { Object.values(draft.objects).find(object => object.classNumber === 26 && object.containerId === f.profile.objectId).fields.denom = 7; });
  assert.equal((await f.invoke(20504, cashier)).decoded.success, 0);
  assert.equal(f.store.getObject(cashier).cashReserve, 7); assert.equal(f.store.getObject(merchandise).pendingSale.paid, true);
  assert.equal((await f.invoke(20502, cashier)).decoded.total, 0);
  assert.equal((await f.invoke(20504, cashier)).decoded.success, 0);
  assert.equal(f.store.getObject(cashier).cashReserve, 7);
});

test('portkeys validate destination permission before charging, and last charge stays exhausted', { skip: !registry }, async t => {
  const f = fixture(t), key = f.add(209, { destination: 'Garden', areaCode: 0, isGroup: 0, charges: 1, rideCost: 5 });
  f.cash(5); f.context.canEnterRegion = () => false;
  const before = f.store.snapshot();
  assert.equal((await f.invoke(20907, key)).decoded.success, 16); assert.deepEqual(f.store.snapshot(), before);
  f.context.canEnterRegion = () => true;
  assert.equal((await f.invoke(20907, key)).decoded.success, 0);
  assert.equal(f.travel.at(-1), 2); assert.equal(f.store.getObject(key).cashReserve, 5);
  assert.equal(f.store.getObject(key).fields.charges, 0); assert.equal(f.store.getObject(key).portkeyExhausted, true);
  const exhausted = f.store.snapshot();
  assert.equal((await f.invoke(20907, key)).decoded.success, 5); assert.deepEqual(f.store.snapshot(), exhausted);
  f.store.transaction(draft => { draft.objects[key].ownerId = 2; });
  assert.equal((await f.invoke(20906, key, { destination: 'Library', areaCode: 0, isgroup: 0, menuEntry: 'Ride', charges: 1, rideCost: 0 })).decoded.success, 16);
});

test('surveyed portkeys use the recorded destination and explicit fare without rewriting source fields', async t => {
  const f = fixture(t), key = f.add(209, { destination: '', charges: 0, rideCost: 65535 },
    { properties: { surveyTravel: { version: 1, destinationRegionId: 3, destinations: {}, cost: 0 } } });
  f.context.canEnterRegion = () => false;
  const before = f.store.snapshot();
  assert.equal((await f.invoke(20907, key)).decoded.success, 16);
  assert.deepEqual(f.store.snapshot(), before);
  f.context.canEnterRegion = () => true;
  assert.equal((await f.invoke(20907, key)).decoded.success, 0);
  assert.deepEqual(f.travel, [3]);
  assert.equal(f.store.getObject(key).fields.destination, '');
  assert.equal(f.store.getObject(key).fields.rideCost, 65535);
  assert.deepEqual(f.store.snapshot().ledger, before.ledger);
});

test('unresolved surveyed portkeys reject authored destination fallback without consuming charges', async t => {
  const f = fixture(t), key = f.add(209, { destination: 'Garden', charges: 2, rideCost: 0 },
    { properties: { surveyTravel: { version: 1, destinations: {}, cost: 0 } } });
  const before = f.store.snapshot();
  assert.equal((await f.invoke(20907, key)).decoded.success, 3);
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(f.travel, []);
});

test('legacy nullish admission callbacks keep portkey travel compatible without consuming failed charges', { skip: !registry }, async t => {
  const f = fixture(t), key = f.add(209, { destination: '2', areaCode: 0, isGroup: 0, charges: 3 });
  for (const permission of [null, undefined]) {
    f.context.canEnterRegion = async () => permission;
    assert.equal((await f.invoke(20907, key)).decoded.success, 0);
  }
  assert.deepEqual(f.travel, [2, 2]);
  assert.equal(f.store.getObject(key).fields.charges, 1);
  f.context.canEnterRegion = async () => ({ allowed: false });
  const before = f.store.snapshot();
  assert.equal((await f.invoke(20907, key)).decoded.success, 16);
  assert.deepEqual(f.store.snapshot(), before);
});

test('paid portkey movement commits with charges and inventory before acknowledgement, and failed rename rolls all back', { skip: !registry }, async t => {
  const f = fixture(t), key = f.add(209, { destination: 'Garden', areaCode: 0, isGroup: 0, charges: 2, rideCost: 5 });
  const cash = f.cash(5);
  const bag = f.add(36, { name: 'Carried bag', position: [2, 0, 0] }, { containerId: f.profile.objectId });
  const item = f.add(27, { name: 'Bag item', position: [0, 0, 0] }, { containerId: bag });
  f.session.regionId = 1;
  const events = [];
  f.context.moveActorInDraft = (draft, session, regionId) => {
    events.push('draft movement');
    const profile = draft.avatars[session.avatar.id], actor = draft.objects[profile.objectId];
    const oldRegion = profile.regionId;
    profile.regionId = regionId; profile.position = [256, 220, 0];
    actor.regionId = regionId; actor.fields.position = [256, 220, 0];
    const carry = parentId => {
      for (const object of Object.values(draft.objects).filter(object => object.containerId === parentId)) {
        object.regionId = regionId; carry(object.id);
      }
    };
    carry(actor.id);
    return { oldRegion, regionId };
  };
  f.context.publishTravel = async (session, transition) => {
    events.push('publish');
    assert.equal(f.store.getAvatar(1).regionId, 2);
    assert.equal(f.store.getObject(key).fields.charges, 1);
    assert.equal(f.store.getObject(key).cashReserve, 5);
    assert.equal(f.store.getObject(item).regionId, 2);
    session.regionId = transition.regionId;
  };
  const oldReply = f.context.reply;
  f.context.reply = async (...args) => {
    events.push('reply');
    assert.equal(f.store.getAvatar(1).regionId, 2);
    assert.equal(f.store.getObject(bag).regionId, 2);
    assert.equal(f.store.getObject(cash), null);
    assert.equal(f.store.getObject(key).fields.charges, 1);
    await oldReply(...args);
  };
  const before = f.store.snapshot(), disk = fs.readFileSync(path.join(f.directory, 'world.json'));
  t.mock.method(fs, 'renameSync', () => { const error = new Error('injected world rename failure'); error.code = 'EACCES'; throw error; });
  await assert.rejects(f.invoke(20907, key), /injected world rename failure/);
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'world.json')), disk);
  assert.equal(f.replies.length, 0);
  assert.equal(f.session.regionId, 1);
  assert.deepEqual(events, ['draft movement']);
  t.mock.restoreAll(); events.length = 0;
  assert.equal((await f.invoke(20907, key)).decoded.success, 0);
  assert.deepEqual(events, ['draft movement', 'reply', 'publish']);
  assert.equal(f.session.regionId, 2);
  const restarted = new WorldStore(f.directory);
  assert.equal(restarted.getAvatar(1).regionId, 2);
  assert.equal(restarted.getObject(item).regionId, 2);
  assert.equal(restarted.getObject(key).cashReserve, 5);
  assert.equal(restarted.getObject(key).fields.charges, 1);
  restarted.close();
});

test('slot outcomes and funded token rewards persist without creating currency', { skip: !registry }, async t => {
  const f = fixture(t), machine = f.add(210, { salePrice: 2, reel1sequence: '7', reel2sequence: '7', reel3sequence: '7', rewardmatrix: '5>777', reducedCapacity: 10 }, { cashReserve: 3 });
  for (let index = 0; index < 3; index++) f.add(25, { position: [index, 0, 0] }, { containerId: machine });
  f.cash(2);
  const reply = await f.invoke(21004, machine);
  assert.equal(reply.decoded.success, 0); assert.equal(reply.decoded.results, '7 7 7'); assert.ok(reply.decoded.cvsize > 4);
  const cash = f.store.listObjects({ containerId: f.profile.objectId }).find(object => object.classNumber === 26);
  assert.equal(cash.fields.denom, 5); assert.equal(f.store.getObject(machine).cashReserve, 0);
  assert.equal(f.store.getObject(machine).machineState.plays, 1);
  const restored = new WorldStore(f.directory); assert.equal(restored.getObject(machine).machineState.totalPaid, 5); restored.close();
  f.store.transaction(draft => { draft.objects[cash.id].fields.denom = 2; });
  const before = f.store.snapshot(); assert.equal((await f.invoke(21004, machine)).decoded.success, 6);
  assert.deepEqual(f.store.snapshot(), before);
});

test('spinner prizes are transferred, not cloned, and stocking is owner-only', { skip: !registry }, async t => {
  const f = fixture(t), machine = f.add(213, { salePrice: 0, maxResult: 1, reducedCapacity: 10 });
  const gift = f.add(27, { name: 'Prize', position: [0, 0, 0] }, { containerId: machine, portable: false });
  const count = Object.keys(f.store.snapshot().objects).length;
  const reply = await f.invoke(21304, machine); assert.equal(reply.decoded.success, 0); assert.equal(reply.decoded.result, 1);
  assert.equal(f.store.getObject(gift).containerId, f.profile.objectId); assert.equal(Object.keys(f.store.snapshot().objects).length, count);
  assert.equal((await f.invoke(21312, machine, { slot: 3 })).decoded.success, 0);
  assert.equal(f.store.getObject(gift).containerId, machine); assert.equal(f.store.getObject(gift).slot, 3);
  assert.equal((await f.invoke(21310, machine, { slot: 3 })).decoded.success, 0);
  f.store.transaction(draft => { draft.objects[machine].ownerId = 2; });
  const before = f.store.snapshot(); assert.equal((await f.invoke(21312, machine, { slot: 3 })).decoded.success, 16); assert.deepEqual(f.store.snapshot(), before);
});

test('machine configuration validates digits, rewards and ownership before committing', { skip: !registry }, async t => {
  const f = fixture(t), machine = f.add(210);
  assert.equal((await f.invoke(21009, machine, { menuEntry: 'Play', stake: 2, reel1sequence: '7770', reel2sequence: '77', reel3sequence: '777', rewardmatrix: '4>777|#3>000' })).decoded.success, 0);
  assert.equal((await f.invoke(21006, machine)).decoded.reel1sequence, '7770');
  const before = f.store.snapshot();
  assert.notEqual((await f.invoke(21009, machine, { menuEntry: 'Play', stake: 2, reel1sequence: 'eval', reel2sequence: '7', reel3sequence: '7', rewardmatrix: '' })).decoded.success, 0);
  assert.deepEqual(f.store.snapshot(), before);
});

test('decorator state and original coordinates persist with owner-only reveal lists', { skip: !registry }, async t => {
  const f = fixture(t), tool = f.add(215, { charges: 1 }), item = f.add(27, { name: 'Odd {name}', position: [120, 210, 0] });
  const hidden = await f.invoke(21503, tool, { target: f.noid(item), state: 1 }); assert.equal(hidden.decoded.success, 0);
  assert.deepEqual(hidden.decoded.position, [120, 210, 0]);
  assert.deepEqual(f.store.getObject(item).fields.position, [-500, 0, 0]); assert.equal(f.store.getObject(item).fields.common_flags & 1, 1);
  const list = await f.invoke(21505, tool); assert.match(list.decoded.hiddenObjects, /Odd/);
  assert.equal((await f.invoke(21503, tool, { target: f.noid(item), state: 0 })).decoded.success, 0);
  assert.deepEqual(f.store.getObject(item).fields.position, [120, 210, 0]);
  const before = f.store.snapshot(); assert.equal((await f.invoke(21503, tool, { target: f.noid(item), state: 1 })).decoded.success, 5); assert.deepEqual(f.store.snapshot(), before);
  const privateItem = f.add(27, { name: 'Private' }, { ownerId: 2 });
  assert.equal((await f.invoke(21503, tool, { target: f.noid(privateItem), state: 1 })).decoded.success, 16);
});

test('NPC declarative quests exchange finite stock atomically and persist one-time player state', { skip: !registry }, async t => {
  const f = fixture(t);
  const npc = f.add(200, { name: 'Gardener' }, { ownerId: null, dialogue: {
    default: 'I have no more errands today.',
    rules: [{ id: 'flower-trade', match: 'flowers', mode: 'equals', once: true,
      response: 'Thank you, {avatar}. {npc} has a gift for you.',
      actions: [{ type: 'takeItem', name: 'Garden flower' }, { type: 'giveItem', slot: 1 }, { type: 'setState', key: 'helped', value: true }] }],
  } });
  const flower = f.add(27, { name: 'Garden flower', position: [0, 0, 0] }, { containerId: f.profile.objectId });
  const gift = f.add(36, { name: 'Gift bag', position: [1, 0, 0] }, { ownerId: null, containerId: npc });
  const nested = f.add(27, { name: 'Keepsake', position: [0, 0, 0] }, { ownerId: null, containerId: gift });
  assert.equal((await f.invoke(20010, npc, { text: 'flowers' })).decoded.success, 0);
  assert.equal(f.store.getObject(flower).containerId, npc);
  assert.equal(f.store.getObject(flower).ownerId, null);
  assert.equal(f.store.getObject(gift).containerId, f.profile.objectId);
  assert.equal(f.store.getObject(nested).ownerId, 1);
  assert.match(f.notices.at(-1)[3].text, /Thank you, Alice. Gardener/);
  const saved = f.store.getObject(npc).npcState.playerStates[1];
  assert.equal(saved.helped, true); assert.equal(saved['done:flower-trade'], true);
  assert.equal((await f.invoke(20010, npc, { text: 'flowers' })).decoded.success, 0);
  assert.equal(f.notices.at(-1)[3].text, 'I have no more errands today.');
  const restored = new WorldStore(f.directory); assert.equal(restored.getObject(npc).npcState.playerStates[1].helped, true); restored.close();
});

test('NPC token rewards require funded reserves and failed dialogue programs roll back every effect', { skip: !registry }, async t => {
  const f = fixture(t), npc = f.add(200, { name: 'Reward keeper' }, { ownerId: null, cashReserve: 10,
    dialogue: { rules: [{ match: 'reward', response: 'A reward.', actions: [{ type: 'rewardTokens', amount: 7 }] },
      { match: 'invalid', response: 'Should fail.', actions: [{ type: 'setState', key: 'partial', value: true }, { type: 'execute', source: 'process.exit()' }] }] } });
  assert.equal((await f.invoke(20010, npc, { text: 'reward' })).decoded.success, 0);
  assert.equal(f.store.getObject(npc).cashReserve, 3);
  const cash = Object.values(f.store.snapshot().objects).find(item => item.classNumber === 26 && item.containerId === f.profile.objectId);
  assert.equal(cash.fields.denom, 7);
  const before = f.store.snapshot();
  assert.equal((await f.invoke(20010, npc, { text: 'reward' })).decoded.success, 6);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal((await f.invoke(20010, npc, { text: 'invalid' })).decoded.success, 2);
  assert.deepEqual(f.store.snapshot(), before);
});
