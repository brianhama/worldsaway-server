import type { WorldState } from './types.js';
/**
 * Narrow, authored housing exit policy. Recovered Tcl 00050082 and 0005008b
 * explicitly describe removing guests when all owners exit. This helper runs
 * inside the enclosing world transaction; it performs no I/O or publication.
 */
export class PresencePolicyError extends Error {}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new PresencePolicyError(`${label} must be a positive avatar/region ID`);
  return value;
}

export function carriedObjectIds(draft: WorldState, actorId: number): Set<number> {
  const result = new Set([actorId]);
  // Document binders archive logical members outside physical class capacity.
  // Treat those members as carried with their binder, preserving their text.
  for (let changed = true; changed;) {
    changed = false;
    for (const object of Object.values(draft.objects)) {
      if (!result.has(object.id) && (result.has(object.containerId as number) || result.has(object.archivedIn as number))) {
        result.add(object.id); changed = true;
      }
    }
    for (const objectId of [...result]) for (const childId of draft.documents?.[objectId]?.entries ?? []) {
      if (draft.objects[childId] && !result.has(childId)) { result.add(childId); changed = true; }
    }
  }
  return result;
}

/**
 * Return IDs moved by the last housing owner/coowner's departure.
 *
 * presentAvatarIds is server presence AFTER the departure. For an atomic move,
 * callers may still include the departing ID; it is explicitly excluded and
 * other owners' region membership is checked against the draft. For disconnect,
 * use toRegionId:null. A same-region refresh is not an exit.
 */
export function applyHousingExitPolicy(draft: WorldState, {
  departingAvatarId,
  fromRegionId,
  toRegionId = null,
  presentAvatarIds = [],
}: { departingAvatarId: number; fromRegionId: number; toRegionId?: number | null; presentAvatarIds?: number[] } = {} as { departingAvatarId: number; fromRegionId: number }) {
  positive(departingAvatarId, 'Departing avatar'); positive(fromRegionId, 'Origin region');
  if (toRegionId !== null) positive(toRegionId, 'Destination region');
  if (toRegionId === fromRegionId) return [];
  const home = draft.regions?.[fromRegionId], housing = home?.properties?.housing;
  if (!housing || housing.endedAt !== undefined || housing.kickOutOnExit !== true) return [];
  const owners = new Set([housing.ownerId, ...(housing.coOwnerIds ?? [])]
    .filter(value => Number.isSafeInteger(value) && value > 0));
  if (!owners.has(departingAvatarId)) return [];
  const present = new Set([...presentAvatarIds].map(value => positive(value, 'Present avatar')));
  for (const ownerId of owners) if (ownerId !== departingAvatarId && present.has(ownerId)
      && draft.avatars?.[ownerId]?.regionId === fromRegionId) return [];
  const guests = Object.values(draft.avatars ?? {}).filter(avatar => avatar.regionId === fromRegionId && !owners.has(avatar.id))
    .sort((a, b) => a.id - b.id);
  if (!guests.length) return [];
  const fallback = draft.startRegionId === null ? undefined : draft.regions?.[draft.startRegionId];
  if (!fallback || fallback.id === fromRegionId || fallback.properties?.pendingDeletion) {
    throw new PresencePolicyError('Housing guests need a safe start region outside this home');
  }
  // Resolve all actors/subtrees before mutating any guest. A bad draft aborts
  // the entire enclosing transaction rather than partially relocating guests.
  const moves = guests.map(guest => {
    const actor = draft.objects?.[guest.objectId];
    if (!actor || actor.regionId !== fromRegionId || actor.ownerId !== guest.id) throw new PresencePolicyError('Housing guest has an invalid actor object');
    return { guest, actor, ids: carriedObjectIds(draft, actor.id) };
  });
  for (const { guest, actor, ids } of moves) {
    guest.regionId = fallback.id; guest.position = [256, 220, 0];
    guest.preferences ??= {}; guest.preferences.following = null;
    actor.containerId = null; actor.slot = 0; actor.fields ??= {};
    actor.fields.position = [256, 220, 0]; actor.fields.choreState = 0;
    actor.fields.following = 65535; actor.fields.webfollowing = 0;
    for (const objectId of ids) draft.objects[objectId].regionId = fallback.id;
  }
  // Offline guest identities are also relocated, so reconnecting cannot bypass
  // an eviction that happened while they were absent. No mail, balances,
  // ownership, object IDs, document contents or ground furnishings are reset.
  return guests.map(guest => guest.id);
}
