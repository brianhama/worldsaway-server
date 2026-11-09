import type { DynamicFields, NativeFields, GameObject, RegionRecord, WorldState, TimerRecord } from './types.js';
import type { ActionContext, ActionSession, NativeActionRequest, TransactionRequest, ActionResult, RequestContract, SchemaValue } from './action-types.js';
import { randomInt } from 'node:crypto';
import { encodeClientString } from './classes.js';

export class SpecialActionError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) { super(message); this.code = code; }
}

const contract = (id: number, replyId: number, classNumber: number, name: string) => Object.freeze({ id, replyId, classNumbers: Object.freeze([classNumber]), name });
export const SUPPORTED_REQUESTS = Object.freeze([
  contract(20010, 70, 200, 'talk to NPC'),
  contract(20103, 20104, 201, 'pet owner'), contract(20105, 70, 201, 'adopt pet'),
  contract(20302, 20304, 203, 'drink potion'), contract(20404, 70, 204, 'set bus routes'),
  contract(20502, 20503, 205, 'cashier bill'), contract(20504, 70, 205, 'cashier payment'),
  contract(20904, 20905, 209, 'portkey settings'), contract(20906, 70, 209, 'configure portkey'), contract(20907, 70, 209, 'use portkey'),
  contract(21004, 21005, 210, 'play slot machine'), contract(21006, 21007, 210, 'slot machine settings'),
  contract(21009, 70, 210, 'configure slot machine'), contract(21010, 70, 210, 'unload slot machine'), contract(21012, 70, 210, 'load slot machine'),
  contract(21304, 21305, 213, 'play spinner'), contract(21306, 21307, 213, 'spinner settings'),
  contract(21309, 70, 213, 'configure spinner'), contract(21310, 70, 213, 'unload spinner'), contract(21312, 70, 213, 'load spinner'),
  contract(21503, 21506, 215, 'hide or reveal decoration'), contract(21505, 21508, 215, 'list hidden decorations'),
]);
const contracts = new Map(SUPPORTED_REQUESTS.map(item => [item.id, item]));
const MAX_MONEY = 0x7fffffff;
const REF = (id: number) => ({ $objectRef: id });
const all = (draft: WorldState) => Object.values(draft.objects);
const children = (draft: WorldState, object: GameObject) => all(draft).filter(item => item.containerId === object.id);
const slot = (object: GameObject) => object.slot ?? object.fields?.position?.[0] ?? 0;
const inSlot = (draft: WorldState, container: GameObject, index: number) => children(draft, container).find(item => slot(item) === index) ?? null;
const held = (draft: WorldState, actor: GameObject) => inSlot(draft, actor, 0);
const f = (object: { fields: NativeFields }) => object.fields ??= {};

function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new SpecialActionError(`Invalid ${name}`, 2);
  return value;
}
function text(value: unknown, maximum: number, name = 'text') {
  if (typeof value !== 'string' || value.length > maximum || /[\0\x01-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new SpecialActionError(`Invalid ${name}`, 2);
  try { encodeClientString(value); } catch { throw new SpecialActionError(`${name} contains unsupported client text`, 2); }
  return value;
}
function get(draft: WorldState, id: number | undefined) { const object = id === undefined ? undefined : draft.objects[id]; if (!object) throw new SpecialActionError('Object is missing', 3); return object; }
function owned(object: GameObject, request: TransactionRequest) { return request.admin || object.ownerId === request.avatarId; }
function requireOwned(object: GameObject, request: TransactionRequest) { if (!owned(object, request)) throw new SpecialActionError('You do not own this device', 16); }
function available(draft: WorldState, object: GameObject, actor: GameObject, request: TransactionRequest) {
  if (object.regionId !== actor.regionId || object.deleted || object.archivedIn) throw new SpecialActionError('Object is not available here', 3);
  let parent = object; const seen = new Set();
  while (parent.containerId !== null && parent.containerId !== undefined) {
    if (seen.has(parent.id)) throw new SpecialActionError('Container cycle', 2);
    seen.add(parent.id); parent = get(draft, parent.containerId);
    if ([21, 22].includes(parent.classNumber) && parent.id !== actor.id && !request.admin) throw new SpecialActionError('Another avatar inventory is private', 16);
    if ((parent.fields?.common_flags & 8) && parent.id !== actor.id) throw new SpecialActionError('Container is closed', 12);
  }
}
function corporeal(actor: GameObject) { if (actor.classNumber !== 21) throw new SpecialActionError('Materialize before using inventory', 5); }
function capacity(object: GameObject) {
  const cap = integer(object.capacity ?? 0, 0, 65535, 'capacity');
  return Number.isInteger(object.fields?.reducedCapacity) && object.fields.reducedCapacity > 0 ? Math.min(cap, object.fields.reducedCapacity) : cap;
}
function move(draft: WorldState, item: GameObject, destination: GameObject, index: number, actor: GameObject) {
  if (item.id === destination.id || capacity(destination) <= index) throw new SpecialActionError('Invalid destination slot', 15);
  let parent: GameObject | null = destination; const seen = new Set();
  while (parent) {
    if (parent.id === item.id || seen.has(parent.id)) throw new SpecialActionError('Container cycle', 2);
    seen.add(parent.id); parent = parent.containerId == null ? null : get(draft, parent.containerId);
  }
  if (inSlot(draft, destination, index)?.id !== item.id && inSlot(draft, destination, index)) throw new SpecialActionError('Destination slot is occupied', 15);
  item.containerId = destination.id; item.slot = index; item.regionId = actor.regionId; f(item).position = [index, 0, 0];
  const region = (object: GameObject): void => { for (const child of children(draft, object)) { child.regionId = actor.regionId; region(child); } };
  region(item);
}
function tokenAmount(item: GameObject) { return integer(item?.fields?.denom ?? 0, 0, MAX_MONEY, 'token amount'); }
function reserve(object: GameObject) { return integer(object.cashReserve ?? 0, 0, MAX_MONEY, 'machine reserve'); }
function ledger(draft: WorldState, request: TransactionRequest, kind: string, amount: number, objectId: number | null, details: NativeFields = {}) {
  draft.ledger.push({ id: draft.next.transaction++, at: request.now, avatarId: request.avatarId, kind, amount, objectId, ...details });
}
function payExact(draft: WorldState, actor: GameObject, request: TransactionRequest, object: GameObject, amount: number) {
  integer(amount, 0, 65535, 'price');
  if (!amount) return;
  corporeal(actor);
  const cash = held(draft, actor);
  if (!cash || cash.classNumber !== 26 || cash.ownerId !== request.avatarId || tokenAmount(cash) !== amount) throw new SpecialActionError(`Hold exactly ${amount} tokens to pay`, 6);
  if (children(draft, cash).length || cash.pendingSale && !cash.pendingSale.paid) throw new SpecialActionError('Tokens are not spendable', 6);
  object.cashReserve = integer(reserve(object) + amount, 0, MAX_MONEY, 'machine reserve');
  delete draft.objects[cash.id];
  ledger(draft, request, 'device-payment', amount, object.id);
}
function creditHeld(draft: WorldState, actor: GameObject, request: TransactionRequest, amount: number) {
  integer(amount, 1, MAX_MONEY, 'payout'); corporeal(actor);
  const cash = held(draft, actor);
  if (cash) {
    if (cash.classNumber !== 26 || cash.ownerId !== request.avatarId || cash.pendingSale && !cash.pendingSale.paid) throw new SpecialActionError('Your hand must be free for the prize', 15);
    f(cash).denom = integer(tokenAmount(cash) + amount, 1, MAX_MONEY, 'token payout'); return cash;
  }
  const id = draft.next.object++;
  const item = { id, classNumber: 26, regionId: actor.regionId, containerId: actor.id, ownerId: request.avatarId,
    capacity: 0, portable: true, locked: false, slot: 0,
    fields: { name: 'Tokens', denom: amount, position: [0, 0, 0], imageURL: '', imageDefault: 0, colorMap: [...Array(16).keys()] } };
  draft.objects[id] = item; return item;
}
function machineFunds(draft: WorldState, machine: GameObject, firstPrize: number) {
  return reserve(machine) + children(draft, machine).filter(item => slot(item) >= firstPrize && item.classNumber === 26).reduce((sum, item) => sum + tokenAmount(item), 0);
}
/** Rewards transfer reserves or stocked Tokens; a favorable draw cannot mint money. */
function payMachineReward(draft: WorldState, machine: GameObject, actor: GameObject, request: TransactionRequest, amount: number, firstPrize: number) {
  if (machineFunds(draft, machine, firstPrize) < amount) throw new SpecialActionError('This machine cannot fund its configured payout', 6);
  let remaining = amount;
  const fromReserve = Math.min(reserve(machine), remaining); machine.cashReserve = reserve(machine) - fromReserve; remaining -= fromReserve;
  for (const stock of children(draft, machine).filter(item => slot(item) >= firstPrize && item.classNumber === 26).sort((a, b) => slot(a) - slot(b))) {
    const removed = Math.min(tokenAmount(stock), remaining); f(stock).denom -= removed; remaining -= removed;
    if (!stock.fields.denom) delete draft.objects[stock.id];
    if (!remaining) break;
  }
  ledger(draft, request, 'machine-payout', -amount, machine.id);
  return creditHeld(draft, actor, request, amount);
}
function random(maximum: number, choose: ((maximum: number) => number) | undefined) {
  const value = choose ? choose(maximum) : randomInt(maximum);
  const result = Number.isInteger(value) ? value : Math.floor(value * maximum);
  return integer(result, 0, maximum - 1, 'random result');
}
function reels(value: unknown, name: string) {
  const sequence = text(value, 256, name);
  if (!/^[0-9]{1,256}$/.test(sequence)) throw new SpecialActionError(`${name} must contain 1..256 digit symbols`, 2);
  return sequence;
}
function rewards(value: unknown) {
  const source = text(value, 4096, 'reward matrix');
  if (!source) return [];
  const rows = source.split('|');
  if (rows.length > 15) throw new SpecialActionError('The reward matrix has more than 15 rows', 2);
  const result = [], patterns = new Set();
  for (const row of rows) {
    const match = /^(\d+|#\d*)?>([0-9]{3})$/.exec(row);
    if (!match || patterns.has(match[2])) throw new SpecialActionError('Use unique three-digit reward patterns', 2);
    patterns.add(match[2]);
    let prizeSlot = null, amount = 0;
    if (match[1]?.startsWith('#')) prizeSlot = integer(Number(match[1].slice(1)), 3, 9, 'prize slot');
    else amount = integer(Number(match[1] || 0), 0, 65534, 'reward amount');
    result.push({ pattern: match[2], prizeSlot, amount });
  }
  return result;
}
function playable(draft: WorldState, machine: GameObject, actor: GameObject, request: TransactionRequest) {
  corporeal(actor);
  const cash = held(draft, actor), stake = integer(f(machine).salePrice ?? 0, 0, 65535, 'stake');
  if (!stake && cash && cash.classNumber !== 26) throw new SpecialActionError('Your hand must be free to play', 15);
  payExact(draft, actor, request, machine, stake);
  machine.machineState ??= { plays: 0, totalStaked: 0, totalPaid: 0 };
  machine.machineState.plays = integer(machine.machineState.plays + 1, 0, Number.MAX_SAFE_INTEGER, 'play count');
  machine.machineState.totalStaked = integer(machine.machineState.totalStaked + stake, 0, Number.MAX_SAFE_INTEGER, 'total stakes');
  machine.machineState.lastPlayedAt = request.now;
  return stake;
}
function prize(draft: WorldState, machine: GameObject, actor: GameObject, request: TransactionRequest, index: number) {
  const item = inSlot(draft, machine, index);
  if (!item) throw new SpecialActionError('The configured prize slot is empty', 3);
  if ([20, 21, 22, 200].includes(item.classNumber) || item.pendingSale && !item.pendingSale.paid) throw new SpecialActionError('The prize is not transferable', 16);
  if (held(draft, actor)) throw new SpecialActionError('Your hand must be free for the prize', 15);
  move(draft, item, actor, 0, actor); item.ownerId = request.avatarId; item.portable = true;
  f(item).common_flags = (Number(item.fields.common_flags ?? 0) & ~2) >>> 0;
  return item;
}
function charge(object: GameObject, key: string) {
  const count = integer(f(object).charges ?? 0, 0, 65535, 'charges');
  if (object[key]) throw new SpecialActionError('This device has no charges remaining', 5);
  // Initial zero is an explicitly unlimited device. A positive last charge is
  // recorded separately so decrement-to-zero never becomes unlimited.
  if (count && count !== 65535) { object.fields.charges = count - 1; if (!object.fields.charges) object[key] = true; }
}
function visibleDestination(draft: WorldState, region: RegionRecord | undefined, request: TransactionRequest) {
  if (!region || region.properties?.pendingDeletion) throw new SpecialActionError('Destination is unavailable', 3);
  const properties = region.properties ?? {}, home = properties.housing;
  const owner = home?.ownerId ?? properties.ownerId ?? null;
  const permitted = request.admin || owner === request.avatarId || home?.coOwnerIds?.includes(request.avatarId)
    || properties.allowedAvatarIds?.includes(request.avatarId);
  if ((properties.private === true || properties.locked === true || home && home.endedAt === undefined && home.guestAllowed === false) && !permitted) throw new SpecialActionError('Destination does not allow this avatar', 16);
  return region;
}
function destination(draft: WorldState, object: { fields: NativeFields; destinationRegionId?: number; properties?: DynamicFields }, request: TransactionRequest, choose?: (maximum: number) => number) {
  const surveyed = object.properties?.surveyTravel;
  if (surveyed !== undefined) {
    const id = surveyed?.destinationRegionId;
    if (surveyed?.version !== 1 || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !draft.regions[id]) {
      throw new SpecialActionError('Destination was not recorded in this surveyed passage', 3);
    }
    const selected = visibleDestination(draft, draft.regions[id], request);
    if (request.destinationId !== undefined && selected.id !== request.destinationId) throw new SpecialActionError('Destination changed; try again', 3);
    return selected;
  }
  const fields = f(object), address = fields.destination ?? object.destinationRegionId ?? object.properties?.destination ?? '';
  if (fields.isGroup) {
    const areaCode = Number(fields.areaCode ?? 0);
    const group = Object.values(draft.regionGroups ?? {}).find(item =>
      (String(item.id) === String(address) || item.address?.toLowerCase() === String(address).toLowerCase())
      && (!areaCode || Number(item.areaCode ?? 0) === areaCode));
    if (!group || group.pendingDeletion || !group.regionIds?.length) throw new SpecialActionError('Destination group is unavailable', 3);
    const candidates = group.regionIds.map(id => draft.regions[id]).filter(region => {
      try { visibleDestination(draft, region, request); return true; } catch { return false; }
    });
    if (!candidates.length) throw new SpecialActionError('Destination group has no permitted region', 16);
    if (request.destinationId !== undefined) {
      const chosen = candidates.find(region => region.id === request.destinationId);
      if (!chosen) throw new SpecialActionError('Destination group changed; try again', 3);
      return chosen;
    }
    const entry = candidates.find(region => region.id === group.entryRegionId);
    return entry ?? candidates[random(candidates.length, choose)];
  }
  const areaCode = Number(fields.areaCode ?? 0);
  const region = Object.values(draft.regions).find(item => {
    const same = String(item.id) === String(address) || item.name.toLowerCase() === String(address).toLowerCase()
      || item.properties?.address?.toLowerCase() === String(address).toLowerCase();
    return same && (!areaCode || Number(item.properties?.areaCode ?? 0) === areaCode);
  });
  const selected = visibleDestination(draft, region, request);
  if (request.destinationId !== undefined && selected.id !== request.destinationId) throw new SpecialActionError('Destination changed; try again', 3);
  return selected;
}
function descendants(draft: WorldState, object: GameObject): GameObject[] {
  const result = []; for (const child of children(draft, object)) { result.push(child, ...descendants(draft, child)); } return result;
}
function bill(draft: WorldState, cashier: GameObject, actor: GameObject, request: TransactionRequest) {
  const items = descendants(draft, actor).filter(item => item.pendingSale?.cashierId === cashier.id && item.pendingSale.buyerId === request.avatarId && !item.pendingSale.paid);
  let total = 0;
  for (const item of items) total += integer(item.pendingSale.price, 0, 65535, 'item price');
  integer(total, 0, 65535, 'bill total'); return { items, total };
}
function tclWord(value: unknown) {
  const string = String(value); if (!string) return '{}';
  return string.replace(/[\\\[\]{}$;\s]/g, char => char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : `\\${char}`);
}
const tclList = (values: readonly SchemaValue[]) => values.map(tclWord).join(' ');
interface SpecialResult extends ActionResult { cvObjectIds: number[] }
const resultFor = (contract: RequestContract): SpecialResult => ({ replyId: contract.replyId, reply: { success: 0, fail_msg: '', fail_URL: '' }, notices: [], cvObjectIds: [], refresh: false });

/** Bounded NPC dialogue programs use data operations, never executable source. */
function npcDialogue(draft: WorldState, target: GameObject, actor: GameObject, request: TransactionRequest, said: string, out: SpecialResult) {
  const dialogue = target.dialogue ?? target.properties?.dialogue ?? {};
  const rules = Array.isArray(dialogue) ? dialogue : Array.isArray(dialogue.rules) ? dialogue.rules
    : Object.entries(dialogue).filter(([key]) => !['default', 'rules'].includes(key)).map(([match, response]) => ({ match, response }));
  if (rules.length > 128) throw new SpecialActionError('NPC dialogue has too many rules', 2);
  const current = target.npcState ?? {}, player = { ...(current.playerStates?.[request.avatarId] ?? {}) };
  const matches = (rule: DynamicFields) => {
    if (!rule || typeof rule.match !== 'string') return false;
    const candidate = said.trim().toLowerCase(), match = rule.match.toLowerCase();
    if ((rule.mode === 'equals' ? candidate !== match : !candidate.includes(match))) return false;
    if (rule.once && player[`done:${rule.id ?? rule.match}`]) return false;
    if (rule.requires) {
      if (typeof rule.requires !== 'object' || Array.isArray(rule.requires)) throw new SpecialActionError('Invalid NPC conditions', 2);
      for (const [key, value] of Object.entries(rule.requires)) if (player[key] !== value) return false;
    }
    return typeof rule.response === 'string';
  };
  const rule = rules.find(matches);
  let answer = rule?.response ?? (typeof dialogue.default === 'string' ? dialogue.default : `Hello, ${request.avatarName}. Welcome to ${f(target).name || 'this world'}.`);
  // Only these two literal placeholders are substituted; Tcl, JS and arbitrary expressions remain text.
  answer = text(answer.replaceAll('{avatar}', request.avatarName ?? '').replaceAll('{npc}', f(target).name ?? ''), 2048, 'NPC reply');
  const actions = rule?.actions ?? [];
  if (!Array.isArray(actions) || actions.length > 16) throw new SpecialActionError('NPC dialogue actions exceed the limit', 2);
  for (const action of actions) {
    if (!action || typeof action !== 'object') throw new SpecialActionError('Invalid NPC action', 2);
    switch (action.type) {
      case 'setState': {
        const key = text(action.key, 80, 'NPC state key');
        if (!key || ['__proto__', 'constructor', 'prototype'].includes(key) || !['string', 'number', 'boolean'].includes(typeof action.value)
            || typeof action.value === 'string' && action.value.length > 256 || typeof action.value === 'number' && !Number.isSafeInteger(action.value)) throw new SpecialActionError('Invalid NPC state value', 2);
        player[key] = action.value; break;
      }
      case 'takeItem': {
        corporeal(actor);
        const item = held(draft, actor);
        if (!item || item.ownerId !== request.avatarId || item.pendingSale && !item.pendingSale.paid
            || [20, 21, 22, 200].includes(item.classNumber)
            || action.classNumber !== undefined && item.classNumber !== action.classNumber
            || action.name !== undefined && item.fields?.name !== action.name) throw new SpecialActionError('Hold the item requested by this character', 5);
        const index = Array.from({ length: capacity(target) }, (_, i) => i).find(i => !inSlot(draft, target, i));
        if (index === undefined) throw new SpecialActionError('This character has no space for the item', 15);
        move(draft, item, target, index, actor);
        for (const descendant of [item, ...descendants(draft, item)]) descendant.ownerId = null;
        item.portable = false; f(item).common_flags = (Number(item.fields.common_flags ?? 0) | 2) >>> 0; out.refresh = true; break;
      }
      case 'giveItem': {
        corporeal(actor);
        const index = integer(action.slot, 0, capacity(target) - 1, 'NPC stock slot');
        const item = inSlot(draft, target, index);
        if (!item || item.deleted || item.archivedIn || item.pendingSale && !item.pendingSale.paid
            || [20, 21, 22, 200].includes(item.classNumber)) throw new SpecialActionError('This character has no item available', 3);
        if (held(draft, actor)) throw new SpecialActionError('Your hand must be empty for this gift', 15);
        move(draft, item, actor, 0, actor);
        for (const descendant of [item, ...descendants(draft, item)]) descendant.ownerId = request.avatarId;
        item.portable = true; f(item).common_flags = (Number(item.fields.common_flags ?? 0) & ~2) >>> 0;
        out.cvObjectIds.push(item.id); out.refresh = true; break;
      }
      case 'payTokens': payExact(draft, actor, request, target, integer(action.amount, 0, 65535, 'NPC payment')); out.refresh = true; break;
      case 'rewardTokens': {
        const amount = integer(action.amount, 1, 65535, 'NPC reward');
        const item = payMachineReward(draft, target, actor, request, amount, 0);
        out.cvObjectIds.push(item.id); out.refresh = true; break;
      }
      case 'teleport': {
        const region = destination(draft, { fields: { destination: action.destination, areaCode: action.areaCode ?? 0, isGroup: 0 } }, request);
        out.teleportRegionId = region.id; break;
      }
      default: throw new SpecialActionError('Unknown NPC dialogue action', 2);
    }
  }
  if (rule?.once) player[`done:${rule.id ?? rule.match}`] = true;
  if (Object.keys(player).length > 256) throw new SpecialActionError('NPC player state exceeds its limit', 2);
  target.npcState = { ...current, talks: integer((current.talks ?? 0) + 1, 0, Number.MAX_SAFE_INTEGER, 'NPC talk count'),
    lastAvatarId: request.avatarId, lastText: said, lastAt: request.now,
    playerStates: { ...(current.playerStates ?? {}), [request.avatarId]: player } };
  out.notices.push({ targetId: target.id, id: 74, includeSelf: true, fields: { speaker: REF(target.id), type: 0, ignorable: 1, text: answer } });
}

/** Pure mutation function; the caller commits or rolls it back in one transaction. */
export function applySpecialAction(draft: WorldState, request: TransactionRequest, options: { random?: (maximum: number) => number } = {}): SpecialResult | null {
  const spec = contracts.get(request.id); if (!spec) return null;
  const target = get(draft, request.objectId), actor = get(draft, request.actorId), fields = request.fields ?? {}, refs = request.refs ?? {};
  if (!spec.classNumbers.includes(target.classNumber)) throw new SpecialActionError('This action does not apply to that class', 2);
  available(draft, target, actor, request);
  const state = f(target), out = resultFor(spec);
  switch (request.id) {
    case 20010: {
      const said = text(fields.text, 1024, 'NPC dialogue');
      npcDialogue(draft, target, actor, request, said, out);
      break;
    }
    case 20103: out.reply.name = draft.avatars[target.ownerId ?? -1]?.name ?? ''; break;
    case 20105: {
      corporeal(actor);
      if (refs.target !== target.id) throw new SpecialActionError('Adoption target does not match this pet', 2);
      if (target.ownerId !== null && target.ownerId !== request.avatarId && !request.admin && target.adoptable !== true && target.properties?.adoptable !== true) throw new SpecialActionError('This pet already has an owner', 16);
      if (held(draft, actor) && held(draft, actor)!.id !== target.id) throw new SpecialActionError('Your hand must be empty to adopt', 15);
      const name = text(fields.name, 29, 'pet name'); if (!name.trim()) throw new SpecialActionError('Choose a pet name', 2);
      move(draft, target, actor, 0, actor); target.ownerId = request.avatarId; state.owner = actor.id; state.name = name;
      target.adoptable = false; target.petState = { ownerId: request.avatarId, followsObjectId: actor.id, adoptedAt: request.now };
      out.refresh = true; break;
    }
    case 20302: {
      if (!owned(target, request)) throw new SpecialActionError('You do not own this potion', 16);
      const charges = integer(state.charges ?? 0, 0, 65535, 'potion charges'); if (!charges) throw new SpecialActionError('This potion is empty', 5);
      const kind = String(state.potionType || 'refreshment').toLowerCase();
      const supported = ['refreshment', 'heal', 'invisibility', 'mood', 'color'];
      if (!supported.includes(kind)) throw new SpecialActionError('This potion effect has no configured local implementation', 2);
      const profile = draft.avatars[request.avatarId]; if (!profile) throw new SpecialActionError('Avatar profile is missing', 3);
      const seconds = integer(state.potionDuration ?? 60, 0, 65535, 'potion duration') || 60;
      const effectId = draft.next.timer++;
      const expiresAt = request.now + seconds * 1000;
      // Repeated doses extend the effect while retaining the pre-first-dose
      // baseline; an older expiry must not undo a newer dose.
      const previous = { ...(profile.effects?.[kind]?.previous ?? {}) };
      if (kind === 'invisibility') { previous.visibilityBit ??= (actor.fields.common_flags ?? 0) & 1; actor.fields.common_flags = ((actor.fields.common_flags ?? 0) | 1) >>> 0; }
      if (kind === 'mood') { previous.mood ??= actor.fields.mood ?? 0; actor.fields.mood = integer(target.properties?.mood ?? 1, 0, 65535, 'potion mood'); }
      if (kind === 'color') {
        previous.colorMap ??= [...(actor.fields.colorMap ?? [...Array(16).keys()])];
        const colors = target.properties?.colorMap ?? Array(16).fill(7);
        if (!Array.isArray(colors) || colors.length !== 16) throw new SpecialActionError('Potion color palette is invalid', 2);
        actor.fields.colorMap = colors.map(value => integer(value, 0, 255, 'potion color'));
      }
      profile.effects ??= {}; profile.effects[kind] = { id: effectId, expiresAt, sourceObjectId: target.id, previous };
      draft.timers[effectId] = { id: effectId, objectId: actor.id, kind: 'special-effect-expire', dueAt: expiresAt, payload: { avatarId: profile.id, effect: kind, effectId, previous } };
      if (kind === 'heal') { actor.fields.health = 255; profile.vitals = { ...(profile.vitals ?? {}), health: 255 }; }
      state.charges = charges - 1; out.reply.effectmsg = `You used the ${kind} potion.`; out.refresh = true; break;
    }
    case 20404: {
      requireOwned(target, request);
      const routes = text(fields.newRoutes, 1024, 'bus routes').trim().split(/\s+/).filter(Boolean).map(value => {
        if (!/^\d+$/.test(value)) throw new SpecialActionError('Bus routes must be numeric identifiers', 2);
        return integer(Number(value), 0, 65535, 'route number');
      });
      if (routes.length > 64 || new Set(routes).size !== routes.length) throw new SpecialActionError('Use at most 64 distinct bus routes', 2);
      target.busRoutes = routes; state.routeNumbers = routes.join(' ');
      out.notices.push({ targetId: target.id, id: 20405, fields: { newRoutes: state.routeNumbers } }); break;
    }
    case 20502: {
      const current = bill(draft, target, actor, request); out.reply.total = current.total;
      out.reply.itemlist = tclList(current.items.map(item => tclList([item.fields?.name ?? 'Item', item.pendingSale.price]))); break;
    }
    case 20504: {
      const current = bill(draft, target, actor, request); payExact(draft, actor, request, target, current.total);
      for (const item of current.items) { item.pendingSale.paid = true; item.forSale = false; if (item.properties) item.properties.forSale = false; }
      target.cashierState = { ...(target.cashierState ?? {}), payments: (target.cashierState?.payments ?? 0) + (current.items.length ? 1 : 0), lastAt: request.now };
      out.refresh = current.items.length > 0; break;
    }
    case 20904: {
      requireOwned(target, request);
      Object.assign(out.reply, { destination: state.destination ?? '', areaCode: state.areaCode ?? 0, isgroup: state.isGroup ?? 0, menuEntry: state.menuEntry ?? '', charges: state.charges ?? 0 }); break;
    }
    case 20906: {
      requireOwned(target, request);
      state.destination = text(fields.destination, 31, 'destination'); state.areaCode = integer(fields.areaCode, 0, 65535, 'area code');
      state.isGroup = integer(fields.isgroup, 0, 1, 'group flag'); state.menuEntry = text(fields.menuEntry, 31, 'menu entry');
      state.charges = integer(fields.charges, 0, 65535, 'charges'); state.rideCost = integer(fields.rideCost, 0, 65535, 'ride cost');
      destination(draft, target, request, options.random); target.portkeyExhausted = false; out.refresh = true; break;
    }
    case 20907: {
      const region = destination(draft, target, request, options.random);
      charge(target, 'portkeyExhausted'); payExact(draft, actor, request, target, integer(target.properties?.surveyTravel?.cost ?? state.rideCost ?? 0, 0, 65535, 'ride cost'));
      out.teleportRegionId = region.id; break;
    }
    case 21006: {
      requireOwned(target, request);
      Object.assign(out.reply, { reel1sequence: state.reel1sequence ?? '0123456789', reel2sequence: state.reel2sequence ?? '0123456789', reel3sequence: state.reel3sequence ?? '0123456789', rewardmatrix: state.rewardmatrix ?? '' }); break;
    }
    case 21009: {
      requireOwned(target, request); state.menuEntry = text(fields.menuEntry, 31, 'menu entry'); state.salePrice = integer(fields.stake, 0, 65535, 'stake');
      for (const name of ['reel1sequence', 'reel2sequence', 'reel3sequence']) state[name] = reels(fields[name], name);
      rewards(fields.rewardmatrix); state.rewardmatrix = fields.rewardmatrix; out.refresh = true; break;
    }
    case 21004: {
      for (let index = 0; index < 3; index++) if (!inSlot(draft, target, index)) throw new SpecialActionError('Machine does not contain all three reels', 3);
      const sequences = ['reel1sequence', 'reel2sequence', 'reel3sequence'].map(name => reels(state[name] ?? '0123456789', name));
      const rows = rewards(state.rewardmatrix ?? ''); playable(draft, target, actor, request);
      const outcome = sequences.map(sequence => Number(sequence[random(sequence.length, options.random)]));
      out.reply.results = outcome.join(' '); target.machineState.lastResults = outcome;
      const reward = rows.find(row => row.pattern === outcome.join(''));
      if (reward?.amount) {
        const cash = payMachineReward(draft, target, actor, request, reward.amount, 3); out.cvObjectIds.push(cash.id);
        target.machineState.totalPaid = integer(target.machineState.totalPaid + reward.amount, 0, Number.MAX_SAFE_INTEGER, 'total payouts'); out.reply.fail_msg = `You won ${reward.amount} tokens.`;
      } else if (reward?.prizeSlot !== null && reward?.prizeSlot !== undefined) {
        const item = prize(draft, target, actor, request, reward.prizeSlot); out.cvObjectIds.push(item.id); out.reply.fail_msg = `You won ${item.fields.name || 'a prize'}.`;
      } else out.reply.fail_msg = 'No win this time.';
      out.refresh = true; break;
    }
    case 21306: requireOwned(target, request); out.reply.maxResult = integer(state.maxResult ?? 20, 1, 65535, 'maximum result'); break;
    case 21309: requireOwned(target, request); state.menuEntry = text(fields.menuEntry, 31, 'menu entry'); state.salePrice = integer(fields.stake, 0, 65535, 'stake'); state.maxResult = integer(fields.maxResult, 1, 65535, 'maximum result'); out.refresh = true; break;
    case 21304: {
      const maximum = integer(state.maxResult ?? 20, 1, 65535, 'maximum result'); playable(draft, target, actor, request);
      const outcome = random(maximum, options.random) + 1; out.reply.result = outcome; target.machineState.lastResults = [outcome];
      const item = inSlot(draft, target, outcome - 1);
      if (item) { const awarded = prize(draft, target, actor, request, outcome - 1); out.cvObjectIds.push(awarded.id); out.reply.fail_msg = `You won ${awarded.fields.name || 'a prize'}.`; }
      out.refresh = true; break;
    }
    case 21010: case 21012: case 21310: case 21312: {
      requireOwned(target, request); corporeal(actor);
      const index = integer(fields.slot, 0, capacity(target) - 1, 'prize slot');
      const loading = request.id === 21012 || request.id === 21312;
      let item;
      if (loading) {
        item = held(draft, actor); if (!item) throw new SpecialActionError('Hold an item to stock', 3);
        if (!owned(item, request) || item.pendingSale && !item.pendingSale.paid || [20, 21, 22, 200].includes(item.classNumber)) throw new SpecialActionError('This item cannot be stocked', 16);
        move(draft, item, target, index, actor); item.portable = false; f(item).common_flags = (Number(item.fields.common_flags ?? 0) | 2) >>> 0;
        out.notices.push({ targetId: target.id, id: target.classNumber === 210 ? 21013 : 21313, fields: { actor: REF(actor.id), item: REF(item.id), slot: index } });
      } else {
        if (held(draft, actor)) throw new SpecialActionError('Your hand must be empty', 15);
        item = inSlot(draft, target, index); if (!item) throw new SpecialActionError('That slot is empty', 3);
        move(draft, item, actor, 0, actor); item.ownerId = request.avatarId; item.portable = true;
        f(item).common_flags = (Number(item.fields.common_flags ?? 0) & ~2) >>> 0;
        out.notices.push({ targetId: target.id, id: target.classNumber === 210 ? 21011 : 21311, fields: { actor: REF(actor.id), item: REF(item.id), slot: index } });
      }
      out.refresh = true; break;
    }
    case 21503: {
      requireOwned(target, request);
      const item = get(draft, refs.target); available(draft, item, actor, request); requireOwned(item, request);
      if ([20, 21, 22, 200].includes(item.classNumber) || item.containerId !== null) throw new SpecialActionError('Only loose decorations can be hidden', 2);
      const hiding = integer(fields.state, 0, 1, 'visibility state') === 1;
      const original = item.decoratorHidden?.position ?? [...(item.fields.position ?? [0, 0, 0])];
      if (hiding && !item.decoratorHidden) {
        charge(target, 'decoratorExhausted'); item.decoratorHidden = { position: original, avatarId: request.avatarId, at: request.now };
        f(item).position = [-500, 0, 0]; f(item).common_flags = (Number(item.fields.common_flags ?? 0) | 1) >>> 0;
      } else if (!hiding) {
        f(item).position = original; f(item).common_flags = (Number(item.fields.common_flags ?? 0) & ~1) >>> 0; delete item.decoratorHidden;
      }
      out.reply.position = original.map((value: SchemaValue) => integer(Math.max(0, value), 0, 65535, 'display position')); out.refresh = true; break;
    }
    case 21505: {
      requireOwned(target, request);
      out.hidden = all(draft).filter(item => item.regionId === actor.regionId && item.decoratorHidden && owned(item, request)).map(item => ({ id: item.id, name: item.fields?.name ?? 'Object', position: item.decoratorHidden.position }));
      break;
    }
  }
  return out;
}

/** Return false for unrelated timer kinds; expiry IDs prevent old timers undoing newer doses. */
export function applySpecialTimer(draft: WorldState, timer: TimerRecord) {
  // A later potion dose owns a newer effect ID. An older expiry may consume its
  // timer, but cannot restore stale appearance over the more recent effect.
  if (timer.kind !== 'special-effect-expire') return false;
  const payload = timer.payload ?? {}, profile = draft.avatars[payload.avatarId], actor = draft.objects[timer.objectId ?? -1];
  const effect = profile?.effects?.[payload.effect];
  if (effect?.id === payload.effectId) {
    if (actor) {
      const { visibilityBit, ...previous } = payload.previous ?? {};
      Object.assign(actor.fields, previous);
      if (visibilityBit !== undefined) actor.fields.common_flags = (((actor.fields.common_flags ?? 0) & ~1) | visibilityBit) >>> 0;
    }
    delete profile.effects[payload.effect];
  }
  return true;
}

function transform(value: SchemaValue, context: ActionContext): SchemaValue {
  if (value && typeof value === 'object' && '$objectRef' in value) return context.ref(value.$objectRef);
  if (Array.isArray(value)) return value.map(item => transform(item, context));
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transform(item, context)]));
  return value;
}

/** Adapt declarative device outcomes to the existing native reply/notice contracts. */
export class SpecialActions {
  readonly context: ActionContext;
  constructor(context: ActionContext) { this.context = context; }
  async handle(session: ActionSession, request: NativeActionRequest) {
    const spec = contracts.get(request.id); if (!spec) return false;
    const context = this.context, object = request.object ?? context.resolveObject(session, request.noid), actor = context.actorObject(session);
    try {
      if (!object || !actor) throw new SpecialActionError('Object is missing', 3);
      const fields = request.fields ?? context.registry.decodeMessage(request.id, request.payload!);
      const refs: Record<string, number | undefined> = {};
      if (Number.isInteger(fields.target) && fields.target !== 65535) refs.target = context.resolveObject(session, fields.target)?.id;
      const actionRequest: TransactionRequest = {
        id: request.id, fields, refs, objectId: object.id, actorId: actor.id, avatarId: session.avatar.id,
        avatarName: session.avatar.name, admin: Boolean(context.isAdmin?.(session)), now: context.now?.() ?? Date.now(),
      };
      if (request.id === 20907) {
        const snapshot = context.worldStore.snapshot(), current = get(snapshot, object.id);
        const region = destination(snapshot, current, actionRequest, context.random);
        if (context.canEnterRegion) {
          const permission = await context.canEnterRegion(session, region.id);
          if (permission === false || permission !== null && typeof permission === 'object' && permission.allowed === false) throw new SpecialActionError('Destination does not allow this avatar', 16);
        }
        actionRequest.destinationId = region.id;
      }
      const hasDraftTravel = typeof context.moveActorInDraft === 'function';
      const hasTravelPublisher = typeof context.publishTravel === 'function';
      if (request.id === 20907 && hasDraftTravel !== hasTravelPublisher) throw new Error('Atomic travel requires both draft movement and view publication');
      const result = context.worldStore.transaction(draft => {
        const outcome = applySpecialAction(draft, actionRequest, { random: context.random })!;
        if (outcome.teleportRegionId !== undefined && hasDraftTravel) {
          // Payment, remaining charges, profile position and every carried
          // object's region are one durable world commit. This helper must
          // mutate only the candidate draft; it does not publish client views.
          outcome.travelTransition = context.moveActorInDraft(draft, session, outcome.teleportRegionId);
          if (!outcome.travelTransition || typeof (outcome.travelTransition as { then?: unknown }).then === 'function') throw new Error('Draft travel must return a synchronous transition');
        }
        return outcome;
      }, { actorId: session.avatar.id, action: `special-${request.id}` });
      const reply = transform(result.reply, context);
      if (result.cvObjectIds.length) {
        reply.contentsVector = await context.contentsVector(session, result.cvObjectIds.map(id => context.worldStore.getObject(id)).filter((item): item is GameObject => item !== null)); reply.cvsize = reply.contentsVector.length;
      } else if ([21005, 21305].includes(result.replyId)) { reply.contentsVector = Buffer.alloc(0); reply.cvsize = 0; }
      if (result.hidden) reply.hiddenObjects = tclList(result.hidden.map(item => tclList([item.name, context.nativeNoid(session, item.id), item.position.join(' ')])));
      await context.reply(session, request.noid, result.replyId, reply);
      for (const notice of result.notices) await context.broadcastObject(actor.regionId, notice.targetId, notice.id, transform(notice.fields, context), notice.includeSelf ? undefined : session);
      if (result.travelTransition) await context.publishTravel(session, result.travelTransition);
      else if (result.teleportRegionId !== undefined) await context.teleport(session, result.teleportRegionId);
      else if (result.refresh) await context.refreshRegion(actor.regionId);
      return true;
    } catch (error) {
      if (!(error instanceof SpecialActionError)) throw error;
      await context.reply(session, request.noid, spec.replyId, { success: error.code, fail_msg: error.message, fail_URL: '', effectmsg: error.message, name: '',
        destination: '', areaCode: 0, isgroup: 0, menuEntry: '', charges: 0, total: 0, itemlist: '', results: '', result: 0,
        contentsVector: Buffer.alloc(0), cvsize: 0, maxResult: 0, hiddenObjects: '', position: [0, 0, 0] });
      return true;
    }
  }
}
