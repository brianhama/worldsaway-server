import type { AvatarProfile, BusRoute, EntityMap, GameObject, WorldState } from './types.js';

export type AdmissionCheck = (profile: AvatarProfile, regionId: number, draft: WorldState) => boolean;
export interface FollowingTravel { leaderAvatarId: number; fromRegionId: number; toRegionId: number; presentAvatarIds?: number[]; canEnter?: AdmissionCheck }
export interface BusRouteOptions { id: number; name?: string; vehicleObjectId: number; stopObjectIds: number[]; intervalSeconds?: number; startAt?: number; enabled?: boolean }
/** Declarative transport and companion behavior. All functions mutate one world transaction. */
import { carriedObjectIds } from './presence-policy.js';

export class AutomationError extends Error {}
const values = <T>(value: EntityMap<T> | undefined): T[] => Object.values(value ?? {});
function integer(value: number, low: number, high: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new AutomationError(`Invalid ${name}`);
  return value;
}
function moveTree(draft: WorldState, root: GameObject, regionId: number) {
  for (const id of carriedObjectIds(draft, root.id)) draft.objects[id].regionId = regionId;
}
function admit(draft: WorldState, profile: AvatarProfile, regionId: number, canEnter: AdmissionCheck | undefined) {
  const region = draft.regions[regionId];
  if (!region || region.properties?.pendingDeletion) return false;
  if (canEnter) return canEnter(profile, regionId, draft) === true;
  const housing = region.properties?.housing;
  const owner = housing?.ownerId === profile.id || housing?.coOwnerIds?.includes(profile.id);
  return profile.role === 'admin' || owner || !(region.properties?.guestAllowed === false
    || housing?.guestAllowed === false || ((region.properties?.regionFlags ?? 0) & 2048));
}

/** Bring online following chains across an exit, with each follower's own admission check. */
export function applyFollowingTravel(draft: WorldState, { leaderAvatarId, fromRegionId, toRegionId, presentAvatarIds = [], canEnter }: FollowingTravel = {} as FollowingTravel) {
  if (fromRegionId === toRegionId) return [];
  const present = new Set(presentAvatarIds), moved: number[] = [], leaders = new Set([leaderAvatarId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const profile of values(draft.avatars).sort((a, b) => a.id - b.id)) {
      if (leaders.has(profile.id) || !present.has(profile.id) || profile.regionId !== fromRegionId || !leaders.has(profile.preferences?.following)) continue;
      const actor = draft.objects[profile.objectId];
      if (!actor || actor.containerId !== null || !admit(draft, profile, toRegionId, canEnter)) {
        profile.preferences.following = null;
        if (actor) actor.fields.following = 65535;
        continue;
      }
      const leader = draft.avatars[profile.preferences.following], leaderActor = draft.objects[leader.objectId];
      profile.regionId = toRegionId; profile.position = [...(leaderActor.fields.position ?? [256, 220, 0])];
      actor.fields.position = [...profile.position]; actor.fields.choreState = 0;
      moveTree(draft, actor, toRegionId); moved.push(profile.id); leaders.add(profile.id); changed = true;
    }
  }
  applyPetFollowing(draft, { avatarIds: [...leaders], fromRegionId });
  return moved;
}

/** Loose adopted pets follow their owner; contained pets travel with their containing tree. */
export function applyPetFollowing(draft: WorldState, { avatarIds = null, fromRegionId = null }: { avatarIds?: number[] | null; fromRegionId?: number | null } = {}) {
  const selected = avatarIds && new Set(avatarIds), affected = new Set<number>(), moved: number[] = [];
  for (const pet of values(draft.objects)) {
    if (pet.classNumber !== 201 || pet.containerId !== null || pet.archivedIn || pet.deleted || pet.properties?.followOwner === false || !pet.petState?.followsObjectId) continue;
    const profile = draft.avatars[pet.ownerId as number], actor = profile && draft.objects[profile.objectId];
    if (!actor || profile.ghost || selected && !selected.has(profile.id)) continue;
    if (fromRegionId !== null && pet.regionId !== fromRegionId && pet.regionId !== actor.regionId) continue;
    if (pet.petState.followsObjectId !== actor.id) continue;
    const coords = [...(actor.fields.position ?? [256, 220, 0])]; coords[0] = Math.max(0, coords[0] - 24);
    if (pet.regionId === actor.regionId && JSON.stringify(pet.fields.position) === JSON.stringify(coords)) continue;
    affected.add(pet.regionId); affected.add(actor.regionId);
    moveTree(draft, pet, actor.regionId); pet.fields.position = coords; pet.fields.owner = actor.id; moved.push(pet.id);
  }
  return { movedObjectIds: moved, affectedRegionIds: [...affected] };
}

/** Use a class53 Seating object as a bus so existing sit/stand controls work unchanged. */
export function configureBusRoute(draft: WorldState, { id, name = '', vehicleObjectId, stopObjectIds, intervalSeconds = 30, startAt = 0, enabled = true }: BusRouteOptions = {} as BusRouteOptions): BusRoute {
  integer(id, 1, 65534, 'route number'); integer(vehicleObjectId, 1, Number.MAX_SAFE_INTEGER, 'vehicle object');
  integer(intervalSeconds, 1, 86400, 'bus interval'); integer(startAt, 0, Number.MAX_SAFE_INTEGER, 'bus start time');
  if (typeof name !== 'string' || name.length > 80 || /[\0\r\n]/.test(name) || typeof enabled !== 'boolean') throw new AutomationError('Invalid bus route settings');
  if (!Array.isArray(stopObjectIds) || stopObjectIds.length < 2 || stopObjectIds.length > 64 || new Set(stopObjectIds).size !== stopObjectIds.length) throw new AutomationError('A bus route needs 2..64 distinct stops');
  const vehicle = draft.objects[vehicleObjectId];
  if (!vehicle || vehicle.classNumber !== 53 || vehicle.containerId !== null || vehicle.capacity < 1 || vehicle.deleted || vehicle.archivedIn) throw new AutomationError('Bus vehicle must be a loose Seating object');
  for (const stopId of stopObjectIds) {
    integer(stopId, 1, Number.MAX_SAFE_INTEGER, 'stop object');
    const stop = draft.objects[stopId];
    if (!stop || stop.classNumber !== 204 || stop.containerId !== null || stop.deleted || stop.archivedIn || draft.regions[stop.regionId]?.properties?.pendingDeletion) throw new AutomationError('Bus stops must be available loose Bus Stop objects');
  }
  for (const route of values(draft.busRoutes)) if (route.id !== id && route.vehicleObjectId === vehicleObjectId) throw new AutomationError('A bus vehicle may serve only one route');
  const existing = draft.busRoutes?.[id];
  const stopIndex = stopObjectIds.findIndex(stopId => draft.objects[stopId].regionId === vehicle.regionId);
  if (stopIndex < 0) throw new AutomationError('Place the bus in one of its stop regions before configuring its route');
  draft.busRoutes ??= {};
  draft.busRoutes[id] = { id, name, vehicleObjectId, stopObjectIds: [...stopObjectIds], intervalSeconds,
    enabled, stopIndex, nextAt: startAt, journeys: existing?.journeys ?? 0 };
  for (const stop of values(draft.objects).filter(item => item.classNumber === 204)) {
    const routes = new Set((stop.busRoutes ?? String(stop.fields.routeNumbers ?? '').split(/\s+/).filter(Boolean).map(Number)).filter(routeId => routeId !== id));
    if (stopObjectIds.includes(stop.id)) routes.add(id);
    stop.busRoutes = [...routes].sort((a, b) => a - b); stop.fields.routeNumbers = stop.busRoutes.join(' ');
  }
  return structuredClone(draft.busRoutes[id]);
}

export function busesDue(state: WorldState, now: number): boolean {
  return values(state.busRoutes).some(route => route.enabled && Number.isSafeInteger(route.nextAt) && route.nextAt <= now);
}

/** Advance each due bus once. Missed offline departures coalesce into this departure. */
export function tickBusRoutes(draft: WorldState, { now, canEnter }: { now: number; canEnter?: AdmissionCheck } = {} as { now: number }) {
  integer(now, 0, Number.MAX_SAFE_INTEGER, 'bus time');
  const affected = new Set<number>(), moved = new Set<number>(), departed: number[] = [];
  for (const route of values(draft.busRoutes).sort((a, b) => a.id - b.id)) {
    if (!route.enabled || route.nextAt > now) continue;
    const vehicle = draft.objects[route.vehicleObjectId], stops = route.stopObjectIds?.map(id => draft.objects[id]);
    if (!vehicle || vehicle.classNumber !== 53 || vehicle.containerId !== null || !stops?.length || stops.some(stop => !stop || stop.classNumber !== 204 || draft.regions[stop.regionId]?.properties?.pendingDeletion)) {
      route.enabled = false; route.lastError = 'Bus vehicle or stop is unavailable'; continue;
    }
    const nextIndex = ((route.stopIndex ?? 0) + 1) % stops.length, destination = stops[nextIndex], origin = vehicle.regionId;
    const subtree = carriedObjectIds(draft, vehicle.id), passengers = values(draft.avatars).filter(profile => subtree.has(profile.objectId));
    // One denied passenger holds the bus; it never bypasses a private room or splits a passenger's inventory.
    const admitted: { profile: AvatarProfile; regionId: number }[] = []; let denied = false;
    for (const profile of passengers) {
      if (!admit(draft, profile, destination.regionId, canEnter)) { denied = true; break; }
      // Later checks see earlier passengers in the prospective destination.
      // Restore these temporary profile changes if the complete group cannot enter.
      admitted.push({ profile, regionId: profile.regionId }); profile.regionId = destination.regionId;
    }
    if (denied) {
      for (const entry of admitted) entry.profile.regionId = entry.regionId;
      route.lastError = 'A passenger cannot enter the next stop'; route.nextAt = now + route.intervalSeconds * 1000; continue;
    }
    const coords = [...(destination.fields.position ?? [256, 220, 0])];
    affected.add(origin); affected.add(destination.regionId);
    moveTree(draft, vehicle, destination.regionId); vehicle.fields.position = coords;
    for (const profile of passengers) { profile.regionId = destination.regionId; profile.position = [...coords]; moved.add(profile.id); }
    route.stopIndex = nextIndex; route.nextAt = now + route.intervalSeconds * 1000;
    route.lastDepartedAt = now; route.journeys = integer((route.journeys ?? 0) + 1, 0, Number.MAX_SAFE_INTEGER, 'bus journey count'); delete route.lastError;
    departed.push(route.id);
  }
  return { movedAvatarIds: [...moved], affectedRegionIds: [...affected], departedRouteIds: departed };
}
