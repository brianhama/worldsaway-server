import type { NativeFields, GameObject, WorldState } from './types.js';
import type { ActionContext, ActionSession, NativeActionRequest, TransactionRequest, ActionResult, SchemaValue } from './action-types.js';
/** Authoritative local policies for request shapes recovered from the WA Tcl. */
import { randomInt } from 'node:crypto';
import { SchemaError } from './classes.js';
export class ActionError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) { super(message); this.code = code; }
}

const common = [24, 25, 26, 27, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 98, 200, 201, 203, 204, 205, 206, 209, 210, 213, 215];
const c = (id: number, replyId: number, name: string, classes = common, replyByClass: Record<number, number> = {}) => Object.freeze({ id, replyId, name,
  classes: Object.freeze(classes), replyByClass: Object.freeze(replyByClass) });
export const OBJECT_REQUESTS = Object.freeze([
  c(26, 70, 'rename', [20, ...common]), c(76, 77, 'describe', [20, 21, 22, 23, ...common]),
  c(1575, 70, 'get into hand', [21]), c(1580, 1582, 'drop held object', [21]),
  c(1605, 1609, 'give held object', [21]), c(1608, 80, 'open container', [21]), c(1611, 70, 'close container', [21]),
  c(1711, 1712, 'list pocket contents', [21]), c(1714, 1715, 'get pocket path', [21]),
  c(85, 86, 'put in container', common, { 26: 1152 }), c(89, 90, 'put in pocket', common, { 26: 1156 }), c(93, 70, 'take from container'), c(97, 70, 'take from pocket'),
  c(300, 70, 'open close lock unlock', [36, 38, 59, 201]), c(303, 70, 'open close device', [35]), c(337, 338, 'read change combination', [36, 38, 59, 201]),
  c(2401, 2402, 'sit', [53]), c(2405, 2406, 'stand from seat', [53]),
  c(3201, 70, 'wear accessory', [30]), c(3205, 70, 'remove accessory', [30]), c(3211, 3212, 'operate accessory', [30]),
  c(3601, 70, 'wear head', [24]), c(3605, 70, 'remove head', [24]),
  c(20602, 70, 'wear clothing', [206]), c(20605, 70, 'remove clothing', [206]),
  c(4151, 4152, 'operate use object', [31]), c(1035, 70, 'spray colors', [55]),
  c(3424, 3425, 'compass north', [35]), c(3427, 3428, 'compass direction', [35]),
  c(2351, 70, 'enter door', [38]), c(1202, 70, 'teleport by address', [56]), c(4102, 70, 'elevator destination', [39]),
  c(1139, 1142, 'split tokens', [26]), c(2801, 2802, 'bank balance', [33]), c(2806, 2807, 'deposit', [33]), c(2810, 2812, 'withdraw', [33]),
  c(2561, 2562, 'appraise', [49]), c(2565, 2566, 'pawn', [49]),
  c(2671, 2672, 'browse vendroid', [57]), c(2675, 80, 'buy vendroid item', [57]), c(2678, 2679, 'stock vendroid', [57]), c(2682, 2683, 'unload vendroid', [57]),
  c(2730, 2731, 'document orientation', [37]), c(2720, 2721, 'document state', [37]),
  c(2710, 2711, 'document header', [37]), c(2712, 2713, 'document metadata', [37]),
  c(2715, 2716, 'binder header', [37]), c(2717, 2718, 'binder metadata', [37]),
  c(2735, 2736, 'binder list', [37]), c(2737, 2738, 'create document text', [37]), c(2740, 2741, 'create binder index', [37]),
  c(2743, 2744, 'add document to binder', [37]), c(2747, 2748, 'remove document from binder', [37]),
  c(2761, 2762, 'reorder page', [37]), c(2771, 2770, 'write page', [37]), c(2781, 2780, 'read page', [37]),
  c(2791, 2792, 'split blank pages', [37]), c(2796, 2797, 'move blank pages', [37]), c(2751, 70, 'document published state', [37]),
  c(4353, 4354, 'set printing master', [43]), c(4357, 4358, 'remove printing master', [43]), c(4361, 4362, 'print copies', [43]),
  c(4303, 4304, 'recycle document', [51]), c(4311, 4312, 'produce blank pages', [51]),
  c(30, 2813, 'ATM statistics / teleport configuration', [33, 56], { 33: 2813, 56: 1206 }), c(3301, 70, 'buy body style', [34]), c(3304, 70, 'configure body style', [34]),
  c(2131, 70, 'activate magic', [45]), c(2134, 70, 'configured magic effect', [45]),
  c(4403, 80, 'buy news copy', [47]), c(4407, 70, 'set news master', [47]),
  c(4453, 70, 'post physical mail', [50]), c(4457, 4458, 'receive physical mail', [50]),
  c(2920, 2921, 'registry names', [52]), c(2924, 70, 'register display name', [52]),
  c(4501, 4502, 'roll randomizer', [58]), c(4505, 4506, 'reveal randomizer', [58]), c(5101, 5102, 'operate weapon prop', [59]),
  c(5605, 5606, 'banner data', [61]), c(5621, 70, 'set banner data', [61]), c(5631, 70, 'set banner state', [61]),
  c(5675, 80, 'receive banner prize', [61]), c(5678, 5679, 'stock banner', [61]), c(5682, 5683, 'unload banner', [61]),
  c(9908, 70, 'engrave owned object', [98]),
  c(3101, 70, 'summon avatar', [32]), c(3114, 70, 'ban avatar', [32]), c(3116, 70, 'ban account', [32]), c(3117, 70, 'join avatar', [32]),
  c(1681, 70, 'promote avatar', [21]), c(1683, 70, 'change avatar type', [21]),
  c(1686, 70, 'force avatar logout', [21]), c(1699, 70, 'disclose avatar owner', [21]),
  c(1701, 70, 'mute avatar', [21, 22]), c(1703, 70, 'freeze avatar', [21, 22]),
  c(2724, 70, 'delete binder entry', [37]), c(2815, 70, 'configure ATM counters', [33]),
  c(3106, 70, 'staff teleport to region', [32]), c(3107, 70, 'staff teleport another avatar', [32]), c(3313, 70, 'activate body changer', [34]),
]);
export const SUPPORTED_REQUESTS = OBJECT_REQUESTS;
const contracts = new Map(OBJECT_REQUESTS.map(x => [x.id, x]));
/** A request ID alone is insufficient for shared Tcl methods such as request 30. */
export function replyIdForObjectRequest(id: number, classNumber?: number) {
  const contract = contracts.get(id);
  return contract?.replyByClass[classNumber ?? -1] ?? contract?.replyId;
}
const REF = (id: number | null | undefined) => id == null ? 65535 : { $objectRef: Number(id) };
const MAX_MONEY = 0x7fffffff;

function integer(value: unknown, min = 0, max = 65535, name = 'value'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ActionError(`Invalid ${name}`, 2);
  return value;
}
function string(value: unknown, max: number, name = 'text') {
  if (typeof value !== 'string' || value.length > max || /[\0\x01-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new ActionError(`Invalid ${name}`, 2);
  return value;
}
const fieldsOf = (object: GameObject) => object.fields ??= {};
const objects = (draft: WorldState) => Object.values(draft.objects);
const children = (draft: WorldState, id: number) => objects(draft).filter(o => o.containerId === id);
const slot = (object: GameObject) => object.slot ?? object.fields?.position?.[0] ?? 0;
function get(draft: WorldState, id: number | undefined) { const object = id === undefined ? undefined : draft.objects[id]; if (!object) throw new ActionError('Object is missing', 3); return object; }
function rootObject(draft: WorldState, object: GameObject) {
  const seen = new Set();
  while (object.containerId != null) {
    if (seen.has(object.id)) throw new ActionError('Container cycle', 2);
    seen.add(object.id); object = get(draft, object.containerId);
  }
  return object;
}
/** An unowned child may be controlled through its owned container, never through a wire flag. */
function owns(draft: WorldState, object: GameObject, request: TransactionRequest) {
  if (request.admin || object.ownerId === request.avatarId) return true;
  if (object.ownerId != null) return false;
  const seen = new Set();
  while (object.containerId != null && !seen.has(object.id)) {
    seen.add(object.id); object = get(draft, object.containerId);
    if (object.id === request.actorId || object.ownerId === request.avatarId) return true;
  }
  return false;
}
function requireOwned(draft: WorldState, object: GameObject, request: TransactionRequest) {
  if (!owns(draft, object, request)) throw new ActionError('You do not own this object');
  if (object.pendingSale && !object.pendingSale.paid && ![85, 89, 93, 97, 1714].includes(request.id)) throw new ActionError('Pay for this object at its cashier first', 16);
}
function visible(draft: WorldState, object: GameObject, actor: GameObject, request: TransactionRequest) {
  if (object.regionId !== actor.regionId && !owns(draft, object, request)) throw new ActionError('Object is not in your region', 3);
  let parent = object;
  const seen = new Set();
  while (parent.containerId != null && !seen.has(parent.id)) {
    seen.add(parent.id); parent = get(draft, parent.containerId);
    if (parent.id !== actor.id && (parent.fields?.common_flags & 8)) throw new ActionError('Container is closed', 12);
    if (parent.classNumber === 21 && parent.id !== actor.id && !request.admin) throw new ActionError('That inventory is private', 16);
  }
}
function available(draft: WorldState, object: GameObject, actor: GameObject, request: TransactionRequest) {
  visible(draft, object, actor, request);
  if (!owns(draft, object, request) && object.ownerId != null && !object.public && !object.shared) throw new ActionError('That object belongs to another player', 16);
}
function portable(object: GameObject) {
  if (object.portable === false || [0, 10, 11, 20, 21, 22, 200].includes(object.classNumber) || (object.fields?.common_flags & (2 | 256 | 512))) throw new ActionError('This object cannot be moved');
}
function capacity(object: GameObject) {
  const physical = Number(object.capacity ?? 0);
  const reduced = object.fields?.reducedCapacity;
  return Number.isInteger(reduced) && reduced > 0 ? Math.min(reduced, physical) : physical;
}
function emptySlot(draft: WorldState, container: GameObject, start = 0) {
  const used = new Set(children(draft, container.id).map(slot));
  for (let index = start; index < capacity(container); index++) if (!used.has(index)) return index;
  throw new ActionError('Container is full', 15);
}
function inSlot(draft: WorldState, container: GameObject, index: number) { return children(draft, container.id).find(o => slot(o) === index) ?? null; }
function setContainerSlot(object: GameObject, index: number) { object.slot = index; fieldsOf(object).position = [index, 0, 0]; }
/** Slot 0 is the native display; currentSlot is its otherwise empty storage home. */
function vendroidView(draft: WorldState, machine: GameObject) {
  const data = fieldsOf(machine), stock = children(draft, machine.id).sort((a, b) => slot(a) - slot(b));
  if (!stock.length) {
    Object.assign(data, { currentSlot: 0, fullSlots: 0, price: 0 });
    return { displayed: null, current: 0, entries: [], normalized: false };
  }
  if (capacity(machine) < 2) throw new ActionError('The vendroid needs a display and a storage slot', 15);
  let current = integer(data.currentSlot ?? 0, 0, capacity(machine) - 1, 'current slot');
  let displayed = inSlot(draft, machine, 0), normalized = false;
  if (!displayed) {
    displayed = stock.find(item => slot(item) === current) ?? stock[0];
    current = slot(displayed); setContainerSlot(displayed, 0); normalized = true;
  }
  if (current === 0 || inSlot(draft, machine, current)) {
    current = emptySlot(draft, machine, 1); normalized = true;
  }
  Object.assign(data, { currentSlot: current, fullSlots: stock.length, price: money(displayed.fields?.salePrice ?? 0, 'price', true) });
  const entries = stock.map(item => ({ item, logicalSlot: item.id === displayed.id ? current : slot(item) })).sort((a, b) => a.logicalSlot - b.logicalSlot);
  return { displayed, current, entries, normalized };
}
function hand(draft: WorldState, actor: GameObject) { return inSlot(draft, actor, 0); }
function emptyHand(draft: WorldState, actor: GameObject, exceptId: number | null = null) { const held = hand(draft, actor); if (held && held.id !== exceptId) throw new ActionError('Your hand is occupied', 15); }
/** Keep the entire containment tree in one region while retaining stable IDs. */
function place(draft: WorldState, item: GameObject, container: GameObject | null, index: number, actor: GameObject, request: TransactionRequest) {
  if (container) {
    if (container.id === item.id) throw new ActionError('Cannot contain itself', 2);
    let parent: GameObject | null = container;
    const seen = new Set();
    while (parent) {
      if (parent.id === item.id || seen.has(parent.id)) throw new ActionError('Container cycle', 2);
      seen.add(parent.id); parent = parent.containerId == null ? null : get(draft, parent.containerId);
    }
    if (index < 0 || index >= capacity(container)) throw new ActionError('Invalid container slot', 15);
    const occupied = inSlot(draft, container, index);
    if (occupied && occupied.id !== item.id) throw new ActionError('Container slot is occupied', 15);
    item.containerId = container.id; item.slot = index;
    fieldsOf(item).position = [index, 0, 0];
  } else { item.containerId = null; item.slot = 0; fieldsOf(item).position = [...(actor.fields?.position ?? [256, 220, 0])]; }
  item.regionId = actor.regionId;
  if (container && (container.id === actor.id || owns(draft, container, request))) item.ownerId = request.avatarId;
  for (const child of children(draft, item.id)) propagateRegion(draft, child, actor.regionId);
}
function propagateRegion(draft: WorldState, item: GameObject, regionId: number) { item.regionId = regionId; for (const child of children(draft, item.id)) propagateRegion(draft, child, regionId); }
function erase(draft: WorldState, item: GameObject) {
  for (const child of children(draft, item.id)) erase(draft, child);
  for (const [id, timer] of Object.entries(draft.timers ?? {})) if (timer.objectId === item.id) delete draft.timers[id];
  for (const doc of Object.values(draft.documents)) if (Array.isArray(doc.entries)) doc.entries = doc.entries.filter(id => id !== item.id);
  delete draft.documents[item.id]; delete draft.objects[item.id];
}
function create(draft: WorldState, template: Partial<GameObject> & { classNumber: number; fields?: NativeFields }, actor: GameObject, request: TransactionRequest) {
  const id = draft.next.object++;
  const item: GameObject = { regionId: actor.regionId, containerId: null,
    ownerId: request.avatarId, portable: true, locked: false, capacity: 0, fields: {}, ...template, id };
  draft.objects[id] = item; return item;
}
function money(value: unknown, name = 'amount', allowZero = false) { return integer(value, allowZero ? 0 : 1, MAX_MONEY, name); }
function denom(item: GameObject) { return money(item.fields?.denom ?? 0, 'token denomination', true); }
function ledger(draft: WorldState, request: TransactionRequest, kind: string, amount: number, details: NativeFields = {}) {
  draft.ledger.push({ id: draft.next.transaction++, at: request.now, avatarId: request.avatarId, kind, amount, ...details });
}
function tokenTemplate(amount: number) { return { classNumber: 26, capacity: 0, fields: { name: 'Tokens', denom: amount, imageURL: '', imageDefault: 0, colorMap: Array.from({ length: 16 }, (_, i) => i) } }; }
function listWord(value: unknown) { return `{${String(value).replace(/[{}\\]/g, '')}}`; }
function createCash(draft: WorldState, actor: GameObject, request: TransactionRequest, amount: number) {
  money(amount);
  const held = hand(draft, actor);
  if (held) {
    if (held.classNumber !== 26) throw new ActionError('Your hand is occupied', 15);
    fieldsOf(held).denom = money(denom(held) + amount); return { item: held, created: false };
  }
  const item = create(draft, tokenTemplate(amount), actor, request);
  place(draft, item, actor, 0, actor, request); return { item, created: true };
}
/** Cash is a physical Token object; spending it never silently debits bank funds. */
function spendCash(draft: WorldState, actor: GameObject, amount: number) {
  money(amount, 'cost', true); if (!amount) return;
  const held = hand(draft, actor);
  if (!held || held.classNumber !== 26 || denom(held) < amount) throw new ActionError('Insufficient held tokens', 6);
  fieldsOf(held).denom -= amount;
  if (!held.fields.denom) erase(draft, held);
}
function document(draft: WorldState, object: GameObject, request: TransactionRequest) {
  if (object.classNumber !== 37) throw new ActionError('Object is not a document', 2);
  return draft.documents[object.id] ??= { objectId: object.id, title: object.fields?.name ?? 'Document', text: '', pages: [], entries: [], updatedAt: request.now, author: request.avatarName ?? '' };
}
function writable(draft: WorldState, object: GameObject, request: TransactionRequest) {
  requireOwned(draft, object, request);
  if ((object.fields?.documentFlags & 1) && !request.admin) throw new ActionError('Document is read only', 16);
}
function regionByAddress(draft: WorldState, value: unknown) {
  return Object.values(draft.regions).find(r => String(r.id) === String(value) || r.name.toLowerCase() === String(value).toLowerCase() || r.properties?.address === value);
}
/** Imported passages only reach destinations actually observed during the survey. */
function surveyTravelDestination(draft: WorldState, object: GameObject, request: TransactionRequest) {
  const travel = object.properties?.surveyTravel;
  if (travel === undefined) return undefined;
  if (travel?.version !== 1) throw new ActionError('Surveyed travel configuration is unavailable', 3);
  let destinationId: unknown;
  if (request.id === 2351) destinationId = travel.destinationRegionId;
  else {
    const address = request.id === 4102 && request.fields?.home === 1 ? 'home' : string(request.fields?.address, 128, 'address');
    const destinations = travel.destinations;
    if (destinations && Object.hasOwn(destinations, address)) destinationId = destinations[address];
  }
  if (typeof destinationId !== 'number' || !Number.isSafeInteger(destinationId) || destinationId < 1 || !draft.regions[destinationId]) {
    throw new ActionError('Destination was not recorded in this surveyed passage', 3);
  }
  return draft.regions[destinationId];
}
const ok = (replyId: number, reply: NativeFields = {}): ActionResult => ({ replyId, reply: { success: 0, ...reply }, notices: [], refresh: false });
const notice = (out: ActionResult, targetId: number, id: number, fields: NativeFields) => out.notices.push({ targetId, id, fields });

/** Pure transaction evaluator. Input noid references are resolved to global IDs in refs. */
export function applyObjectAction(draft: WorldState, request: TransactionRequest): ActionResult | null {
  const contract = contracts.get(request.id);
  if (!contract) return null;
  const actor = get(draft, request.actorId), target = get(draft, request.objectId);
  const f = request.fields ?? {}, refs = request.refs ?? {};
  if (!contract.classes.includes(target.classNumber)) throw new ActionError('This action is not available on this class', 2);
  visible(draft, target, actor, request);
  const out = ok(replyIdForObjectRequest(request.id, target.classNumber)!);
  const avatar = draft.avatars[request.avatarId];
  if (!avatar) throw new ActionError('Avatar profile is missing', 3);
  const fTarget = fieldsOf(target);
  switch (request.id) {
    case 26: {
      requireOwned(draft, target, request);
      const name = string(f.newName, 31, 'name').trim(); if (!name) throw new ActionError('Name is empty', 2);
      fTarget.name = name; notice(out, target.id, 28, { newName: name }); break;
    }
    case 76:
      out.reply.text = String(target.description ?? target.properties?.description ?? fTarget.description ?? fTarget.name ?? 'An object.').slice(0, 32000); break;
    case 1575: {
      if (target.id !== actor.id) throw new ActionError('Actor does not match session', 2);
      const item = get(draft, refs.item); available(draft, item, actor, request); portable(item); emptyHand(draft, actor, item.id);
      if (!item.pendingSale && (item.forSale === true || item.properties?.forSale === true) && item.ownerId !== request.avatarId) {
        const cashier = objects(draft).find(o => o.regionId === actor.regionId && o.classNumber === 205 && (item.cashierId ?? item.properties?.cashierId ?? o.id) === o.id);
        if (!cashier) throw new ActionError('This shop has no cashier', 7);
        item.pendingSale = { cashierId: cashier.id, buyerId: request.avatarId, price: money(item.fields?.salePrice ?? 0, 'price', true), sellerId: item.ownerId, paid: false };
      }
      place(draft, item, actor, 0, actor, request); notice(out, actor.id, 1576, { item: REF(item.id) }); break;
    }
    case 1580: {
      if (target.id !== actor.id) throw new ActionError('Actor does not match session', 2);
      const item = hand(draft, actor); if (!item) throw new ActionError('Nothing is held', 3);
      requireOwned(draft, item, request); portable(item); place(draft, item, null, 0, actor, request);
      out.reply.at = item.fields.position; notice(out, actor.id, 1581, { item: REF(item.id), at: item.fields.position }); break;
    }
    case 1605: {
      if (target.id === actor.id || target.classNumber !== 21) throw new ActionError('Choose another avatar', 2);
      const recipient = Object.values(draft.avatars).find(profile => profile.objectId === target.id);
      if (!recipient) throw new ActionError('Recipient is missing', 3);
      const held = hand(draft, actor); if (!held) throw new ActionError('Hold an item to give', 3);
      requireOwned(draft, held, request); portable(held); emptyHand(draft, target);
      const tree: GameObject[] = []; const visit = (item: GameObject): void => { requireOwned(draft, item, request); tree.push(item); children(draft, item.id).forEach(visit); }; visit(held);
      place(draft, held, target, 0, actor, request); tree.forEach(item => { item.ownerId = recipient.id; });
      out.reply.giver_orientation = actor.fields?.orientation ?? 0; out.reply.givee_orientation = target.fields?.orientation ?? 0;
      notice(out, target.id, 1606, { giver: REF(actor.id), givee: REF(target.id), ...out.reply }); break;
    }
    case 1608: case 1611: {
      if (target.id !== actor.id) throw new ActionError('Actor does not match session', 2);
      const container = get(draft, refs.item); available(draft, container, actor, request);
      if (capacity(container) === 0 || ![36, 59, 201].includes(container.classNumber)) throw new ActionError('Not an openable container', 2);
      if (container.locked || (container.fields.common_flags & 16)) throw new ActionError('Container is locked', 16);
      container.fields.common_flags = ((container.fields.common_flags ?? 0) & ~8) | (request.id === 1611 ? 8 : 0);
      if (request.id === 1608) out.cvObjectIds = children(draft, container.id).map(o => o.id);
      else notice(out, actor.id, 1612, { item: REF(container.id) });
      out.refresh = true; break;
    }
    case 1711: {
      if (target.id !== actor.id) throw new ActionError('That inventory is private', 16);
      const entries: string[] = [];
      const visit = (container: GameObject, path: number[]): void => {
        for (const item of children(draft, container.id).sort((a,b) => slot(a)-slot(b))) {
          if (container.id === actor.id && slot(item) < 4) continue;
          const at = [...path, slot(item)]; entries.push(`{${listWord(item.fields?.name ?? 'Object')} {${at.join(' ')}}}`);
          if (!item.locked && !(item.fields?.common_flags & 16)) visit(item, at);
        }
      };
      visit(actor, []); out.reply.contentsData = entries.join(' '); break;
    }
    case 1714: {
      if (target.id !== actor.id) throw new ActionError('That inventory is private', 16);
      emptyHand(draft, actor);
      const path = string(f.contentsPath, 255, 'contents path').trim().replace(/^\{([^{}]*)\}$/, '$1');
      if (!/^\d+(?:\s+\d+)*$/.test(path)) throw new ActionError('Invalid contents path', 2);
      const indices = path.split(/\s+/).map(x => integer(Number(x), 0, 65535, 'slot'));
      if (indices[0] < 2 || indices.length > 20) throw new ActionError('Invalid pocket path', 2);
      let item: GameObject | null = actor;
      for (const index of indices) {
        if (item.locked || (item.fields?.common_flags & 16)) throw new ActionError('Container is locked', 16);
        item = inSlot(draft, item, index); if (!item) throw new ActionError('Pocket item is missing', 3);
      }
      requireOwned(draft, item, request); portable(item); place(draft, item, actor, 0, actor, request);
      out.reply.item = REF(item.id); out.cvObjectIds = [item.id]; out.refresh = true; break;
    }
    case 85: {
      requireOwned(draft, target, request); portable(target);
      const container = get(draft, refs.container); available(draft, container, actor, request);
      if (container.fields?.common_flags & 8) throw new ActionError('Container is closed', 12);
      if (container.classNumber === 21 && container.id !== actor.id) throw new ActionError('Cannot put objects in another avatar inventory', 16);
      const tokens = target.classNumber === 26 ? children(draft, container.id).find(x => x.classNumber === 26 && x.id !== target.id) : null;
      let index = tokens ? slot(tokens) : emptySlot(draft, container, container.classNumber === 21 ? 4 : 0);
      if (target.classNumber === 26) {
        out.replyId = 1152; out.reply.container_tokens = REF(tokens?.id); out.reply.denom = denom(target) + (tokens ? denom(tokens) : 0);
        money(out.reply.denom, 'combined tokens', true);
        if (tokens) { erase(draft, tokens); fTarget.denom = out.reply.denom; }
      }
      place(draft, target, container, index, actor, request); out.reply.slot = index;
      notice(out, target.id, target.classNumber === 26 ? 1153 : 87, { actor: REF(actor.id), container: REF(container.id), slot: index, container_tokens: REF(tokens?.id), denom: out.reply.denom ?? 0 }); break;
    }
    case 89: {
      requireOwned(draft, target, request); portable(target);
      if (target.containerId !== actor.id || slot(target) !== 0) throw new ActionError('Item must be held', 16);
      if (target.classNumber === 26) {
        const pocket = inSlot(draft, actor, 2);
        if (pocket && pocket.classNumber !== 26) throw new ActionError('Token slot is occupied', 15);
        const total = money(denom(target) + (pocket ? denom(pocket) : 0));
        out.replyId = 1156; out.reply.pocket_tokens = REF(pocket?.id); out.reply.denom = total;
        if (pocket) erase(draft, pocket);
        fTarget.denom = total; place(draft, target, actor, 2, actor, request);
      } else {
        if (fTarget.common_flags & 8 ? false : capacity(target) > 0) throw new ActionError('Close the container before pocketing it');
        const index = emptySlot(draft, actor, 4); place(draft, target, actor, index, actor, request); out.reply.slot = index;
      }
      notice(out, target.id, 91, {}); break;
    }
    case 93: case 97: {
      requireOwned(draft, target, request); portable(target); emptyHand(draft, actor, target.id);
      if (request.id === 97 && target.containerId !== actor.id) throw new ActionError('Item is not in your pocket', 16);
      if (request.id === 93 && target.containerId == null) throw new ActionError('Item is not in a container', 2);
      place(draft, target, actor, 0, actor, request); notice(out, target.id, 95, { actor: REF(actor.id) }); break;
    }
    case 300: case 303: {
      available(draft, target, actor, request);
      const state = integer(f.state, 0, 31, 'lock state');
      if (request.id === 300 && ![0, 8, 16, 24].includes(state)) throw new ActionError('Invalid open/lock state', 2);
      if (!owns(draft, target, request) && ((((fTarget.common_flags ?? 0) ^ state) & 16) || ((fTarget.common_flags ?? 0) & 16))) {
        const key = refs.indirect == null ? null : draft.objects[refs.indirect];
        const correct = key && key.classNumber === 44 && owns(draft, key, request) && Number(key.fields?.keycode) === Number(target.keycode ?? target.properties?.keycode);
        if (!correct && Number(f.keycode) !== Number(target.keycode ?? target.properties?.keycode)) throw new ActionError('Incorrect key or combination', 16);
      }
      target.locked = Boolean(state & 16); fTarget.common_flags = ((fTarget.common_flags ?? 0) & ~24) | (state & 24);
      notice(out, target.id, request.id === 300 ? 301 : 304, { direct: REF(target.id), actor: REF(actor.id), state }); break;
    }
    case 337: {
      requireOwned(draft, target, request);
      const mode = integer(f.mode, 1, 3, 'combination mode');
      const current = target.keycode ?? 0;
      if (mode !== 1 && f.old_keycode !== current && !request.admin) throw new ActionError('Incorrect old combination', 16);
      if (mode === 2) target.keycode = integer(f.new_keycode, 0, 0xffffffff, 'combination');
      out.reply.keycode = target.keycode ?? 0; break;
    }
    case 2401: {
      available(draft, target, actor, request);
      const index = integer(f.spot, 0, capacity(target) - 1, 'seat');
      if (actor.containerId != null) throw new ActionError('Already seated or contained');
      place(draft, actor, target, index, actor, request); actor.ownerId = request.avatarId;
      fieldsOf(actor).choreState = integer(f.choreState ?? 0); out.reply.common_flags = fTarget.common_flags ?? 0;
      notice(out, target.id, 2403, { actor: REF(actor.id), spot: index, common_flags: out.reply.common_flags }); break;
    }
    case 2405: {
      if (actor.containerId !== target.id) throw new ActionError('You are not sitting here');
      const index = slot(actor); actor.containerId = null; actor.slot = 0;
      fieldsOf(actor).position = [...(target.fields.position ?? [256, 220, 0])]; actor.fields.position[1] += 24;
      actor.fields.choreState = 0; out.reply = { success: 0, spot: index, common_flags: fTarget.common_flags ?? 0, coords: actor.fields.position };
      notice(out, target.id, 2407, { actor: REF(actor.id), ...out.reply }); break;
    }
    case 3201: case 3601: case 20602: {
      requireOwned(draft, target, request);
      if (target.containerId !== actor.id || slot(target) !== 0) throw new ActionError('Wearable must be held');
      let destination: GameObject | null = actor, index = request.id === 3601 ? 1 : 3;
      if (request.id === 3201) { destination = inSlot(draft, actor, 1); if (!destination || destination.classNumber !== 24) throw new ActionError('You need to wear a head first'); index = integer(fTarget.slot ?? 0, 0, capacity(destination) - 1, 'accessory slot'); }
      const previous = inSlot(draft, destination, index);
      // Clear both occupancy positions before swapping.
      target.containerId = null; if (previous) previous.containerId = null;
      if (previous) place(draft, previous, actor, 0, actor, request);
      place(draft, target, destination, index, actor, request);
      if (request.id === 20602) fTarget.choreState = integer(f.clothingChore ?? 0);
      notice(out, target.id, { 3201: 3203, 3601: 3603, 20602: 20603 }[request.id], { actor: REF(actor.id) }); break;
    }
    case 3205: case 3605: case 20605: {
      requireOwned(draft, target, request); emptyHand(draft, actor, target.id);
      if (rootObject(draft, target).id !== actor.id) throw new ActionError('You are not wearing this item');
      place(draft, target, actor, 0, actor, request); fTarget.choreState = 0;
      notice(out, target.id, { 3205: 3207, 3605: 3607, 20605: 20606 }[request.id], { actor: REF(actor.id) }); break;
    }
    case 3211: case 4151: {
      available(draft, target, actor, request); const action = integer(f.action, 0, 2, 'operation');
      fTarget.common_flags = ((fTarget.common_flags ?? 0) & ~64) | (action === 0 ? 64 : 0);
      if (fTarget.charges > 0) { requireOwned(draft, target, request); fTarget.charges--; if (fTarget.charges === 0) erase(draft, target); }
      notice(out, target.id, request.id === 3211 ? 3213 : 4153, { action }); break;
    }
    case 1035: {
      requireOwned(draft, target, request); const painted = get(draft, refs.target_noid); requireOwned(draft, painted, request);
      if (!Array.isArray(f.colors) || f.colors.length !== 16) throw new ActionError('Expected sixteen colors', 2);
      fieldsOf(painted).colorMap = f.colors.map(x => integer(x, 0, 255, 'color'));
      if (fTarget.charges > 0) fTarget.charges--;
      notice(out, target.id, 1036, { actor: REF(actor.id), target: REF(painted.id), colors: painted.fields.colorMap }); break;
    }
    case 3424: case 3427: out.reply.orientation = draft.regions[actor.regionId]?.properties?.north ?? 0; break;
    case 2351: case 1202: case 4102: {
      available(draft, target, actor, request);
      if (target.locked || (fTarget.common_flags & 16)) throw new ActionError('The passage is locked', 16);
      const surveyed = surveyTravelDestination(draft, target, request);
      const address = surveyed ? undefined : request.id === 1202 ? string(f.address, 128, 'address') : (target.destinationRegionId ?? target.properties?.destinationRegionId ?? target.destination ?? f.floor ?? f.areaCode);
      const destination = surveyed ?? regionByAddress(draft, address);
      if (!destination) throw new ActionError('Destination does not exist', 3);
      if (request.canEnterRegion && request.canEnterRegion(destination.id) !== true) throw new ActionError('You cannot enter that region', 16);
      const cost = money(target.properties?.surveyTravel?.cost ?? fTarget.rideCost ?? 0, 'ride cost', true);
      spendCash(draft, actor, cost); if (cost) ledger(draft, request, 'transport', -cost, { objectId: target.id });
      out.teleportRegionId = destination.id; break;
    }
    case 1139: {
      requireOwned(draft, target, request); const amount = money(f.amount);
      if (target.containerId !== actor.id || slot(target) === 0 || denom(target) <= amount) throw new ActionError('Cannot split that token amount', 6);
      const held = hand(draft, actor); if (held && held.classNumber !== 26) throw new ActionError('Your hand is occupied', 15);
      fTarget.denom -= amount; const cash = createCash(draft, actor, request, amount);
      out.cvObjectIds = cash.created ? [cash.item.id] : []; out.refresh = !cash.created;
      notice(out, target.id, 1141, { amount }); break;
    }
    case 2801: fTarget.balanceQueries = Math.min(65535, (fTarget.balanceQueries ?? 0) + 1); out.reply.balance = money(avatar.balance ?? 0, 'balance', true); notice(out, target.id, 2803, { actor: REF(actor.id) }); break;
    case 2806: {
      const amount = money(f.amount); const held = hand(draft, actor);
      if (!held || held.classNumber !== 26 || denom(held) < amount) throw new ActionError('Insufficient held tokens', 6);
      avatar.balance = money((avatar.balance ?? 0) + amount, 'balance', true); spendCash(draft, actor, amount);
      ledger(draft, request, 'deposit', amount, { objectId: target.id }); out.reply.amount = amount;
      notice(out, target.id, 2808, { actor: REF(actor.id), amount }); break;
    }
    case 2810: {
      const amount = money(f.amount); if ((avatar.balance ?? 0) < amount) throw new ActionError('Insufficient bank balance', 6);
      const cash = createCash(draft, actor, request, amount); avatar.balance -= amount;
      ledger(draft, request, 'withdrawal', -amount, { objectId: target.id });
      out.reply.amount = amount; out.reply.balance = avatar.balance; out.cvObjectIds = cash.created ? [cash.item.id] : [];
      notice(out, target.id, 2811, { actor: REF(actor.id), amount, cvsize: 0, contentsVector: [] }); out.refresh = cash.created; break;
    }
    case 2561: case 2565: {
      const held = hand(draft, actor); if (!held) throw new ActionError('Hold an item first', 3); requireOwned(draft, held, request); portable(held);
      const all: GameObject[] = []; const walk = (o: GameObject): void => { requireOwned(draft, o, request); all.push(o); children(draft, o.id).forEach(walk); }; walk(held);
      const raw = all.reduce((sum, o) => sum + money(o.fields?.salePrice ?? 0, 'price', true), 0);
      const markdown = integer(fTarget.markDown ?? 100, 0, 100, 'markdown');
      const appraisal = money(Math.floor(raw * markdown / 100), 'appraisal', true);
      out.reply.appraisal = appraisal; out.reply.numItems = all.length;
      if (request.id === 2565) {
        out.reply.item = REF(held.id); erase(draft, held);
        const cash = appraisal ? createCash(draft, actor, request, appraisal) : null;
        out.cvObjectIds = cash?.created ? [cash.item.id] : []; ledger(draft, request, 'pawn', appraisal, { objectId: target.id, soldObjectId: held.id }); out.refresh = true;
      } else notice(out, target.id, 2563, { actor: REF(actor.id) });
      break;
    }
    case 2671: {
      const forward = integer(f.forward, 0, 1, 'browse direction'), view = vendroidView(draft, target);
      if (!view.displayed) throw new ActionError('Sold out', 18);
      const at = view.entries.findIndex(entry => entry.item.id === view.displayed.id);
      const next = view.entries[(at + (forward ? 1 : view.entries.length - 1)) % view.entries.length];
      if (next.item.id !== view.displayed.id) {
        setContainerSlot(view.displayed, view.current); setContainerSlot(next.item, 0);
      }
      fTarget.currentSlot = next.logicalSlot; fTarget.price = money(next.item.fields?.salePrice ?? 0, 'price', true);
      out.reply.next_slot = next.logicalSlot; out.reply.available = view.entries.length;
      // A legacy layout or a single item has no corresponding pre-change slot
      // for the Tcl animation; the authoritative refresh supplies its view.
      if (!view.normalized && next.item.id !== view.displayed.id) notice(out, target.id, 2673, { actor: REF(actor.id), next_slot: out.reply.next_slot, available: out.reply.available });
      out.refresh = true; break;
    }
    case 2675: {
      const item = children(draft, target.id).find(o => slot(o) === integer(f.slot)); if (!item) throw new ActionError('Sold out', 18);
      const tree: GameObject[] = []; const collect = (object: GameObject): void => {
        if (object.ownerId != null && object.ownerId !== item.ownerId) throw new ActionError('Stock contains another owner\'s property', 16);
        tree.push(object); children(draft, object.id).forEach(collect);
      }; collect(item);
      const price = money(item.fields?.salePrice ?? 0, 'price', true);
      const held = hand(draft, actor);
      if (price === 0) emptyHand(draft, actor); else if (!held || held.classNumber !== 26 || denom(held) !== price) throw new ActionError('Present the exact price in tokens', 6);
      spendCash(draft, actor, price); place(draft, item, actor, 0, actor, request); tree.forEach(object => { object.ownerId = request.avatarId; });
      fieldsOf(item).common_flags = (item.fields.common_flags ?? 0) & ~2;
      if (target.ownerId != null && draft.avatars[target.ownerId]) draft.avatars[target.ownerId].balance = money(draft.avatars[target.ownerId].balance + price, 'seller balance', true);
      ledger(draft, request, 'purchase', -price, { objectId: item.id, sellerId: target.ownerId ?? null });
      vendroidView(draft, target); out.cvObjectIds = [item.id]; out.refresh = true; break;
    }
    case 2678: {
      requireOwned(draft, target, request); const held = hand(draft, actor); if (!held) throw new ActionError('Hold an item to stock', 3); requireOwned(draft, held, request); portable(held);
      const view = vendroidView(draft, target), used = new Set(view.entries.map(entry => entry.logicalSlot));
      let index = 1; while (index < capacity(target) && used.has(index)) index++;
      if (index >= capacity(target)) throw new ActionError('The vendroid is full', 15);
      const price = money(f.newPrice, 'price', true); fieldsOf(held).salePrice = price; held.fields.common_flags = (held.fields.common_flags ?? 0) | 2;
      if (view.displayed) setContainerSlot(view.displayed, view.current);
      place(draft, held, target, 0, actor, request); fTarget.currentSlot = index; fTarget.price = price;
      fTarget.fullSlots = children(draft, target.id).length;
      out.reply.next_slot = index; out.reply.available = fTarget.fullSlots;
      notice(out, target.id, 2680, { actor: REF(actor.id), item: REF(held.id), next_slot: index, available: out.reply.available, newPrice: price });
      out.refresh = true; break;
    }
    case 2682: {
      requireOwned(draft, target, request); emptyHand(draft, actor);
      const view = vendroidView(draft, target), held = view.displayed; if (!held) throw new ActionError('Sold out', 18);
      fieldsOf(held).common_flags = (held.fields.common_flags ?? 0) & ~2; place(draft, held, actor, 0, actor, request);
      const remaining = view.entries.filter(entry => entry.item.id !== held.id);
      const next = remaining.find(entry => entry.logicalSlot > view.current) ?? remaining[0];
      if (next) { setContainerSlot(next.item, 0); fTarget.currentSlot = next.logicalSlot; }
      vendroidView(draft, target);
      out.reply.next_slot = next?.logicalSlot ?? 65535; out.reply.available = remaining.length;
      notice(out, target.id, 2684, { actor: REF(actor.id), next_slot: out.reply.next_slot, available: out.reply.available });
      out.refresh = true; break;
    }
    default: return applyDocumentDevice(draft, request, actor, target, out) ?? applySpecialObject(draft, request, actor, target, out);
  }
  return out;
}

function applyDocumentDevice(draft: WorldState, request: TransactionRequest, actor: GameObject, target: GameObject, out: ActionResult) {
  const f = request.fields ?? {}, refs = request.refs ?? {}, data = fieldsOf(target);
  if (target.classNumber === 37) {
    const doc = document(draft, target, request); doc.pages ??= doc.text ? [doc.text] : []; doc.entries ??= [];
    const count = () => doc.pages!.length;
    const id = () => data.textid ??= target.id;
    switch (request.id) {
      case 2730: writable(draft, target, request); data.docOrient = integer(f.orient, 0, 2); notice(out, target.id, 2732, { orient: data.docOrient }); break;
      case 2720: data.docState = integer(f.state, 0, 2); out.reply.textid = data.textid ?? 0; notice(out, target.id, 2722, { state: data.docState }); break;
      case 2710: out.reply = { success: 0, owner: owns(draft, target, request) ? 1 : 0, max_size: doc.maxSize ?? 32000, size: doc.pages.join('\n').length, flags: doc.flags ?? 0, days_to_live: doc.daysToLive ?? 0, date: new Date(doc.updatedAt ?? request.now).toISOString(), author: doc.author ?? '', subject: doc.title ?? '' }; break;
      case 2712: case 2717:
        writable(draft, target, request); doc.title = string(f.subject ?? '', 255, 'subject'); doc.author = request.avatarName ?? ''; doc.maxSize = integer(f.max_size_allowed ?? 32000, 1, 32000); doc.daysToLive = integer(f.days_to_live ?? 0, 0, 36500); doc.updatedAt = request.now; break;
      case 2715: out.reply = { success: 0, owner: owns(draft, target, request) ? 1 : 0, num_entries: doc.entries.length, max_entries: 100, flags: doc.flags ?? 0, date: new Date(doc.updatedAt ?? request.now).toISOString(), author: doc.author ?? '', subject: doc.title ?? '' }; break;
      case 2735: out.reply.count = doc.entries.length; out.reply.contents = doc.entries.map(entry => `{{${String(draft.documents[entry]?.title ?? 'Document').replace(/[{}\\]/g, '')}} ${entry}}`).join(' '); break;
      case 2737: case 2740: writable(draft, target, request); out.reply.textid = id(); break;
      case 2771: {
        writable(draft, target, request); const page = integer(f.page, 0, 1000, 'page'), text = string(f.text ?? '', 32000);
        if (page > doc.pages.length) throw new ActionError('Page is out of range', 2);
        const previous = doc.pages[page] ?? ''; const total = doc.pages.join('').length - previous.length + text.length;
        if (total > (doc.maxSize ?? 32000)) throw new ActionError('Document size limit exceeded', 15);
        if (page === doc.pages.length && text && !(data.documentFlags & 4)) {
          if ((data.blank_page_count ?? 0) < 1) throw new ActionError('No blank pages', 6);
          data.blank_page_count--;
        }
        if (!text && page < doc.pages.length) { doc.pages.splice(page, 1); data.blank_page_count = (data.blank_page_count ?? 0) + 1; }
        else if (text) doc.pages[page] = text;
        doc.text = doc.pages.join('\n'); doc.updatedAt = request.now; doc.author = request.avatarName ?? ''; id();
        out.reply.doc_page_count = count(); out.reply.blank_page_count = data.blank_page_count ?? 0;
        notice(out, target.id, 2772, { doc_page_count: count(), blank_page_count: out.reply.blank_page_count }); break;
      }
      case 2781: {
        const page = integer(f.page, 0, 1000, 'page'); if (page > doc.pages.length) throw new ActionError('Page is out of range', 2);
        out.reply.page = page; out.reply.textid = id(); out.reply.text = doc.pages[page] ?? ''; break;
      }
      case 2761: {
        writable(draft, target, request); const page = integer(f.page, 0, doc.pages.length - 1, 'page'); const next = page + (f.up ? -1 : 1);
        if (next < 0 || next >= doc.pages.length) throw new ActionError('Page cannot move farther', 2);
        [doc.pages[page], doc.pages[next]] = [doc.pages[next], doc.pages[page]]; doc.text = doc.pages.join('\n'); doc.updatedAt = request.now; break;
      }
      case 2743: {
        writable(draft, target, request); const source = get(draft, refs.src); writable(draft, source, request); const srcDoc = document(draft, source, request);
        if (source.id === target.id || doc.entries.includes(source.id) || doc.entries.length >= 100) throw new ActionError('Invalid binder insertion', 2);
        doc.entries.push(source.id); source.containerId = null; source.regionId = target.regionId;
        // A binder index is a document collection, not a native container.
        // Class37 has capacity0, so archive its member rather than inventing
        // a physical child relationship the native class cannot represent.
        source.archivedIn = target.id; source.archivedFlags = source.fields.common_flags ?? 0;
        source.fields.common_flags = (source.fields.common_flags ?? 0) | 1;
        out.reply.count = doc.entries.length; out.reply.pages = f.keepblank ? 0 : source.fields.blank_page_count ?? 0;
        if (!f.keepblank) { data.blank_page_count = (data.blank_page_count ?? 0) + out.reply.pages; source.fields.blank_page_count = 0; }
        srcDoc.updatedAt = request.now; out.refresh = true; break;
      }
      case 2747: {
        writable(draft, target, request); emptyHand(draft, actor); const entry = integer(f.entry, 0, doc.entries.length - 1, 'entry');
        const source = get(draft, doc.entries[entry]); doc.entries.splice(entry, 1);
        source.fields.common_flags = source.archivedFlags ?? ((source.fields.common_flags ?? 0) & ~1);
        delete source.archivedIn; delete source.archivedFlags;
        place(draft, source, actor, 0, actor, request);
        out.reply.slot = slot(target); out.cvObjectIds = [source.id]; out.refresh = true; break;
      }
      case 2724: {
        writable(draft, target, request); const entry = integer(f.entry, 0, doc.entries.length - 1, 'entry');
        const source = get(draft, doc.entries[entry]); requireOwned(draft, source, request);
        doc.entries.splice(entry, 1); erase(draft, source); doc.updatedAt = request.now; out.refresh = true; break;
      }
      case 2791: {
        writable(draft, target, request); const pages = integer(f.pages, 1, data.blank_page_count ?? 0, 'pages');
        const held = hand(draft, actor); if (held && held.id !== target.id) throw new ActionError('Your hand is occupied', 15);
        let index = 999;
        if (held?.id === target.id) { index = emptySlot(draft, actor, 4); place(draft, target, actor, index, actor, request); }
        data.blank_page_count -= pages;
        const newDoc = create(draft, { classNumber: 37, fields: { ...data, name: 'Blank pages', textid: 0, blank_page_count: pages, blank_page_max: Math.max(pages, data.blank_page_max ?? 100), position: [0, 0, 0] } }, actor, request);
        place(draft, newDoc, actor, 0, actor, request); document(draft, newDoc, request);
        out.reply.slot = index; out.reply.pages = pages; out.cvObjectIds = [newDoc.id]; out.refresh = true; break;
      }
      case 2796: {
        const source = get(draft, refs.src), destination = get(draft, refs.dest); writable(draft, source, request); writable(draft, destination, request);
        if (source.classNumber !== 37 || destination.classNumber !== 37 || source.id === destination.id) throw new ActionError('Invalid page destination', 2);
        const pages = integer(f.pages, 1, source.fields.blank_page_count ?? 0, 'pages');
        if ((destination.fields.blank_page_count ?? 0) + pages > (destination.fields.blank_page_max ?? 100)) throw new ActionError('Destination cannot hold these pages', 15);
        source.fields.blank_page_count -= pages; destination.fields.blank_page_count = (destination.fields.blank_page_count ?? 0) + pages;
        out.reply = { success: 0, src: REF(source.id), dest: REF(destination.id), pages, destroy: 0 };
        notice(out, target.id, 2798, out.reply); break;
      }
      case 2751: writable(draft, target, request); data.documentFlags = (data.documentFlags ?? 0) ^ 8; break;
      default: return null;
    }
    return out;
  }
  switch (request.id) {
    case 4353: {
      const master = get(draft, refs.master); requireOwned(draft, master, request); if (master.classNumber !== 37) throw new ActionError('Master must be a document', 2);
      if (inSlot(draft, target, 0)) throw new ActionError('Master slot is occupied', 15);
      place(draft, master, target, 0, actor, request); notice(out, target.id, 4355, { master: REF(master.id), actor: REF(actor.id) }); break;
    }
    case 4357: {
      const master = inSlot(draft, target, 0); if (!master) throw new ActionError('No master', 3); requireOwned(draft, master, request); emptyHand(draft, actor);
      place(draft, master, actor, 0, actor, request); notice(out, target.id, 4359, { master: REF(master.id), actor: REF(actor.id) }); break;
    }
    case 4361: {
      const master = inSlot(draft, target, 0); if (!master || master.classNumber !== 37) throw new ActionError('No document master', 3);
      const copies = integer(f.copies, 1, 1, 'copies'); const cost = money(data.cost ?? 0, 'printing cost', true);
      const held = hand(draft, actor); if (cost ? (!held || held.classNumber !== 26 || denom(held) !== cost * copies) : Boolean(held)) throw new ActionError('Present exact printing cost with an otherwise empty hand', 6);
      spendCash(draft, actor, cost * copies);
      const copy = create(draft, { ...structuredClone(master), ownerId: request.avatarId, containerId: null, portable: true,
        fields: { ...master.fields, common_flags: (master.fields.common_flags ?? 0) & ~2 } }, actor, request);
      place(draft, copy, actor, 0, actor, request); draft.documents[copy.id] = { ...structuredClone(document(draft, master, request)), objectId: copy.id, updatedAt: request.now };
      out.cvObjectIds = [copy.id]; out.refresh = true; if (cost) ledger(draft, request, 'printing', -cost, { objectId: target.id }); break;
    }
    case 4303: {
      const source = get(draft, refs.target); requireOwned(draft, source, request); if (source.classNumber !== 37) throw new ActionError('Only documents can be recycled', 2);
      const doc = document(draft, source, request); const pages = Math.max(1, (source.fields.blank_page_count ?? 0) + (doc.pages?.length ?? 0));
      data.mulched_pages = integer((data.mulched_pages ?? 0) + pages, 0, 65535, 'mulched pages'); out.reply.pages = pages; erase(draft, source); out.refresh = true; break;
    }
    case 4311: {
      const pages = integer(f.pages, 1, 65535, 'pages'); const cost = Math.max(2, data.cost ?? 2);
      if (pages * cost > (data.mulched_pages ?? 0)) throw new ActionError('Not enough recycled pages', 6);
      emptyHand(draft, actor); data.mulched_pages -= pages * cost;
      const paper = create(draft, { classNumber: 37, fields: { name: 'Blank pages', blank_page_count: pages, blank_page_max: Math.max(100, pages), docState: 0, docOrient: 2 } }, actor, request);
      place(draft, paper, actor, 0, actor, request); document(draft, paper, request); out.cvObjectIds = [paper.id]; out.refresh = true; break;
    }
    default: return null;
  }
  return out;
}

function exactCash(draft: WorldState, actor: GameObject, cost: number) {
  money(cost, 'cost', true);
  const held = hand(draft, actor);
  if (cost > 0 && (!held || held.classNumber !== 26 || denom(held) !== cost)) throw new ActionError('Present the exact token amount', 6);
  if (cost === 0 && held) throw new ActionError('Your hand must be empty', 15);
  spendCash(draft, actor, cost);
}
function parcelPostage(draft: WorldState, item: GameObject) {
  if (!item) return 0;
  let amount = 5;
  // Recovered 000c000b.tcl: a Container costs five plus five per usable
  // container slot and recursively includes each contained item's postage.
  if (item.classNumber === 36) amount += 5 * capacity(item) + children(draft, item.id).reduce((n, child) => n + parcelPostage(draft, child), 0);
  return money(amount, 'postage', true);
}
function clonePrize(draft: WorldState, source: GameObject, actor: GameObject, request: TransactionRequest) {
  const copy = create(draft, { ...structuredClone(source), containerId: null, ownerId: request.avatarId, portable: true,
    fields: { ...source.fields, common_flags: (source.fields.common_flags ?? 0) & ~2 } }, actor, request);
  delete copy.pendingSale; delete copy.archivedIn;
  if (source.classNumber === 37) draft.documents[copy.id] = { ...structuredClone(document(draft, source, request)), objectId: copy.id };
  if (children(draft, source.id).length) throw new ActionError('Prize copies must not contain nested objects', 16);
  place(draft, copy, actor, 0, actor, request); return copy;
}
function applySpecialObject(draft: WorldState, request: TransactionRequest, actor: GameObject, target: GameObject, out: ActionResult) {
  const f = request.fields ?? {}, refs = request.refs ?? {}, data = fieldsOf(target), avatar = draft.avatars[request.avatarId];
  switch (request.id) {
    case 30: {
      if (f.unused !== undefined) integer(f.unused, 0, 255, 'unused');
      if (target.classNumber === 56) {
        const region = draft.regions[actor.regionId], housing = region?.properties?.housing;
        const owners = [housing?.ownerId, ...(housing?.coOwnerIds ?? []), region?.properties?.ownerId, ...(region?.properties?.coOwnerIds ?? [])];
        if (!request.admin && !['admin', 'builder'].includes(avatar.role) && !owns(draft, target, request) && !owners.includes(avatar.id))
          throw new ActionError('Connection configuration requires ownership or a builder', 16);
        const config = target.properties?.connection ?? target.properties ?? {};
        out.reply = { success: 0, dummyfielda: 0, address: string(config.address ?? '', 128, 'address'),
          aliases0: string(config.aliases0 ?? '', 255, 'alias'), aliases1: string(config.aliases1 ?? '', 255, 'alias'),
          aliases2: string(config.aliases2 ?? '', 255, 'alias'), aliases3: string(config.aliases3 ?? '', 255, 'alias'),
          aliases4: string(config.aliases4 ?? '', 255, 'alias'), secret_address: integer(config.secret_address ?? 0, 0, 1),
          areaCode: integer(config.areaCode ?? 0, 0, 65535) };
        break;
      }
      requireOwned(draft, target, request);
      const deposits = draft.ledger.filter(e => e.objectId === target.id && e.kind === 'deposit' && e.id >= (target.statisticsSince ?? 0));
      const withdrawals = draft.ledger.filter(e => e.objectId === target.id && e.kind === 'withdrawal' && e.id >= (target.statisticsSince ?? 0));
      out.reply = { success: 0, num_balances: integer(data.balanceQueries ?? 0, 0, 65535), num_deposits: Math.min(deposits.length, 65535), num_withdrawals: Math.min(withdrawals.length, 65535),
        deposits: Math.min(0xffffffff, deposits.reduce((n,e) => n + Math.abs(e.amount), 0)), withdrawals: Math.min(0xffffffff, withdrawals.reduce((n,e) => n + Math.abs(e.amount), 0)) }; break;
    }
    case 3301: {
      const body = integer(f.body, 0, 7, 'body style');
      const image = data[`bodyURL${body}`] ?? target.properties?.bodies?.[body]?.imageURL;
      if (typeof image !== 'string' || !image.length || image.length > 31) throw new ActionError('Body style is not configured', 7);
      const cost = money(data[`bodycost${body}`] ?? 0, 'body cost', true); exactCash(draft, actor, cost);
      const a = fieldsOf(actor); a.imageURL = image; a.imageDefault = integer(data[`bodyDefault${body}`] ?? 0); a.bodyStyle = body;
      notice(out, target.id, 3302, { actor: REF(actor.id), body, cost }); if (cost) ledger(draft, request, 'body-change', -cost, { objectId: target.id }); out.refresh = true; break;
    }
    case 3304: {
      requireOwned(draft, target, request); const body = integer(f.body, 0, 7, 'body style');
      data[`bodyURL${body}`] = string(f.URL ?? '', 31, 'image URL'); data[`bodyname${body}`] = string(f.name ?? '', 31, 'body name');
      data[`bodycost${body}`] = integer(f.cost ?? 0); data[`bodyDefault${body}`] = integer(f.defaultImage ?? 0);
      data.operateOrientation = integer(f.operateOrientation ?? 0, 0, 3); out.refresh = true; break;
    }
    case 3313: requireOwned(draft, target, request); data.common_flags = (data.common_flags ?? 0) | 64; notice(out, target.id, 3314, { actor: REF(actor.id) }); out.refresh = true; break;
    case 2815: {
      requireOwned(draft, target, request); const orientation = integer(f.operateOrientation, 0, 65535, 'orientation');
      if (orientation !== 65535) data.operateOrientation = integer(orientation, 0, 3, 'orientation');
      if (f.reset) { target.statisticsSince = draft.next.transaction; data.balanceQueries = 0; }
      break;
    }
    case 2131: {
      requireOwned(draft, target, request); const state = integer(f.state, 0, 1, 'magic state');
      data.common_flags = ((data.common_flags ?? 0) & ~64) | (state ? 0 : 64); notice(out, target.id, 2132, { actor: REF(actor.id), state }); break;
    }
    case 2134: {
      requireOwned(draft, target, request); const subject = get(draft, refs.target); requireOwned(draft, subject, request);
      if (data.common_flags & 64) throw new ActionError('Magic object is inactive', 7);
      const effect = target.properties?.effect;
      if (!effect || !['color', 'visibility', 'teleport'].includes(effect.type)) throw new ActionError('No supported magic effect is configured', 7);
      if (effect.type === 'color') {
        if (!Array.isArray(effect.colors) || effect.colors.length !== 16) throw new ActionError('Invalid configured magic colors', 7);
        subject.fields.colorMap = effect.colors.map((x: unknown) => integer(x, 0, 255));
      } else if (effect.type === 'visibility') subject.fields.common_flags = ((subject.fields.common_flags ?? 0) & ~1) | (effect.hidden ? 1 : 0);
      else {
        if (subject.id !== actor.id) throw new ActionError('Teleport magic only affects its user', 16);
        const region = draft.regions[effect.regionId]; if (!region) throw new ActionError('Magic destination is unavailable', 3);
        if (request.canEnterRegion && request.canEnterRegion(region.id) !== true) throw new ActionError('You cannot enter that region', 16);
        out.teleportRegionId = region.id;
      }
      if (data.charges > 0) data.charges--; out.refresh = true;
      // Recovered notice2135 contains executable Tcl; this local implementation
      // applies data mutations and refreshes, never executes server-provided code.
      break;
    }
    case 4407: {
      requireOwned(draft, target, request); const master = get(draft, refs.master); requireOwned(draft, master, request);
      if (master.classNumber !== 37) throw new ActionError('News master must be a document', 2);
      target.properties ??= {}; target.properties.masterId = master.id; break;
    }
    case 4403: {
      const master = get(draft, target.properties?.masterId); if (master.classNumber !== 37) throw new ActionError('No newspaper master', 7);
      const cost = money(data.price ?? target.properties?.price ?? 0, 'newspaper price', true); exactCash(draft, actor, cost);
      const copy = clonePrize(draft, master, actor, request); out.cvObjectIds = [copy.id]; out.refresh = true;
      if (cost) ledger(draft, request, 'newspaper', -cost, { objectId: target.id }); break;
    }
    case 4453: {
      const item = hand(draft, actor); if (!item) throw new ActionError('Hold an object to post', 3); requireOwned(draft, item, request); portable(item);
      const checkTree = (object: GameObject): void => { requireOwned(draft, object, request); children(draft, object.id).forEach(checkTree); }; checkTree(item);
      const recipient = Object.values(draft.avatars).find(a => a.name.toLowerCase() === string(f.address, 256, 'recipient').trim().toLowerCase());
      if (!recipient) throw new ActionError('Recipient does not exist', 3);
      const text = string(f.contents ?? '', 32000, 'label'); const postage = parcelPostage(draft, item);
      if (Number(f.postage) !== postage) throw new ActionError('Postage has changed', 6);
      if (postage) {
        const pocket = inSlot(draft, actor, 2); if (!pocket || pocket.classNumber !== 26 || denom(pocket) < postage) throw new ActionError('Insufficient pocket tokens for postage', 6);
        pocket.fields.denom -= postage; if (!pocket.fields.denom) erase(draft, pocket);
      }
      const id = draft.next.message++;
      draft.mail[id] = { id, fromId: request.avatarId, toId: recipient.id, subject: 'Parcel', body: text, createdAt: request.now, readAt: null, objectId: item.id, deliveredAt: null };
      recipient.mailbox.push(id); item.archivedIn = target.id; item.archivedFlags = item.fields.common_flags ?? 0;
      item.containerId = null; item.fields.common_flags = (item.fields.common_flags ?? 0) | 1;
      const reown = (object: GameObject): void => { object.ownerId = recipient.id; children(draft, object.id).forEach(reown); }; reown(item);
      if (postage) ledger(draft, request, 'postage', -postage, { objectId: target.id }); out.refresh = true; break;
    }
    case 4457: {
      emptyHand(draft, actor);
      const pending = avatar.mailbox.map(id => draft.mail[id]).filter(m => m?.objectId && !m.deliveredAt);
      const mail = pending[0]; if (!mail) throw new ActionError('There is no parcel addressed to you', 3);
      const item = get(draft, mail.objectId); item.fields.common_flags = item.archivedFlags ?? ((item.fields.common_flags ?? 0) & ~1);
      delete item.archivedIn; delete item.archivedFlags; place(draft, item, actor, 0, actor, request);
      mail.deliveredAt = request.now; mail.readAt ??= request.now;
      out.reply.sender = draft.avatars[mail.fromId]?.name ?? 'Unknown'; out.reply.contents = mail.body;
      out.reply.numItems = pending.length - 1; out.cvObjectIds = [item.id]; out.refresh = true; break;
    }
    case 2920: out.reply.names = Object.values(draft.avatars).map(a => a.name).sort().join(', '); break;
    case 2924: {
      const name = string(f.name, 29, 'name').trim(); if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(name)) throw new ActionError('Invalid avatar name', 2);
      if (Object.values(draft.avatars).some(a => a.id !== avatar.id && a.name.toLowerCase() === name.toLowerCase())) throw new ActionError('That name is already in use');
      const cost = money(target.properties?.registrationCost ?? data.cost ?? 0, 'registration cost', true); exactCash(draft, actor, cost);
      avatar.name = name; fieldsOf(actor).name = name; actor.fields.nameChanges = Math.min(255, (actor.fields.nameChanges ?? 0) + 1);
      notice(out, target.id, 2925, { actor: REF(actor.id), free: cost === 0 ? 1 : 0, name });
      if (cost) ledger(draft, request, 'registration', -cost, { objectId: target.id }); out.refresh = true; break;
    }
    case 4501: {
      available(draft, target, actor, request); const hidden = integer(f.hidden ?? 0, 0, 3, 'hidden mode');
      const dice = integer(data.num_dice || 1, 1, 20, 'dice count'); const sides = integer(data.die_sides || 6, 1, 1000, 'die sides');
      const offset = integer(data.offset ?? 0); if (dice * sides + offset > 65535) throw new ActionError('Configured dice exceed the result field', 7);
      const random = request.randomInt ?? randomInt;
      data.hidden = hidden; target.randomResult = offset + Array.from({ length: dice }, () => random(1, sides + 1)).reduce((a,b) => a+b, 0);
      target.lastRollerId = request.avatarId; data.public_value = hidden & 2 ? 0 : target.randomResult;
      out.reply.result = hidden & 1 ? 0 : target.randomResult;
      notice(out, target.id, 4503, { hidden, result: hidden & 2 ? 0 : target.randomResult }); break;
    }
    case 4505: {
      available(draft, target, actor, request); if (!Number.isInteger(target.randomResult)) throw new ActionError('Roll first', 2);
      if (target.lastRollerId !== request.avatarId && !owns(draft, target, request)) throw new ActionError('Only the roller or owner may reveal the result', 16);
      const audience = integer(f.to_who, 1, 3, 'audience'); data.hidden = (data.hidden ?? 0) & ~audience;
      data.public_value = data.hidden & 2 ? 0 : target.randomResult;
      out.reply.hidden = data.hidden; out.reply.result = data.hidden & 1 ? 0 : target.randomResult;
      notice(out, target.id, 4507, { hidden: data.hidden, result: data.public_value }); break;
    }
    case 5101: {
      available(draft, target, actor, request); data.choreState = data.choreState ? 0 : 1;
      notice(out, target.id, 5103, { success: 0 }); break;
    }
    case 5605: {
      const which = integer(f.which ?? 0, 0, 100, 'presentation'); target.properties ??= {}; const banner = target.properties.banner ??= { text: '', presentations: {} };
      out.reply.text = which ? (banner.presentations?.[which]?.text ?? '') : banner.text;
      out.reply.currentAd = banner.currentAd ?? 0; out.reply.timeLeft = data.interval ?? 30;
      out.reply.limitprop = banner.presentations?.[which]?.limitprop ?? ''; out.reply.limit = String(banner.presentations?.[which]?.limit ?? 0); break;
    }
    case 5621: {
      requireOwned(draft, target, request); target.properties ??= {}; const banner = target.properties.banner ??= { text: '', presentations: {} };
      const which = integer(f.which, 0, 100), text = string(f.text ?? '', 32000); data.interval = integer(f.interval, 1, 86400, 'interval');
      if (!which) banner.text = text; else banner.presentations[which] = { text, autostart: Boolean(f.autostart), limitprop: string(f.limitprop ?? '', 128), limit: integer(f.limit ?? 0, 0, 0xffffffff) };
      out.refresh = true; break;
    }
    case 5631: requireOwned(draft, target, request); data.banner_flags = integer(f.state); out.refresh = true; break;
    case 5675: {
      const index = integer(f.slot, 0, capacity(target) - 1, 'prize slot'); emptyHand(draft, actor);
      const template = inSlot(draft, target, index); if (!template) throw new ActionError('This prize is unavailable', 18);
      target.properties ??= {}; const received = target.properties.prizeCounts ??= {}; const key = `${request.avatarId}:${index}`;
      const maximum = target.properties.banner?.presentations?.[index + 1]?.limit ?? 0;
      if (maximum && (received[key] ?? 0) >= maximum) throw new ActionError('You have received your limit', 5);
      const copy = clonePrize(draft, template, actor, request); received[key] = (received[key] ?? 0) + 1; out.cvObjectIds = [copy.id]; out.refresh = true; break;
    }
    case 5678: {
      requireOwned(draft, target, request); const item = hand(draft, actor); if (!item) throw new ActionError('Hold an item to stock', 3); requireOwned(draft, item, request);
      const index = integer(f.slot, 0, capacity(target) - 1, 'prize slot'); place(draft, item, target, index, actor, request); item.fields.common_flags = (item.fields.common_flags ?? 0) | 2;
      out.reply.next_slot = index; out.refresh = true; break;
    }
    case 5682: {
      requireOwned(draft, target, request); emptyHand(draft, actor);
      const item = inSlot(draft, target, integer(f.slot, 0, capacity(target) - 1, 'prize slot')); if (!item) throw new ActionError('Prize is missing', 3);
      item.fields.common_flags = (item.fields.common_flags ?? 0) & ~2; place(draft, item, actor, 0, actor, request); out.refresh = true; break;
    }
    case 9908: {
      const item = get(draft, refs.target); requireOwned(draft, item, request); const name = string(f.name, 31, 'engraving').trim(); if (!name) throw new ActionError('Engraving is empty', 2);
      const cost = money(target.properties?.cost ?? data.cost ?? 0, 'engraving cost', true);
      if (cost) exactCash(draft, actor, cost); else emptyHand(draft, actor, item.id);
      item.fields.name = name; place(draft, item, actor, 0, actor, request); notice(out, item.id, 28, { newName: name });
      if (cost) ledger(draft, request, 'engraving', -cost, { objectId: target.id }); break;
    }
    case 1681: case 1683: case 1686: case 1699: {
      if (!request.admin) throw new ActionError('Staff administrator permission is required', 16);
      const profile = Object.values(draft.avatars).find(value => value.objectId === target.id);
      if (!profile) throw new ActionError('Target is not a player avatar', 3);
      if ([1681, 1683].includes(request.id) && refs.target !== target.id) throw new ActionError('Target does not match the request receiver', 2);
      if (request.id === 1681) {
        const level = integer(f.perm_level, 0, 65535, 'permission level');
        profile.permissionLevel = level;
        profile.role = level >= 3000 ? 'admin' : level >= 2000 ? 'builder' : 'player';
        out.permissionAvatarId = profile.id; out.permissionLevel = level;
      } else if (request.id === 1683) {
        const type = integer(f.type, 0, 0xffffffff, 'avatar image type');
        fieldsOf(target).imageDefault = type;
        notice(out, target.id, 1684, { target: REF(target.id), type });
        out.refresh = true;
      } else if (request.id === 1686) {
        out.kickAvatarIds = [profile.id];
      } else {
        // The native command displays fail_msg on success for this contract.
        const account = request.targetAccountName ?? `#${profile.accountId}`;
        out.reply.fail_msg = `${profile.name} belongs to account ${account}.`;
      }
      break;
    }
    case 3101: case 3114: case 3116: case 3117: case 3106: case 3107: case 1701: case 1703: {
      if (!request.admin) throw new ActionError('Staff permission is required', 16);
      const name = String(f.avatar_name ?? f.avatar ?? '');
      const profile = Object.values(draft.avatars).find(a => a.name.toLowerCase() === name.toLowerCase() || ([1701, 1703].includes(request.id) && a.objectId === target.id));
      if (request.id === 3106 || request.id === 3107) {
        const region = regionByAddress(draft, string(f.address, 128, 'address'));
        if (!region) throw new ActionError('Destination does not exist', 3);
        if (request.id === 3106) {
          if (request.canEnterRegion && request.canEnterRegion(region.id) !== true) throw new ActionError('You cannot enter that region', 16);
          out.teleportRegionId = region.id;
        } else {
          if (!profile || (request.onlineAvatarIds && !request.onlineAvatarIds.includes(profile.id))) throw new ActionError('Avatar is offline', 3);
          out.moveAvatarId = profile.id; out.moveAvatarRegionId = region.id;
        }
      } else if (request.id === 3116) {
        if (!request.targetAccountId) throw new ActionError('Account does not exist', 3);
        const days = integer(f.days, 0, 36500, 'days'); const profiles = Object.values(draft.avatars).filter(a => a.accountId === request.targetAccountId);
        draft.accountBans ??= {};
        draft.accountBans[request.targetAccountId] = { until: days ? request.now + days * 86400000 : Number.MAX_SAFE_INTEGER, reason: 'Staff account ban' };
        out.kickAvatarIds = profiles.map(p => p.id);
        for (const p of profiles) { p.preferences ??= {}; p.preferences.bannedUntil = days ? request.now + days * 86400000 : Number.MAX_SAFE_INTEGER; }
      } else {
        if (!profile) throw new ActionError('Avatar does not exist', 3);
        profile.preferences ??= {};
        if (request.id === 3101) {
          if (request.onlineAvatarIds && !request.onlineAvatarIds.includes(profile.id)) throw new ActionError('Avatar is offline', 3);
          out.summonAvatarId = profile.id;
        }
        if (request.id === 3117) {
          if (request.canEnterRegion && request.canEnterRegion(profile.regionId) !== true) throw new ActionError('You cannot enter that region', 16);
          out.teleportRegionId = profile.regionId;
        }
        if (request.id === 3114) { const days = integer(f.days, 0, 36500, 'days'); profile.preferences.bannedUntil = days ? request.now + days * 86400000 : Number.MAX_SAFE_INTEGER; out.kickAvatarIds = [profile.id]; }
        if (request.id === 1701 || request.id === 1703) {
          const duration = integer(f.howlong, 0, 0xffffffff, 'duration');
          profile.preferences[request.id === 1701 ? 'mutedUntil' : 'frozenUntil'] = duration ? request.now + duration * 1000 : 0;
        }
      }
      break;
    }
    default: return null;
  }
  return out;
}

function transformReferences(value: SchemaValue, context: ActionContext): SchemaValue {
  if (value && typeof value === 'object' && '$objectRef' in value) return context.ref ? context.ref(value.$objectRef) : value.$objectRef;
  if (Array.isArray(value)) return value.map(x => transformReferences(x, context));
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transformReferences(item, context)]));
  return value;
}

/**
 * Decode/resolve a room-local request, commit one authoritative mutation, then
 * publish replies and notices. A successful reply must never precede disk commit.
 */
export class ObjectActions {
  readonly context: ActionContext;
  constructor(context: ActionContext) { this.context = context; }
  async handle(session: ActionSession, message: NativeActionRequest) {
    const contract = contracts.get(message.id); if (!contract) return false;
    const context = this.context;
    const object = message.object ?? context.resolveObject(session, message.noid);
    const actor = context.actorObject(session);
    const replyId = replyIdForObjectRequest(message.id, object?.classNumber);
    try {
      if (!object || !actor) throw new ActionError('Object is missing', 3);
      let fields;
      try { fields = message.fields ?? context.registry.decodeMessage(message.id, message.payload!); }
      catch (error) { if (error instanceof SchemaError) throw new ActionError('Malformed request fields', 2); throw error; }
      // Resolve client noids once at the boundary. Pure evaluators below receive
      // stable world IDs and cannot make a foreign room object addressable.
      const refs: Record<string, number | undefined> = {};
      for (const key of ['item', 'container', 'indirect', 'target', 'target_noid', 'src', 'dest', 'master']) {
        if (Number.isInteger(fields[key]) && fields[key] !== 65535) refs[key] = context.resolveObject(session, fields[key])?.id;
      }
      const result = context.worldStore.transaction(draft => {
        const outcome = applyObjectAction(draft, {
          id: message.id, fields, refs, objectId: object.id, actorId: actor.id, avatarId: session.avatar.id,
          avatarName: context.worldStore.getAvatar(session.avatar.id)?.name ?? session.avatar.name,
          admin: typeof context.isAdmin === 'function' ? Boolean(context.isAdmin(session)) : context.worldStore.getAvatar(session.avatar.id)?.role === 'admin',
          targetAccountId: message.id === 3116 ? context.accountForName?.(fields.user)?.id : null,
          targetAccountName: message.id === 1699 ? context.accountForName?.(context.worldStore.snapshot().avatars[object.ownerId ?? -1]?.name)?.name : undefined,
          onlineAvatarIds: Array.from(context.sessions?.values?.() ?? context.sessions ?? []).map(s => s.avatar?.id).filter(Boolean),
          canEnterRegion: context.canEnterRegion ? regionId => context.canEnterRegion(session, regionId) === true : undefined,
          now: context.now?.() ?? Date.now(),
        });
        if (outcome?.teleportRegionId != null) {
          if (typeof context.moveActorInDraft === 'function') {
            if (typeof context.publishTravel !== 'function') throw new ActionError('Region travel publication is unavailable');
            outcome.travelTransition = context.moveActorInDraft(draft, session, outcome.teleportRegionId);
          } else if (typeof context.teleport !== 'function') throw new ActionError('Region travel is unavailable');
        }
        return outcome;
      }, { actorId: session.avatar.id, action: `object-request-${message.id}`, details: { objectId: object.id } });
      if (!result) return false;
      const reply = transformReferences(result.reply, context);
      if (result.cvObjectIds) {
        const cvObjects = result.cvObjectIds.map(id => context.worldStore.getObject(id)).filter((item): item is GameObject => item !== null);
        const cv = await context.contentsVector(session, cvObjects);
        reply.contentsVector = cv; reply.cvsize = cv.length;
      }
      await context.reply(session, message.noid, result.replyId, reply);
      for (const n of result.notices) {
        const body = transformReferences(n.fields, context);
        if (context.broadcastObject) await context.broadcastObject(actor.regionId, n.targetId, n.id, body, session);
        else await context.broadcast(actor.regionId, context.objectNoid(session, n.targetId), n.id, body, session);
      }
      if (result.permissionAvatarId != null) {
        // Notice1682 mutates the receiving client's global permission level;
        // deliver it only to the avatar whose authority changed.
        for (const recipient of context.sessions?.values?.() ?? context.sessions ?? []) {
          if (recipient.closed || recipient.avatar?.id !== result.permissionAvatarId) continue;
          const recipientActor = context.actorObject(recipient);
          await context.reply(recipient, context.objectNoid(recipient, recipientActor), 1682, { perm_level: result.permissionLevel });
          await context.refreshSession?.(recipient);
        }
      }
      if (result.travelTransition) await context.publishTravel(session, result.travelTransition);
      else if (result.teleportRegionId != null) await context.teleport(session, result.teleportRegionId);
      else if (result.refresh) await context.refreshRegion(actor.regionId);
      if (result.summonAvatarId != null || result.moveAvatarId != null || result.kickAvatarIds) {
        for (const other of context.sessions?.values?.() ?? context.sessions ?? []) {
          if (other.avatar?.id === result.summonAvatarId) await context.teleport(other, actor.regionId);
          if (other.avatar?.id === result.moveAvatarId) await context.teleport(other, result.moveAvatarRegionId!);
          if (result.kickAvatarIds?.includes(other.avatar?.id)) other.end?.();
        }
      }
      return true;
    } catch (error) {
      if (!(error instanceof ActionError)) throw error;
      const profile = context.worldStore.getAvatar?.(session.avatar?.id);
      const failure = replyId === 1206 ? { success: error.code, dummyfielda: 0, address: '', aliases0: '', aliases1: '', aliases2: '', aliases3: '', aliases4: '', secret_address: 0, areaCode: 0 }
        : { success: error.code, fail_msg: error.message, fail_URL: '', balance: profile?.balance ?? 0, contentsVector: Buffer.alloc(0), cvsize: 0 };
      await context.reply(session, message.noid, replyId ?? contract.replyId, failure);
      return true;
    }
  }
}
