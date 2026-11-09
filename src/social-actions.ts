import type { NativeFields, GameObject, AvatarProfile, WorldState, MailRecord } from './types.js';
import type { ActionContext, ActionSession, NativeActionRequest, SchemaValue } from './action-types.js';
/** Recovered WA social/avatar request contracts and authored authoritative rules. */
import { WorldStoreError } from './world-store.js';
import { encodeClientString } from './classes.js';
export const SUPPORTED_REQUESTS = Object.freeze([
  { id: 72, name: 'room speech', replyId: 73, classNumbers: [21, 40] },
  { id: 109, name: 'ESP message', replyId: 111, classNumbers: [20, 21, 22] },
  { id: 171, name: 'web tour state', replyId: 172, classNumbers: [20, 21, 22] },
  { id: 175, name: 'web tour permission', replyId: 70, classNumbers: [20, 21, 22] },
  { id: 179, name: 'join web tour', replyId: 180, classNumbers: [20, 21, 22] },
  { id: 183, name: 'web tour URL', replyId: 70, classNumbers: [20, 21, 22] },
  { id: 241, name: 'avatar name lookup', replyId: 242, classNumbers: [20] },
  { id: 244, name: 'send ESP mail', replyId: 70, classNumbers: [20] },
  { id: 247, name: 'read ESP mail', replyId: 246, classNumbers: [20] },
  { id: 1570, name: 'walk', replyId: 1571, classNumbers: [21] },
  { id: 1587, name: 'ghost', replyId: 1588, classNumbers: [21, 22] },
  { id: 1591, name: 'touch avatar', replyId: 70, classNumbers: [21] },
  { id: 1594, name: 'gesture', replyId: 1596, classNumbers: [21] },
  { id: 1600, name: 'follow avatar', replyId: 70, classNumbers: [21] },
  { id: 1603, name: 'stop following', replyId: 70, classNumbers: [21] },
  { id: 1616, name: 'mood', replyId: 70, classNumbers: [21] },
  { id: 1688, name: 'facing', replyId: 70, classNumbers: [21] },
  { id: 1916, name: 'status and preferences', replyId: 73, classNumbers: [21, 22] },
  { id: 2003, name: 'ghost status', replyId: 73, classNumbers: [22] },
  { id: 2005, name: 'materialize', replyId: 2006, classNumbers: [22] },
]);
const contracts = new Map(SUPPORTED_REQUESTS.map(item => [item.id, item]));
const FLAGS = Object.freeze({ espOff: 32, refuseFollowers: 64, onDuty: 128, mailOff: 512,
  mailWaiting: 1024, gesturesOff: 0x1000, silentLogin: 0x8000 });
const flagChanges = new Map<number, [number, boolean]>([[60, [FLAGS.espOff, true]], [61, [FLAGS.espOff, false]],
  [90, [FLAGS.refuseFollowers, false]], [91, [FLAGS.refuseFollowers, true]],
  [93, [FLAGS.onDuty, true]], [94, [FLAGS.onDuty, false]], [251, [FLAGS.mailOff, true]],
  [252, [FLAGS.mailOff, false]], [500, [FLAGS.silentLogin, false]], [501, [FLAGS.silentLogin, true]],
  [503, [FLAGS.gesturesOff, true]], [504, [FLAGS.gesturesOff, false]]]);

export class SocialActionError extends Error {}
function text(value: unknown, maximum = 1024, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new SocialActionError(`Text must use at most ${maximum} non-NUL Windows-1252 bytes`);
  try { if (encodeClientString(value).length > maximum) throw new Error('too long'); }
  catch { throw new SocialActionError(`Text must use at most ${maximum} non-NUL Windows-1252 bytes`); }
  return value;
}
function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new SocialActionError(`Invalid ${label}`);
  return value;
}
function coordinates(value: unknown): number[] {
  // DataView is a byte view without indexed numeric coordinates; typed numeric
  // arrays and normal arrays share the original native three-component shape.
  if ((!Array.isArray(value) && !(ArrayBuffer.isView(value) && 'length' in value)) || value.length !== 3) throw new SocialActionError('Expected three coordinates');
  return Array.from(value as ArrayLike<unknown>, component => integer(component, -32768, 32767, 'coordinate'));
}
function idOf(value: GameObject | number) { return typeof value === 'object' && value !== null ? value.id : value; }
function objectValues<T>(table: Record<string, T>): T[] { return Object.values(table ?? {}); }
function preferences(profile: AvatarProfile) { return profile.preferences ??= {}; }
function flags(profile: AvatarProfile) { return Number(profile.preferences?.flags ?? profile.flags ?? 0) >>> 0; }

/** Physical delivery is owned by the Postbox contract, never ESP read247. */
export function isPhysicalMail(message: Partial<MailRecord> | null | undefined) {
  if (!message || typeof message !== 'object') return false;
  return message.objectId !== undefined && message.objectId !== null
    || message.parcelObjectId !== undefined && message.parcelObjectId !== null
    || message.attachmentObjectId !== undefined && message.attachmentObjectId !== null
    || message.attachment !== undefined && message.attachment !== null
    || Array.isArray(message.attachments) && message.attachments.length > 0
    || message.parcel !== undefined && message.parcel !== null && message.parcel !== false
    || message.kind === 'parcel' || message.type === 'parcel';
}

/** Social state is durable, while online delivery and elapsed-session clocks are not. */
export class SocialActions {
  readonly context: ActionContext;
  readonly connected: WeakMap<ActionSession, number>;
  readonly clock: () => number;
  constructor(context: ActionContext) {
    this.context = context;
    this.connected = new WeakMap();
    this.clock = context.clock ?? context.now ?? (() => Date.now());
  }
  #state() { return this.context.worldStore.snapshot(); }
  #profile(session: ActionSession, state: WorldState = this.#state()) {
    const id = session.avatar?.id ?? session.avatarId;
    const profile = state.avatars?.[String(id)];
    if (!profile) throw new SocialActionError('Authenticated avatar profile required');
    return profile;
  }
  #actor(session: ActionSession) {
    const actor = this.context.actorObject?.(session);
    if (!actor) throw new SocialActionError('Session actor is unavailable');
    return actor;
  }
  #actorNoid(session: ActionSession, actor: GameObject | null = this.#actor(session)) {
    return this.context.noidFor?.(session, actor) ?? session.actorNoid ?? 15;
  }
  #ref(object: GameObject | number) { return this.context.ref ? this.context.ref(object) : idOf(object); }
  #target(session: ActionSession, request: NativeActionRequest) { return request.object ?? this.context.resolveObject?.(session, request.noid); }
  #ownActor(session: ActionSession, request: NativeActionRequest) {
    const actor = this.#actor(session), target = this.#target(session, request);
    if (!target || target.id !== actor.id) throw new SocialActionError('Only your own actor may perform this action');
    return actor;
  }
  #visibleActor(session: ActionSession, request: NativeActionRequest) {
    const actor = this.#ownActor(session, request);
    if (actor.classNumber !== 21) throw new SocialActionError('Materialize into an avatar before using this action');
    return actor;
  }
  #mutate<T>(session: ActionSession, change: (draft: WorldState, profile: AvatarProfile, actor: GameObject) => T): T {
    return this.context.worldStore.transaction(draft => {
      const profile = this.#profile(session, draft);
      const actor = draft.objects?.[String(profile.objectId)];
      if (!actor) throw new SocialActionError('Actor state is unavailable');
      actor.fields ??= {};
      return change(draft, profile, actor);
    });
  }
  #reply(session: ActionSession, noid: number, id: number, fields: NativeFields) { return this.context.reply(session, noid, id, fields); }
  async #notice(session: ActionSession, actor: GameObject, id: number, fields: NativeFields, except: ActionSession | null = session) {
    const regionId = this.#profile(session).regionId;
    if (this.context.broadcastObject) return this.context.broadcastObject(regionId, actor.id, id, fields, except ?? undefined);
    return this.context.broadcast(regionId, this.#actorNoid(session, actor), id, fields, except ?? undefined);
  }
  #online(profileId: number) {
    return [...(this.context.sessions ?? [])].filter(session => !session.closed && Number(session.avatar?.id ?? session.avatarId) === Number(profileId));
  }
  #findByName(name: string, state: WorldState = this.#state()) {
    text(name, 29);
    return objectValues(state.avatars).find(a => a.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
  }
  #ignored(recipient: AvatarProfile, sender: AvatarProfile) { return (recipient.ignored ?? []).includes(sender.id); }

  register(session: ActionSession) {
    if (this.connected.has(session)) return;
    const at = this.clock(); this.connected.set(session, at);
    this.#mutate(session, (_draft, profile) => { profile.lastLogin = at; });
  }
  onDisconnect(session: ActionSession) {
    if (!this.connected.has(session)) return;
    const at = this.connected.get(session)!; this.connected.delete(session);
    this.#mutate(session, (_draft, profile) => {
      profile.onlineSeconds = (profile.onlineSeconds ?? 0) + Math.max(0, Math.floor((this.clock() - at) / 1000));
      profile.lastLogout = this.clock();
    });
  }

  async handle(session: ActionSession, request: NativeActionRequest) {
    const contract = contracts.get(request.id);
    if (!contract) return false;
    const fields = request.fields ?? {};
    try {
      this.#profile(session); this.#actor(session);
      if (!this.connected.has(session)) this.register(session);
      switch (request.id) {
        case 72: await this.#speech(session, request, fields); break;
        case 109: await this.#esp(session, request, fields); break;
        case 241: await this.#lookup(session, request, fields); break;
        case 244: await this.#mail(session, request, fields); break;
        case 247: await this.#readMail(session, request); break;
        case 1570: await this.#walk(session, request, fields); break;
        case 1594: await this.#gesture(session, request, fields); break;
        case 1591: await this.#touch(session, request); break;
        case 1600: await this.#follow(session, request); break;
        case 1603: await this.#unfollow(session, request); break;
        case 1616: await this.#mood(session, request, fields); break;
        case 1688: await this.#facing(session, request, fields); break;
        case 1916: await this.#status(session, request, fields); break;
        case 2003: await this.#status(session, request, { type: 57 }); break;
        case 1587: await this.#mode(session, request, 'ghost', fields); break;
        case 2005: await this.#mode(session, request, 'avatar', fields); break;
        case 171: case 175: case 179: case 183: await this.#tour(session, request, fields); break;
      }
    } catch (error) {
      if (!(error instanceof SocialActionError) && !(error instanceof WorldStoreError)) throw error;
      await this.#failure(session, request, contract.replyId, error.message);
    }
    return true;
  }

  async #failure(session: ActionSession, request: NativeActionRequest, replyId: number, message: string) {
    const actor = this.context.actorObject?.(session), position = actor?.fields?.position ?? [0, 0, 0];
    const coords = replyId === 1588 ? position.map((value: SchemaValue) => Math.max(0, Math.min(65535, Number(value) || 0))) : position;
    const result = { success: 5, fail_msg: message, fail_URL: '', text: message, type: request.fields?.type ?? 0,
      speaker: actor ? this.#ref(actor) : 0, to: request.fields?.to ?? '', realname: '', coords,
      facing: 65535, actor_noid: this.#actorNoid(session, actor), hide_ghost: 0,
      cvsize: 0, contentsVector: Buffer.alloc(0), newtextid: 0, actorinlist: 0 };
    await this.#reply(session, request.noid, replyId, result);
  }
  async #speech(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    const profile = this.#profile(session), ownActor = this.#actor(session), target = this.#target(session, request);
    let actor;
    if (target?.classNumber === 40) {
      if (ownActor.classNumber !== 21) throw new SocialActionError('Materialize before speaking through a robot');
      if (target.regionId !== profile.regionId || target.ownerId !== profile.id && profile.role !== 'admin') throw new SocialActionError('You may only speak through a robot you control');
      actor = target;
    } else actor = this.#visibleActor(session, request);
    const message = text(fields.text, 1024), type = integer(fields.type ?? 0, 0, 255, 'speech type');
    const reply = { success: 0, speaker: this.#ref(actor), type, text: message };
    await this.#reply(session, request.noid, 73, reply);
    for (const other of this.context.sessions ?? []) {
      if (other === session || other.closed || !other.avatar) continue;
      const recipient = this.#profile(other);
      if (recipient.regionId !== profile.regionId || this.#ignored(recipient, profile)) continue;
      const speaker = this.context.noidFor?.(other, actor) ?? this.#actorNoid(session, actor);
      await this.#reply(other, speaker, 74, { speaker, type, ignorable: 1, text: message });
    }
  }
  async #esp(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    const sender = this.#profile(session), recipient = this.#findByName(fields.to);
    const message = text(fields.text, 2048), type = integer(fields.type ?? 0, 0, 255, 'ESP type');
    if (!recipient || this.#ignored(recipient, sender) || (flags(recipient) & FLAGS.espOff)) throw new SocialActionError('That avatar is not accepting ESP');
    const online = this.#online(recipient.id);
    if (!online.length) {
      await this.#reply(session, request.noid, 111, { success: 1, type, to: recipient.name, text: message });
      await this.#reply(session, 0, 243, { to: recipient.name, text: message });
      return;
    }
    for (const other of online) await this.#reply(other, 0, 110, { type, ignorable: 1, from: sender.name, text: message });
    await this.#reply(session, request.noid, 111, { success: 0, type, to: recipient.name, text: message });
  }
  async #lookup(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    const found = this.#findByName(fields.searchname);
    await this.#reply(session, request.noid, 242, { success: found ? 0 : 1, realname: found?.name ?? '', fail_msg: found ? '' : 'Avatar not found' });
  }
  async #mail(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    const sender = this.#profile(session), recipient = this.#findByName(fields.to);
    const body = text(fields.text, 4096);
    if (!recipient || this.#ignored(recipient, sender) || (flags(recipient) & FLAGS.mailOff)) throw new SocialActionError('That avatar is not accepting ESP mail');
    const mail = this.context.worldStore.transaction(draft => {
      const target = draft.avatars[String(recipient.id)];
      if ((target.mailbox ?? []).length >= 1000) throw new SocialActionError('Recipient mailbox is full');
      const id = draft.next.message++;
      const record = { id, fromId: sender.id, toId: recipient.id, fromName: sender.name,
        subject: 'ESP', body, createdAt: this.clock(), readAt: null };
      draft.mail[String(id)] = record; target.mailbox.push(id);
      preferences(target).flags = flags(target) | FLAGS.mailWaiting;
      return structuredClone(record);
    });
    // Content, mailbox ownership and waiting flag commit together, before reply.
    for (const online of this.#online(recipient.id)) await this.#reply(online, 0, 248, { who: sender.name });
    await this.#reply(session, request.noid, 70, { success: 0, fail_msg: '', fail_URL: '' });
    return mail;
  }
  async #readMail(session: ActionSession, request: NativeActionRequest) {
    // ESP delivery and physical Postbox parcels share storage but have different
    // native lifecycles. Reading ESP must not consume a parcel or its inventory.
    const now = this.clock();
    const result = this.#mutate(session, (draft, profile) => {
      const mail = (profile.mailbox ?? []).map(id => draft.mail?.[String(id)]).filter(item => item && item.toId === profile.id && item.readAt === null && !isPhysicalMail(item));
      const rendered = []; let bytes = 0, count = 0;
      for (const letter of mail) {
        const line = `From ${letter.fromName} on ${new Date(letter.createdAt).toISOString()}: ${letter.body.replaceAll('|', '\u00a6')}`;
        text(line, 128 * 1024);
        const length = encodeClientString(line).length + (rendered.length ? 1 : 0);
        if (rendered.length && bytes + length > 60 * 1024) break;
        rendered.push(line); bytes += length; letter.readAt = now; count++;
      }
      const remaining = count < mail.length;
      preferences(profile).flags = remaining ? flags(profile) | FLAGS.mailWaiting : flags(profile) & ~FLAGS.mailWaiting;
      return { display: rendered.join('|'), remaining };
    });
    await this.#reply(session, request.noid, 246, { success: 0, fail_msg: '', text: result.display });
    if (result.remaining) await this.#reply(session, 0, 248, { who: '' });
  }
  async #walk(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    const actor = this.#visibleActor(session, request), coords = coordinates(fields.coords);
    const result = this.#mutate(session, (draft, profile, object) => {
      const region = draft.regions[String(profile.regionId)];
      const width = Number(region?.properties?.width ?? 512), height = Number(region?.properties?.height ?? 512);
      coords[0] = Math.max(0, Math.min(Math.min(width, 32767), coords[0]));
      coords[1] = Math.max(0, Math.min(Math.min(height, 32767), coords[1]));
      object.fields.position = coords;
      profile.lastMove = this.clock();
      coords[2] = Math.max(0, coords[2]);
      const followers = [];
      for (const follower of objectValues(draft.avatars)) {
        if (follower.id === profile.id || follower.regionId !== profile.regionId || follower.preferences?.following !== profile.id) continue;
        const other = draft.objects[String(follower.objectId)];
        if (other) { other.fields.position = [...coords]; followers.push(other.id); }
      }
      return { coords, followers };
    });
    await this.#reply(session, request.noid, 1571, { success: 0, coords: result.coords });
    await this.#notice(session, actor, 1572, { coords: result.coords });
    // Followers remain in this region; crossing an exit is a separate request.
    for (const id of result.followers) {
      if (this.context.broadcastObject) await this.context.broadcastObject(this.#profile(session).regionId, id, 1572, { coords: result.coords });
      else await this.context.refreshRegion(this.#profile(session).regionId);
    }
  }
  async #mood(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    const actor = this.#visibleActor(session, request), mood = integer(fields.mood, 0, 4, 'mood');
    this.#mutate(session, (_draft, _profile, object) => { object.fields.mood = mood; });
    await this.#reply(session, request.noid, 70, { success: 0, fail_msg: '', fail_URL: '' });
    await this.#notice(session, actor, 1617, { mood });
  }
  async #facing(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    const actor = this.#visibleActor(session, request), facing = integer(fields.facing, 0, 3, 'facing');
    this.#mutate(session, (_draft, _profile, object) => { object.fields.orientation = facing; });
    await this.#reply(session, request.noid, 70, { success: 0, fail_msg: '', fail_URL: '' });
    await this.#notice(session, actor, 1689, { facing });
  }
  async #gesture(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    const actor = this.#visibleActor(session, request), profile = this.#profile(session);
    const gesture = text(fields.gesture, 63);
    if (flags(profile) & FLAGS.gesturesOff) throw new SocialActionError('Gestures are disabled in your preferences');
    if (!/^[A-Za-z0-9_ -]+$/.test(gesture)) throw new SocialActionError('Invalid gesture name');
    const facing = actor.fields?.orientation ?? 0;
    await this.#reply(session, request.noid, 1596, { success: 0, facing });
    await this.#notice(session, actor, 1595, { gesture, facing });
  }
  async #touch(session: ActionSession, request: NativeActionRequest) {
    const actor = this.#actor(session), target = this.#target(session, request);
    const sender = this.#profile(session), state = this.#state();
    const recipient = objectValues(state.avatars).find(profile => profile.objectId === target?.id);
    if (actor.classNumber !== 21 || !target || target.classNumber !== 21 || !recipient || recipient.regionId !== sender.regionId || recipient.id === sender.id) throw new SocialActionError('Touch requires another avatar in this room');
    const a = actor.fields?.position ?? [0, 0, 0], b = target.fields?.position ?? [0, 0, 0];
    if (Math.abs(a[0] - b[0]) > 128 || Math.abs(a[1] - b[1]) > 80) throw new SocialActionError('Move closer to that avatar first');
    await this.#reply(session, request.noid, 70, { success: 0, fail_msg: '', fail_URL: '' });
    // Original notice1592 references an unset $toucher variable. The global
    // information notice uses an installed Region method and avoids that bug.
    for (const other of this.#online(recipient.id)) await this.#reply(other, 0, 118, { text: `${sender.name} touched you.` });
  }
  async #follow(session: ActionSession, request: NativeActionRequest) {
    // Validate the persisted following graph before adding an edge. Otherwise a
    // cycle could make both same-room walking and cross-region travel recursive.
    const actor = this.#actor(session), target = this.#target(session, request);
    const state = this.#state(), profile = this.#profile(session, state);
    const leader = objectValues(state.avatars).find(item => item.objectId === target?.id);
    if (!leader || leader.id === profile.id || leader.regionId !== profile.regionId || !this.#online(leader.id).length || (flags(leader) & FLAGS.refuseFollowers)) throw new SocialActionError('That avatar cannot be followed');
    let at = leader, visited = new Set([profile.id]);
    while (at) {
      if (visited.has(at.id)) throw new SocialActionError('Following would create a cycle');
      visited.add(at.id); at = state.avatars[String(at.preferences?.following)];
    }
    this.#mutate(session, (_draft, current, object) => { preferences(current).following = leader.id; object.fields.following = target!.id; });
    await this.#reply(session, request.noid, 70, { success: 0, fail_msg: '', fail_URL: '' });
    await this.#notice(session, actor, 1601, { leader: this.#ref(target!) });
  }
  async #unfollow(session: ActionSession, request: NativeActionRequest) {
    const own = this.#actor(session), target = this.#target(session, request);
    const profile = this.#profile(session);
    const changed = this.context.worldStore.transaction(draft => {
      const follower = objectValues(draft.avatars).find(item => item.objectId === target?.id);
      if (!follower || (follower.id !== profile.id && follower.preferences?.following !== profile.id)) throw new SocialActionError('You may only stop following yourself or stop someone following you');
      preferences(follower).following = null;
      const object = draft.objects[String(follower.objectId)]; object.fields.following = 65535;
      return object.id;
    });
    await this.#reply(session, request.noid, 70, { success: 0, fail_msg: '', fail_URL: '' });
    if (this.context.broadcastObject) await this.context.broadcastObject(profile.regionId, changed, 1604, {});
    else await this.#notice(session, own, 1604, {}, null);
  }
  async #status(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    if (request.noid !== 0) this.#ownActor(session, request);
    const type = integer(fields.type, 0, 65535, 'status type');
    const actor = this.#actor(session), state = this.#state(), profile = this.#profile(session, state);
    let message;
    if (flagChanges.has(type)) {
      const [bit, enabled] = flagChanges.get(type)!;
      if (bit === FLAGS.onDuty && !['builder', 'admin'].includes(profile.role)) throw new SocialActionError('On-duty status requires a staff role');
      this.#mutate(session, (_draft, current) => { preferences(current).flags = enabled ? flags(current) | bit : flags(current) & ~bit; });
      message = 'Your status preference has been saved.';
    } else {
      switch (type) {
        case 55: message = objectValues(state.avatars).filter(a => a.regionId === profile.regionId && this.#online(a.id).length).map(a => a.name).join(', ') || 'No other avatars are here.'; break;
        case 192: message = [...new Set([...(this.context.sessions ?? [])].filter(s => s.avatar && !s.closed).map(s => this.#profile(s, state)).map(a => `${a.name}: ${state.regions[String(a.regionId)]?.name ?? a.regionId}`))].join('\n'); break;
        case 56: message = state.regions[String(profile.regionId)]?.name ?? 'Local world'; break;
        case 57: message = `You are ${profile.ghost || profile.mode === 'ghost' ? 'a ghost' : 'an avatar'} in good health.`; break;
        case 58: message = new Date(this.clock()).toISOString(); break;
        case 59: {
          let held = 0, carried = 0;
          for (const item of objectValues(state.objects)) {
            if (item.classNumber !== 26 || item.archivedIn || item.deleted) continue;
            let current = item, seen = new Set();
            while (current?.containerId != null && !seen.has(current.id)) {
              seen.add(current.id);
              if (current.containerId === actor.id) {
                const amount = Number(item.fields?.denom ?? 0);
                if (item.containerId === actor.id && (item.slot ?? item.fields?.position?.[0] ?? 0) === 0) held += amount;
                else carried += amount;
                break;
              }
              current = state.objects[String(current.containerId)];
            }
          }
          message = `You hold ${held} Tokens in your hand and ${carried} in your pockets. Your bank balance is ${profile.balance ?? 0} Tokens.`;
          break;
        }
        case 14: message = `Total online time: ${(profile.onlineSeconds ?? 0) + Math.max(0, Math.floor((this.clock() - (this.connected.get(session) ?? this.clock())) / 1000))} seconds.`; break;
        case 15: this.#mutate(session, (_draft, current) => { current.onlineSeconds = 0; }); this.connected.set(session, this.clock()); message = 'Your online timer has been reset.'; break;
        case 502: message = objectValues(state.avatars).filter(a => (flags(a) & FLAGS.onDuty) && this.#online(a.id).length).map(a => a.name).join(', ') || 'No helpers are on duty.'; break;
        default: throw new SocialActionError('Unknown status request');
      }
    }
    await this.#reply(session, request.noid, 73, { success: 0, speaker: this.#ref(actor), type, text: message });
  }
  async #mode(session: ActionSession, request: NativeActionRequest, mode: 'ghost' | 'avatar', fields: NativeFields) {
    // The native conversion callback needs its acknowledgement before a scene
    // refresh replaces the actor object on which that callback is still running.
    this.#ownActor(session, request);
    if (!this.context.setActorMode) throw new SocialActionError('Actor mode conversion is unavailable');
    const coords = mode === 'avatar' ? coordinates(fields.coords) : (this.#actor(session).fields?.position ?? [0, 0, 0]).map((value: SchemaValue) => Math.max(0, Math.min(32767, Number(value) || 0)));
    const result = await this.context.setActorMode(session, mode, coords);
    if (mode === 'ghost') await this.#reply(session, request.noid, 1588, { success: 0, coords, fail_msg: '' });
    else {
      const vector = result?.contentsVector ?? Buffer.alloc(0);
      await this.#reply(session, request.noid, 2006, { success: 0, actor_noid: result?.actorNoid ?? this.#actorNoid(session), hide_ghost: 1,
        cvsize: vector.length, contentsVector: vector, fail_msg: '' });
    }
    if (typeof result?.afterReply === 'function') await result.afterReply();
  }
  async #tour(session: ActionSession, request: NativeActionRequest, fields: NativeFields) {
    if (request.noid !== 0) this.#ownActor(session, request);
    const actor = this.#actor(session), profile = this.#profile(session);
    if (request.id === 171) {
      const newstate = integer(fields.newstate, 0, 2, 'tour state');
      const newtextid = this.#mutate(session, (_draft, current, object) => {
        const pref = preferences(current); pref.tourState = newstate;
        pref.tourTextId = newstate ? current.id : 0;
        object.fields.webfollow_state = newstate; object.fields.webfollow_textid = pref.tourTextId;
        return pref.tourTextId;
      });
      await this.#reply(session, request.noid, 172, { success: 0, fail_msg: '', newtextid });
      await this.context.broadcast(profile.regionId, 0, 173, { target: this.#ref(actor), newstate, newtextid }, session);
    } else if (request.id === 175) {
      const target = this.context.resolveObject(session, fields.target), state = this.#state();
      const invitee = objectValues(state.avatars).find(a => a.objectId === target?.id);
      const allow = integer(fields.allow, 0, 1, 'tour permission');
      if (!invitee) throw new SocialActionError('Tour invitee is not an avatar');
      this.#mutate(session, (_draft, current) => {
        const pref = preferences(current); const members = new Set(pref.tourAllowed ?? []);
        if (allow) members.add(invitee.id); else members.delete(invitee.id);
        pref.tourAllowed = [...members];
      });
      await this.#reply(session, request.noid, 70, { success: 0, fail_msg: '', fail_URL: '' });
      await this.context.broadcast(profile.regionId, 0, 177, { target: this.#ref(target!), source: this.#ref(actor), allow });
    } else if (request.id === 179) {
      const target = fields.target === 0 ? null : this.context.resolveObject(session, fields.target), state = this.#state();
      const leader = target ? objectValues(state.avatars).find(a => a.objectId === target.id) : null;
      const accepted = !target || (leader && leader.preferences?.tourState &&
        (leader.preferences.tourState === 2 || (leader.preferences.tourAllowed ?? []).includes(profile.id)));
      if (!accepted) throw new SocialActionError('That web tour is not open to you');
      this.#mutate(session, (_draft, current, object) => {
        preferences(current).tourFollowing = leader?.id ?? null;
        object.fields.webfollowing = target?.id ?? 0;
      });
      await this.#reply(session, request.noid, 180, { success: 0, fail_msg: '', actorinlist: 1 });
      if (leader?.preferences?.tourURL) await this.#reply(session, 0, 184, { newURL: leader.preferences.tourURL });
    } else {
      const url = text(fields.newURL, 2048); let parsed;
      try { parsed = new URL(url); } catch { throw new SocialActionError('Invalid web tour URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new SocialActionError('Web tours accept HTTP/HTTPS URLs without embedded credentials');
      if (!profile.preferences?.tourState) throw new SocialActionError('Start a web tour first');
      this.#mutate(session, (_draft, current) => { preferences(current).tourURL = url; });
      for (const other of this.context.sessions ?? []) {
        if (other.closed || !other.avatar || this.#profile(other).preferences?.tourFollowing !== profile.id) continue;
        await this.#reply(other, 0, 184, { newURL: url });
      }
      await this.#reply(session, request.noid, 70, { success: 0, fail_msg: '', fail_URL: '' });
    }
  }

  /** Authored management APIs; original Tcl ignore/friend UI does not send these mutations. */
  setIgnored(avatarId: number, targetId: number, ignored = true) {
    return this.context.worldStore.transaction(draft => {
      const avatar = draft.avatars[String(avatarId)], target = draft.avatars[String(targetId)];
      if (!avatar || !target || avatar.id === target.id) throw new SocialActionError('Invalid ignored avatar');
      const values = new Set(avatar.ignored ?? []); if (ignored) values.add(target.id); else values.delete(target.id);
      avatar.ignored = [...values]; return avatar.ignored;
    });
  }
  setFriend(avatarId: number, targetId: number, friend = true) {
    return this.context.worldStore.transaction(draft => {
      const avatar = draft.avatars[String(avatarId)], target = draft.avatars[String(targetId)];
      if (!avatar || !target || avatar.id === target.id) throw new SocialActionError('Invalid friend avatar');
      const values = new Set(avatar.friends ?? []); if (friend) values.add(target.id); else values.delete(target.id);
      avatar.friends = [...values]; return avatar.friends;
    });
  }
}
