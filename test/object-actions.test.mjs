import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorldStore } from '../dist/src/world-store.js';
import { ActionError, applyObjectAction, ObjectActions, OBJECT_REQUESTS, replyIdForObjectRequest } from '../dist/src/object-actions.js';
import { ResourceStore } from './helpers/fixtures.mjs';
import { ClassRegistry } from '../dist/src/classes.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-object-actions-'));
  let store = new WorldStore(directory, { clock: () => 1000 });
  const alice = store.ensureAvatar({ id: 1, accountId: 1, name: 'Alice' }, { classNumber: 21 });
  const bob = store.ensureAvatar({ id: 2, accountId: 2, name: 'Bob' }, { classNumber: 21 });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, alice, bob, actor: alice.objectId,
    object(classNumber, fields = {}, more = {}) { return store.createObject({ classNumber, ownerId: 1, regionId: 1, fields: { name: 'Object', position: [100, 200, 0], ...fields }, ...more }); },
    act(id, objectId, fields = {}, refs = {}, extra = {}) {
      return store.transaction(draft => applyObjectAction(draft, { id, objectId, actorId: alice.objectId, avatarId: 1,
        avatarName: 'Alice', now: 1000, fields, refs, ...extra }));
    },
    restart() { store.close(); store = new WorldStore(directory); },
  };
}
const held = (f, classNumber, fields = {}, more = {}) => f.object(classNumber, { position: [0, 0, 0], ...fields }, { containerId: f.actor, ...more });
const passageWithProperties = (f, classNumber, fields, properties) => {
  const passage = f.object(classNumber, fields, { portable: false });
  f.store.transaction(draft => { draft.objects[passage.id].properties = properties; });
  return passage;
};
const totalMoney = f => Object.values(f.store.snapshot().avatars).reduce((n, a) => n + a.balance, 0)
  + Object.values(f.store.snapshot().objects).filter(o => o.classNumber === 26).reduce((n, o) => n + o.fields.denom, 0);

test('declared physical request and reply contracts exist in the recovered message inventory', t => {
  const registry = new ClassRegistry(new ResourceStore({ clientDir: new URL('../../wa', import.meta.url).pathname }));
  assert.equal(new Set(OBJECT_REQUESTS.map(r => r.id)).size, OBJECT_REQUESTS.length);
  for (const contract of OBJECT_REQUESTS) {
    assert.ok(registry.getMessage(contract.id), `Request ${contract.id} is recovered`);
    for (const replyId of new Set([contract.replyId, ...Object.values(contract.replyByClass)]))
      assert.ok(registry.getMessage(replyId), `Reply ${replyId} is recovered`);
  }
});

test('pickup, pocket, unpocket and drop persist ownership and exact container slots', t => {
  const f = fixture(t); const item = f.object(48, { name: 'Keepsake' }, { ownerId: null });
  assert.equal(f.act(1575, f.actor, {}, { item: item.id }).reply.success, 0);
  assert.equal(f.store.getObject(item.id).containerId, f.actor);
  assert.equal(f.store.getObject(item.id).ownerId, 1);
  const pocket = f.act(89, item.id); assert.equal(pocket.replyId, 90); assert.equal(pocket.reply.slot, 4);
  assert.equal(f.store.getObject(item.id).fields.position[0], 4);
  f.act(97, item.id); assert.equal(f.store.getObject(item.id).fields.position[0], 0);
  const dropped = f.act(1580, f.actor); assert.deepEqual(dropped.reply.at, [256, 220, 0]);
  f.restart(); assert.equal(f.store.getObject(item.id).containerId, null);
  assert.deepEqual(f.store.getObject(item.id).fields.position, [256, 220, 0]);
});

test('container cycles, private inventories and forged public locking are rejected atomically', t => {
  const f = fixture(t); const bag = held(f, 36, { common_flags: 8 }, { capacity: 10 });
  const other = f.object(36, {}, { capacity: 10, containerId: bag.id });
  const before = f.store.snapshot().revision;
  assert.throws(() => f.act(85, bag.id, { in_pocket: 0 }, { container: other.id }), ActionError);
  assert.equal(f.store.snapshot().revision, before);
  const foreign = f.object(48, {}, { ownerId: 2, containerId: f.bob.objectId });
  assert.throws(() => f.act(1575, f.actor, {}, { item: foreign.id }), /private/);
  const chest = f.store.listObjects({ classNumber: 36 }).find(o => o.ownerId === null);
  assert.throws(() => f.act(300, chest.id, { state: 16, keycode: 0 }), /key|combination/);
  f.act(300, chest.id, { state: 8, keycode: 0 }); assert.equal(f.store.getObject(chest.id).fields.common_flags & 8, 8);
});

test('cash withdrawals, deposits and pocket splitting conserve tokens and bank balances', t => {
  const f = fixture(t), atm = f.object(33, {}, { ownerId: null, portable: false });
  const before = totalMoney(f);
  const withdrawal = f.act(2810, atm.id, { amount: 100 });
  assert.equal(withdrawal.reply.balance, 900); assert.equal(withdrawal.cvObjectIds.length, 1);
  assert.equal(totalMoney(f), before);
  const cashId = withdrawal.cvObjectIds[0];
  f.act(2806, atm.id, { amount: 40 }); assert.equal(f.store.getAvatar(1).balance, 940);
  assert.equal(f.store.getObject(cashId).fields.denom, 60); assert.equal(totalMoney(f), before);
  f.act(89, cashId); assert.equal(f.store.getObject(cashId).fields.position[0], 2);
  const split = f.act(1139, cashId, { amount: 20 }); assert.equal(split.cvObjectIds.length, 1);
  assert.equal(f.store.getObject(cashId).fields.denom, 40); assert.equal(totalMoney(f), before);
  const revision = f.store.snapshot().revision;
  assert.throws(() => f.act(2810, atm.id, { amount: -1 }), ActionError);
  assert.throws(() => f.act(2810, atm.id, { amount: 2000 }), /Insufficient/);
  assert.equal(f.store.snapshot().revision, revision);
  f.restart(); assert.equal(totalMoney(f), before);
});

test('head and clothing slot swaps retain object identity and ownership', t => {
  const f = fixture(t); const head = held(f, 24, {}, { capacity: 3 });
  f.act(3601, head.id); assert.equal(f.store.getObject(head.id).fields.position[0], 1);
  const clothes = held(f, 206);
  f.act(20602, clothes.id, { clothingChore: 2 });
  assert.equal(f.store.getObject(clothes.id).fields.position[0], 3);
  assert.equal(f.store.getObject(clothes.id).fields.choreState, 2);
  f.act(20605, clothes.id); assert.equal(f.store.getObject(clothes.id).fields.position[0], 0);
  f.act(89, clothes.id); f.act(3605, head.id);
  assert.equal(f.store.getObject(head.id).fields.position[0], 0);
});

test('document text, metadata, page counts and binder membership survive restart', t => {
  const f = fixture(t), book = held(f, 37, { blank_page_count: 3, blank_page_max: 20 });
  f.act(2712, book.id, { subject: 'Notebook', max_size_allowed: 32000, days_to_live: 0 });
  f.act(2771, book.id, { page: 0, text: 'Durable text' });
  assert.equal(f.act(2781, book.id, { page: 0 }).reply.text, 'Durable text');
  assert.equal(f.store.getObject(book.id).fields.blank_page_count, 2);
  const binder = f.object(37, { documentFlags: 2, blank_page_count: 0, blank_page_max: 50 });
  f.act(2743, binder.id, { keepblank: 1 }, { src: book.id });
  assert.equal(f.store.getObject(book.id).archivedIn, binder.id);
  assert.equal(f.store.getObject(book.id).containerId, null);
  const contents = f.act(2735, binder.id).reply.contents; assert.match(contents, /^\{\{Notebook\} \d+\}$/);
  f.act(2747, binder.id, { entry: 0 }); assert.equal(f.store.getObject(book.id).containerId, f.actor);
  f.restart(); assert.equal(f.act(2781, book.id, { page: 0 }).reply.text, 'Durable text');
  assert.equal(f.store.getObject(book.id).archivedIn, undefined);
});

test('vendroid exact payment transfers an existing item and credits its owner once', t => {
  const f = fixture(t), machine = f.object(57, {}, { ownerId: 2, capacity: 10, portable: false });
  const prize = f.object(48, { salePrice: 25, common_flags: 2, position: [0, 0, 0] }, { ownerId: 2, containerId: machine.id });
  held(f, 26, { denom: 25 }); const before = totalMoney(f);
  const bought = f.act(2675, machine.id, { slot: 0 }); assert.deepEqual(bought.cvObjectIds, [prize.id]);
  assert.equal(f.store.getObject(prize.id).ownerId, 1); assert.equal(f.store.getAvatar(2).balance, 1025);
  assert.equal(totalMoney(f), before);
  assert.throws(() => f.act(2675, machine.id, { slot: 0 }), /Sold out/);
  assert.equal(f.store.getAvatar(2).balance, 1025);
});

test('vendroid browse swaps the native display so slot-zero purchases use the shown item and price', t => {
  const f = fixture(t), machine = f.object(57, { currentSlot: 1 }, { ownerId: 2, capacity: 10, portable: false });
  const teddy = f.object(27, { name: 'Teddy', salePrice: 0, position: [0, 0, 0] }, { ownerId: 2, containerId: machine.id });
  const cocoa = f.object(27, { name: 'Cocoa', salePrice: 5, common_flags: 2, position: [2, 0, 0] }, { ownerId: 2, containerId: machine.id });
  const roses = f.object(27, { name: 'Roses', salePrice: 10, common_flags: 2, position: [3, 0, 0] }, { ownerId: 2, containerId: machine.id });
  const first = f.act(2671, machine.id, { forward: 1 });
  assert.deepEqual(first.reply, { success: 0, next_slot: 2, available: 3 });
  assert.equal(first.notices[0].id, 2673); assert.equal(first.notices[0].fields.next_slot, 2);
  assert.equal(f.store.getObject(cocoa.id).fields.position[0], 0);
  assert.equal(f.store.getObject(teddy.id).fields.position[0], 1);
  assert.equal(f.store.getObject(machine.id).fields.currentSlot, 2);
  f.act(2671, machine.id, { forward: 1 });
  assert.equal(f.store.getObject(roses.id).fields.position[0], 0);
  assert.equal(f.store.getObject(machine.id).fields.price, 10);
  held(f, 26, { denom: 5 }); const before = f.store.snapshot();
  assert.throws(() => f.act(2675, machine.id, { slot: 0 }), /exact price/);
  assert.deepEqual(f.store.snapshot(), before, 'five tokens cannot purchase the displayed ten-token item');
  f.act(2671, machine.id, { forward: 0 });
  assert.equal(f.store.getObject(cocoa.id).fields.position[0], 0);
  assert.equal(f.store.getObject(machine.id).fields.price, 5);
  const moneyBefore = totalMoney(f), bought = f.act(2675, machine.id, { slot: 0 });
  assert.deepEqual(bought.cvObjectIds, [cocoa.id]); assert.equal(f.store.getObject(cocoa.id).ownerId, 1);
  assert.equal(f.store.getObject(cocoa.id).fields.common_flags & 2, 0, 'purchased stock is portable');
  assert.equal(f.store.getObject(machine.id).fields.price, 0);
  assert.equal(f.store.getObject(teddy.id).fields.position[0], 0);
  assert.equal(f.store.getObject(machine.id).fields.currentSlot, 1);
  assert.equal(f.store.getAvatar(2).balance, 1005); assert.equal(totalMoney(f), moneyBefore);
  f.act(1580, f.actor); f.act(1575, f.actor, {}, { item: cocoa.id }); f.act(89, cocoa.id);
  f.restart(); assert.equal(f.store.getObject(cocoa.id).ownerId, 1);
  f.act(2671, machine.id, { forward: 0 });
  assert.equal(f.store.getObject(roses.id).fields.position[0], 0, 'backward browsing wraps around the remaining logical slots');
  const gridPurchase = f.act(2675, machine.id, { slot: 1 });
  assert.deepEqual(gridPurchase.cvObjectIds, [teddy.id], 'the recovered virtual-grid menu can buy a nonzero storage slot');
  assert.equal(f.store.getObject(roses.id).fields.position[0], 0);
  assert.equal(f.store.getObject(machine.id).fields.currentSlot, 3);
});

test('vendroid stocking and unloading preserve a reserved storage home for the displayed item', t => {
  const f = fixture(t), machine = f.object(57, { currentSlot: 1 }, { capacity: 4, portable: false });
  const first = f.object(27, { salePrice: 2, position: [0, 0, 0] }, { containerId: machine.id });
  const second = held(f, 27); const stocked = f.act(2678, machine.id, { newPrice: 7 });
  assert.equal(stocked.reply.next_slot, 2); assert.equal(stocked.notices[0].id, 2680);
  assert.equal(f.store.getObject(first.id).fields.position[0], 1);
  assert.equal(f.store.getObject(second.id).fields.position[0], 0);
  assert.equal(f.store.getObject(machine.id).fields.currentSlot, 2);
  const third = held(f, 27); f.act(2678, machine.id, { newPrice: 9 });
  const excess = held(f, 27), before = f.store.snapshot();
  assert.throws(() => f.act(2678, machine.id, { newPrice: 11 }), /full/);
  assert.deepEqual(f.store.snapshot(), before, 'display slot does not increase native stock capacity');
  f.act(89, excess.id); const unloaded = f.act(2682, machine.id);
  assert.equal(f.store.getObject(third.id).containerId, f.actor);
  assert.equal(f.store.getObject(third.id).fields.common_flags & 2, 0);
  assert.deepEqual(unloaded.reply, { success: 0, next_slot: 1, available: 2 });
  assert.equal(unloaded.notices[0].id, 2684);
  assert.equal(f.store.getObject(first.id).fields.position[0], 0);
  assert.equal(f.store.getObject(second.id).fields.position[0], 2);
  assert.equal(f.store.getObject(machine.id).fields.currentSlot, 1);
});

test('giving transfers ownership, while private inventory paths cannot inspect another avatar', t => {
  const f = fixture(t), item = held(f, 48, { name: 'Gift' });
  const result = f.act(1605, f.bob.objectId);
  assert.equal(result.replyId, 1609); assert.equal(f.store.getObject(item.id).ownerId, 2);
  assert.equal(f.store.getObject(item.id).containerId, f.bob.objectId);
  assert.throws(() => f.act(1711, f.bob.objectId), /private/);
  const own = f.object(48, { name: 'Pocket keepsake', position: [4, 0, 0] }, { containerId: f.actor });
  assert.match(f.act(1711, f.actor).reply.contentsData, /Pocket keepsake/);
  const fetched = f.act(1714, f.actor, { contentsPath: '4' });
  assert.equal(fetched.reply.item.$objectRef, own.id); assert.equal(f.store.getObject(own.id).fields.position[0], 0);
});

test('configured teleport checks admission before spending money', t => {
  const f = fixture(t), teleport = f.object(56, { rideCost: 10 }, { portable: false }); held(f, 26, { denom: 10 });
  const before = f.store.snapshot().revision;
  assert.throws(() => f.act(1202, teleport.id, { address: 'Garden' }, {}, { canEnterRegion: () => false }), /cannot enter/);
  assert.equal(f.store.snapshot().revision, before);
  const permitted = f.act(1202, teleport.id, { address: 'Garden' }, {}, { canEnterRegion: () => true });
  assert.equal(permitted.teleportRegionId, 2);
});

test('surveyed teleport and elevator addresses resolve only their recorded destinations', t => {
  const f = fixture(t);
  for (const [classNumber, requestId] of [[56, 1202], [39, 4102]]) {
    const passage = passageWithProperties(f, classNumber, { rideCost: 0 },
      { destinationRegionId: 2, surveyTravel: { version: 1, destinations: { 'Original address': 3, home: 2 }, cost: 0 } });
    assert.equal(f.act(requestId, passage.id, { address: 'Original address', home: 0 }).teleportRegionId, 3);
    if (classNumber === 39) assert.equal(f.act(requestId, passage.id, { address: '', home: 1 }).teleportRegionId, 2);
    const before = f.store.snapshot();
    assert.throws(() => f.act(requestId, passage.id, { address: 'Garden', home: 0 }), /not recorded/);
    assert.deepEqual(f.store.snapshot(), before, 'an existing room name must not bypass the recorded passage map');
  }
});

test('surveyed free native fare preserves the original wire value and spends no funds', t => {
  const f = fixture(t), passage = passageWithProperties(f, 56, { rideCost: 65535 },
    { surveyTravel: { version: 1, destinations: { Island: 2 }, cost: 0 } });
  const before = f.store.snapshot();
  assert.equal(f.act(1202, passage.id, { address: 'Island' }).teleportRegionId, 2);
  assert.equal(f.store.getObject(passage.id).fields.rideCost, 65535);
  assert.deepEqual(f.store.snapshot().ledger, before.ledger);
  assert.deepEqual(f.store.snapshot().avatars, before.avatars);
});

test('surveyed travel checks admission before charging its explicit operational fare', t => {
  const f = fixture(t), cash = held(f, 26, { denom: 10 });
  const passage = passageWithProperties(f, 56, { rideCost: 65535 },
    { surveyTravel: { version: 1, destinations: { Island: 2 }, cost: 5 } });
  const before = f.store.snapshot();
  assert.throws(() => f.act(1202, passage.id, { address: 'Island' }, {}, { canEnterRegion: () => false }), /cannot enter/);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.act(1202, passage.id, { address: 'Island' }).teleportRegionId, 2);
  assert.equal(f.store.getObject(cash.id).fields.denom, 5);
  assert.equal(f.store.getObject(passage.id).fields.rideCost, 65535);
  assert.equal(f.store.snapshot().ledger.at(-1).amount, -5);
});

test('surveyed doors deny unresolved destinations while authored passage behavior stays unchanged', t => {
  const f = fixture(t), surveyed = passageWithProperties(f, 38, {},
    { destinationRegionId: 2, surveyTravel: { version: 1, destinations: {} } });
  assert.throws(() => f.act(2351, surveyed.id), /not recorded/);
  f.store.transaction(draft => { draft.objects[surveyed.id].properties.surveyTravel.destinationRegionId = 3; });
  assert.equal(f.act(2351, surveyed.id).teleportRegionId, 3);
  const authoredLift = passageWithProperties(f, 39, {}, { destinationRegionId: 2 });
  assert.equal(f.act(4102, authoredLift.id, { address: 'Unconfigured address' }).teleportRegionId, 2);
  const authoredTeleport = f.object(56, { rideCost: 65535 }, { portable: false });
  const cash = held(f, 26, { denom: 65535 });
  assert.equal(f.act(1202, authoredTeleport.id, { address: 'Garden' }).teleportRegionId, 2);
  assert.equal(f.store.getObject(cash.id), null, 'authored native values retain their existing literal fare semantics');
});

test('postal parcels persist separately from their label and can only be received once', t => {
  const f = fixture(t), postbox = f.store.listObjects({ classNumber: 50 })[0];
  const parcel = held(f, 48, { name: 'Parcel' }); f.object(26, { denom: 5, position: [2, 0, 0] }, { containerId: f.actor });
  f.act(4453, postbox.id, { address: 'Bob', contents: 'For you', postage: 5 });
  assert.equal(f.store.getObject(parcel.id).ownerId, 2);
  assert.equal(f.store.getAvatar(2).mailbox.length, 1);
  assert.throws(() => f.act(4457, postbox.id), /no parcel/);
  const received = f.store.transaction(draft => applyObjectAction(draft, { id: 4457, objectId: postbox.id, actorId: f.bob.objectId,
    avatarId: 2, avatarName: 'Bob', fields: {}, now: 2000 }));
  assert.equal(received.reply.contents, 'For you'); assert.deepEqual(received.cvObjectIds, [parcel.id]);
  assert.equal(f.store.getObject(parcel.id).containerId, f.bob.objectId);
  f.store.transaction(draft => { draft.objects[parcel.id].containerId = null; draft.objects[parcel.id].fields.position = [100, 200, 0]; });
  assert.throws(() => f.store.transaction(draft => applyObjectAction(draft, { id: 4457, objectId: postbox.id,
    actorId: f.bob.objectId, avatarId: 2, fields: {}, now: 3000 })), /no parcel/);
});

test('adapter enforces fresh staff authority over a stale admin session', async t => {
  const f = fixture(t), amulet = f.object(32), replies = [];
  const context = { worldStore: f.store, isAdmin: () => false, actorObject: () => f.store.getObject(f.actor),
    resolveObject: (_session, noid) => f.store.getObject(noid), reply: async (...args) => replies.push(args),
    registry: {}, ref: id => ({ ref: id }), sessions: [] };
  const session = { avatar: { id: 1, name: 'Alice' }, profile: { role: 'admin' } };
  assert.equal(await new ObjectActions(context).handle(session, { noid: amulet.id, id: 3114, fields: { avatar_name: 'Bob', days: 1 } }), true);
  assert.equal(replies[0][3].success, 16); assert.equal(f.store.getAvatar(2).preferences.bannedUntil, undefined);
});

test('staff account bans cover future avatar creation and persist their expiry', t => {
  const f = fixture(t), amulet = f.object(32);
  f.act(3116, amulet.id, { user: 'bob', days: 2 }, {}, { admin: true, targetAccountId: 2 });
  assert.equal(f.store.snapshot().accountBans[2].until, 1000 + 2 * 86400000);
  f.restart(); assert.equal(f.store.getAvatar(2).preferences.bannedUntil, 1000 + 2 * 86400000);
});

test('randomizer keeps hidden outcomes server-side until its roller reveals them', t => {
  const f = fixture(t), dice = f.object(58, { num_dice: 2, die_sides: 6, offset: 1 });
  const rolled = f.act(4501, dice.id, { hidden: 3 }, {}, { randomInt: () => 4 });
  assert.equal(rolled.reply.result, 0); assert.equal(rolled.notices[0].fields.result, 0);
  assert.equal(f.store.getObject(dice.id).randomResult, 9);
  const revealed = f.act(4505, dice.id, { to_who: 3 });
  assert.equal(revealed.reply.result, 9); assert.equal(revealed.reply.hidden, 0);
  assert.equal(revealed.notices[0].fields.result, 9);
});

test('configured body change spends exact cash and persists a recovered style slot', t => {
  const f = fixture(t), changer = f.object(34, { bodyURL7: 'o.bodyma.img', bodyDefault7: 0, bodycost7: 10 }, { portable: false });
  held(f, 26, { denom: 10 });
  f.act(3301, changer.id, { body: 7 });
  assert.equal(f.store.getObject(f.actor).fields.imageURL, 'o.bodyma.img');
  assert.equal(f.store.getObject(f.actor).fields.bodyStyle, 7);
  assert.equal(f.store.listObjects({ containerId: f.actor }).length, 0);
  f.restart(); assert.equal(f.store.getObject(f.actor).fields.bodyStyle, 7);
});

test('ATM counter reset changes its reporting window without deleting financial history', t => {
  const f = fixture(t), atm = f.object(33, {}, { portable: false });
  f.act(2810, atm.id, { amount: 10 });
  const stats = f.act(30, atm.id).reply; assert.equal(stats.withdrawals, 10); assert.equal(stats.num_withdrawals, 1);
  const entries = f.store.snapshot().ledger.length;
  f.act(2815, atm.id, { reset: 1, operateOrientation: 65535 });
  assert.equal(f.act(30, atm.id).reply.withdrawals, 0);
  assert.equal(f.store.snapshot().ledger.length, entries);
});

test('request 30 reads the Teleport configuration with reply 1206 and exact recovered field names', t => {
  const f = fixture(t), connection = { address: 'Lobby', aliases0: 'Entrance', aliases1: 'Home', aliases2: '', aliases3: 'North', aliases4: 'Start', secret_address: 1, areaCode: 7 };
  const teleport = f.object(56, {}, { portable: false });
  f.store.transaction(draft => { draft.objects[teleport.id].properties = { connection }; });
  const result = f.act(30, teleport.id, { unused: 0 });
  assert.equal(result.replyId, 1206); assert.deepEqual(result.reply, { success: 0, dummyfielda: 0, ...connection });
  f.restart(); assert.deepEqual(f.act(30, teleport.id).reply, result.reply);
  const atm = f.object(33, {}, { portable: false });
  assert.equal(f.act(30, atm.id).replyId, 2813);
  assert.equal(replyIdForObjectRequest(30, 56), 1206);
  assert.equal(replyIdForObjectRequest(30, 33), 2813);
  assert.equal(replyIdForObjectRequest(85, 26), 1152);
  assert.equal(replyIdForObjectRequest(89, 26), 1156);
  assert.equal(replyIdForObjectRequest(85, 48), 86);
  assert.equal(replyIdForObjectRequest(89, 48), 90);
});

test('unauthorized and malformed Teleport request 30 always fail with reply 1206', async t => {
  const f = fixture(t), replies = [], teleport = f.object(56, {}, { ownerId: 2, portable: false });
  f.store.transaction(draft => { draft.objects[teleport.id].properties = { connection: { address: 'Private destination', secret_address: 1 } }; });
  const registry = new ClassRegistry(new ResourceStore({ clientDir: new URL('../../wa', import.meta.url).pathname }));
  const context = { worldStore: f.store, registry, isAdmin: () => false, actorObject: () => f.store.getObject(f.actor),
    resolveObject: (_session, noid) => f.store.getObject(noid), reply: async (_session, noid, id, fields) => {
      replies.push({ noid, id, fields: registry.decodeMessage(id, registry.encodeMessage(id, fields)) });
    } };
  const session = { avatar: { id: 1, name: 'Alice' } }, actions = new ObjectActions(context), revision = f.store.snapshot().revision;
  await actions.handle(session, { noid: teleport.id, id: 30, payload: registry.encodeMessage(30, { unused: 0 }) });
  assert.equal(replies[0].id, 1206); assert.equal(replies[0].fields.success, 16);
  assert.deepEqual(replies[0].fields, { success: 16, dummyfielda: 0, address: '', aliases0: '', aliases1: '', aliases2: '', aliases3: '', aliases4: '', secret_address: 0, areaCode: 0 });
  await actions.handle(session, { noid: teleport.id, id: 30, payload: Buffer.alloc(0) });
  assert.equal(replies[1].id, 1206); assert.equal(replies[1].fields.success, 2);
  assert.equal(replies.some(reply => reply.id === 2813), false);
  assert.equal(f.store.snapshot().revision, revision);
});

test('Tokens put and pocket failures retain their class-specific reply contracts', async t => {
  const f = fixture(t), replies = [], tokens = f.object(26, { denom: 10, position: [0, 0, 0] }, { ownerId: 2, containerId: f.bob.objectId });
  const context = { worldStore: f.store, isAdmin: () => false, actorObject: () => f.store.getObject(f.actor),
    resolveObject: (_session, noid) => f.store.getObject(noid), reply: async (_session, _noid, id, fields) => replies.push({ id, fields }) };
  const session = { avatar: { id: 1, name: 'Alice' } }, actions = new ObjectActions(context);
  await actions.handle(session, { noid: tokens.id, id: 85, fields: { container: f.actor, in_pocket: 0 } });
  await actions.handle(session, { noid: tokens.id, id: 89, fields: { unused: 0 } });
  assert.deepEqual(replies.map(reply => reply.id), [1152, 1156]);
  assert.ok(replies.every(reply => reply.fields.success !== 0));
  assert.equal(f.store.getObject(tokens.id).containerId, f.bob.objectId);
});

test('travel commits movement with payment or magic charges before replying and rolls everything back on rename failure', async t => {
  const originalRename = fs.renameSync;
  let rejectedFilename;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === rejectedFilename) { const error = new Error('injected travel save failure'); error.code = 'EACCES'; throw error; }
    return originalRename(source, destination);
  });
  for (const kind of ['paid teleport', 'magic charges']) {
    const f = fixture(t), events = [], cash = held(f, 26, { denom: 40 });
    const bag = f.object(36, { position: [4, 0, 0] }, { containerId: f.actor, capacity: 1 });
    const note = f.object(37, { position: [0, 0, 0] }, { containerId: bag.id });
    const device = f.object(kind === 'paid teleport' ? 56 : 45, { rideCost: 25, charges: 2, common_flags: 0 }, { portable: false });
    if (kind === 'magic charges') f.store.transaction(draft => { draft.objects[device.id].properties = { effect: { type: 'teleport', regionId: 2 } }; });
    const session = { avatar: { id: 1, name: 'Alice' }, regionId: 1 };
    const context = { worldStore: f.store, isAdmin: () => false, actorObject: () => f.store.getObject(f.actor),
      resolveObject: (_session, noid) => f.store.getObject(noid),
      teleport: () => assert.fail('legacy travel must not run when transactional hooks exist'),
      moveActorInDraft(draft, currentSession, regionId) {
        const actor = draft.objects[f.actor], profile = draft.avatars[1], oldRegion = currentSession.regionId;
        actor.regionId = regionId; actor.containerId = null; actor.fields.position = [256, 220, 0];
        profile.regionId = regionId; profile.position = [...actor.fields.position];
        const carry = parent => { for (const child of Object.values(draft.objects).filter(o => o.containerId === parent)) { child.regionId = regionId; carry(child.id); } };
        carry(actor.id); return { oldRegion, regionId };
      },
      reply: async (_session, _noid, id, fields) => {
        assert.equal(f.store.getAvatar(1).regionId, 2, 'the move is durable before success');
        assert.equal(session.regionId, 1, 'scene publication follows the reply');
        events.push({ kind: 'reply', id, success: fields.success });
      },
      publishTravel: async (currentSession, transition) => { currentSession.regionId = transition.regionId; events.push({ kind: 'publish', ...transition }); },
    };
    const message = { noid: device.id, id: kind === 'paid teleport' ? 1202 : 2134,
      fields: kind === 'paid teleport' ? { address: 'Garden' } : { target: f.actor } };
    const actions = new ObjectActions(context), before = f.store.snapshot(), saved = fs.readFileSync(f.store.filename, 'utf8');
    rejectedFilename = f.store.filename;
    await assert.rejects(actions.handle(session, message), /injected travel save failure/, kind);
    rejectedFilename = undefined;
    assert.deepEqual(f.store.snapshot(), before, `${kind}: money, charges, ledger and locations roll back together`);
    assert.equal(fs.readFileSync(f.store.filename, 'utf8'), saved);
    assert.deepEqual(events, []); assert.equal(session.regionId, 1);
    await actions.handle(session, message);
    assert.deepEqual(events.map(event => event.kind), ['reply', 'publish']);
    assert.equal(events[0].success, 0); assert.equal(session.regionId, 2);
    for (const id of [f.actor, cash.id, bag.id, note.id]) assert.equal(f.store.getObject(id).regionId, 2);
    assert.equal(f.store.getAvatar(1).balance, before.avatars[1].balance);
    assert.equal(f.store.getObject(cash.id).fields.denom, kind === 'paid teleport' ? 15 : 40);
    assert.equal(f.store.getObject(device.id).fields.charges, kind === 'magic charges' ? 1 : 2);
    assert.equal(f.store.snapshot().ledger.length, before.ledger.length + (kind === 'paid teleport' ? 1 : 0));
    f.restart(); assert.equal(f.store.getAvatar(1).regionId, 2);
  }
});

test('staff avatar controls persist promotion and image type, reject forged targets and protect account ownership', t => {
  const f = fixture(t), target = f.bob.objectId;
  const before = f.store.snapshot().revision;
  for (const id of [1681, 1683, 1686, 1699]) assert.throws(() => f.act(id, target, { perm_level: 3000, type: 7 }, { target }), /administrator permission/);
  assert.equal(f.store.snapshot().revision, before);
  assert.throws(() => f.act(1681, target, { perm_level: 3000 }, { target: f.actor }, { admin: true }), /does not match/);
  assert.equal(f.store.getAvatar(2).role, 'player');
  const promotion = f.act(1681, target, { perm_level: 2000 }, { target }, { admin: true });
  assert.equal(promotion.permissionAvatarId, 2); assert.equal(promotion.permissionLevel, 2000);
  assert.equal(f.store.getAvatar(2).role, 'builder');
  const image = f.act(1683, target, { type: 0x12345678 }, { target }, { admin: true });
  assert.deepEqual(image.notices, [{ targetId: target, id: 1684, fields: { target: { $objectRef: target }, type: 0x12345678 } }]);
  assert.equal(f.store.getObject(target).fields.imageDefault, 0x12345678);
  const owner = f.act(1699, target, {}, {}, { admin: true, targetAccountName: 'bob-account' });
  assert.equal(owner.reply.fail_msg, 'Bob belongs to account bob-account.');
  assert.deepEqual(f.act(1686, target, {}, {}, { admin: true }).kickAvatarIds, [2]);
  f.restart(); assert.equal(f.store.getAvatar(2).permissionLevel, 2000);
  assert.equal(f.store.getAvatar(2).role, 'builder');
  assert.equal(f.store.getObject(target).fields.imageDefault, 0x12345678);
  f.act(1681, target, { perm_level: 10 }, { target }, { admin: true });
  assert.equal(f.store.getAvatar(2).role, 'player');
});

test('promotion notices reach only the promoted session and force logout follows its acknowledgement', async t => {
  const f = fixture(t), events = [], sessions = new Set();
  const alice = { avatar: { id: 1, name: 'Alice' }, closed: false }, bob = { avatar: { id: 2, name: 'Bob' }, closed: false,
    end() { this.closed = true; events.push({ type: 'end', session: this }); } };
  sessions.add(alice); sessions.add(bob);
  f.store.transaction(draft => { draft.avatars[1].role = 'admin'; });
  const context = { worldStore: f.store, sessions, actorObject: session => f.store.getObject(f.store.getAvatar(session.avatar.id).objectId),
    resolveObject: (_session, noid) => f.store.getObject(noid), objectNoid: (_session, object) => object.id,
    ref: id => id, accountForName: name => ({ id: 2, name: `${name}-account` }),
    reply: async (session, noid, id, fields) => events.push({ type: 'reply', session, noid, id, fields }),
    refreshSession: async session => events.push({ type: 'refresh', session }) };
  const actions = new ObjectActions(context), noid = f.bob.objectId;
  await actions.handle(alice, { noid, id: 1681, fields: { target: noid, perm_level: 2000 } });
  assert.deepEqual(events.map(event => [event.type, event.session.avatar.id, event.id]), [['reply', 1, 70], ['reply', 2, 1682], ['refresh', 2, undefined]]);
  assert.equal(events[1].fields.perm_level, 2000);
  await actions.handle(alice, { noid, id: 1699, fields: {} });
  assert.equal(events.at(-1).fields.fail_msg, 'Bob belongs to account Bob-account.');
  events.length = 0;
  await actions.handle(alice, { noid, id: 1686, fields: {} });
  assert.deepEqual(events.map(event => [event.type, event.session.avatar.id, event.id]), [['reply', 1, 70], ['end', 2, undefined]]);
  assert.equal(alice.closed, false); assert.equal(bob.closed, true);
});

test('Quip descriptions use the common native describe contract', t => {
  const f = fixture(t), quip = f.object(23, { name: 'Speech', description: 'A thought balloon.' });
  assert.deepEqual(f.act(76, quip.id).reply, { success: 0, text: 'A thought balloon.' });
});

test('printing and newspaper purchases produce portable copies from fixed masters without moving the original', t => {
  for (const kind of ['printing', 'newspaper']) {
    const f = fixture(t);
    const device = f.object(kind === 'printing' ? 43 : 47, { cost: 0, price: 0 }, { portable: false, capacity: 1 });
    const master = f.object(37, { name: 'Fixed master', common_flags: 2, blank_page_count: 1,
      position: kind === 'printing' ? [0, 0, 0] : [100, 200, 0] },
      { portable: false, containerId: kind === 'printing' ? device.id : null });
    f.act(2771, master.id, { page: 0, text: 'Published text' });
    if (kind === 'newspaper') f.act(4407, device.id, {}, { master: master.id });
    const original = f.store.getObject(master.id);
    const purchase = f.act(kind === 'printing' ? 4361 : 4403, device.id, { copies: 1 });
    const copyId = purchase.cvObjectIds[0], copy = f.store.getObject(copyId);
    assert.notEqual(copyId, master.id);
    assert.equal(copy.portable, true); assert.equal(copy.fields.common_flags & 2, 0);
    assert.equal(copy.containerId, f.actor);
    assert.equal(f.store.snapshot().documents[copyId].text, 'Published text');
    f.act(1580, f.actor);
    assert.equal(f.store.getObject(copyId).containerId, null);
    f.act(1575, f.actor, {}, { item: copyId });
    assert.equal(f.store.getObject(copyId).containerId, f.actor);
    assert.deepEqual(f.store.getObject(master.id), original);
  }
});
