import type { WorldStore } from './world-store.js';
import type { ClassRegistry } from './classes.js';
import type { ResourceProvider } from './resources.js';
import type { DynamicFields, GameObject, Position } from './types.js';
/** Authored public districts with a usable example of each concrete client class. */
import { configureBusRoute } from './automation.js';

export const DISTRICT_MIGRATION = 'worldsaway-districts-1';
const lifecycleClasses = new Set([0, 1, 2, 3, 4, 10, 11, 20, 21, 22]);

/** Additive migration: its saved marker keeps consumed stock and operator edits stable on restart. */
export function ensureDistricts(store: WorldStore, registry: ClassRegistry, resources: ResourceProvider) {
  const before = store.snapshot();
  if (before.contentMigrations?.[DISTRICT_MIGRATION]) return before.contentMigrations[DISTRICT_MIGRATION];
  const images = resources.listFileNames();
  const choose = (...names: (string | undefined)[]): string => names.find(name => name !== undefined && images.includes(name)) ?? 'o.teddy.img';
  return store.transaction(draft => {
    const createdIds: number[] = [], regionIds: Record<string, number> = {}, examples: Record<number, number> = {};
    const startRegionId = draft.startRegionId;
    if (startRegionId === null) throw new Error('Districts require a start region');
    const add = (number: number, regionId: number, name: string, image: string, position: Position, extra: Partial<GameObject> = {}): GameObject => {
      const definition = registry.get(number)!, info = resources.getFileInfo(image);
      const id = draft.next.object++;
      const fields: DynamicFields = { ...registry.defaults(number), name: name.slice(0, 31), position,
        imageURL: image, imageVersion: info?.version ?? 0, colorMap: [...Array(16).keys()], ...extra.fields };
      if (Object.hasOwn(fields, 'reducedCapacity')) fields.reducedCapacity = definition.capacity;
      const object: GameObject = { id, classNumber: number, regionId, ownerId: null, containerId: null,
        capacity: definition.capacity, portable: true, locked: false, ...extra, fields };
      registry.validateObject(object, { includeServer: true, strictFields: true });
      draft.objects[id] = object; createdIds.push(id); examples[number] ??= id;
      return object;
    };
    const rooms = ['Market', 'Workshop', 'Arcade', 'Travel Center', 'Wardrobe', 'Town Hall', 'Class Gallery'];
    for (const name of rooms) {
      const id = draft.next.region++, object = add(20, id, name, '', [0, 0, 0], {
        portable: false, fields: { horizon: 70, max_avatars: 32, max_ghosts: 32 },
      });
      draft.regions[id] = { id, objectId: object.id, name, exits: {}, properties: { address: `wa-${name.toLowerCase().replaceAll(' ', '-')}` } };
      regionIds[name] = id;
    }
    const chain = [startRegionId, ...rooms.map(name => regionIds[name])];
    // Use an unused lobby exit and return to it through the district chain.
    const firstDirection = ['south', 'west', 'north', 'east'].find(direction => !draft.regions[startRegionId].exits[direction]);
    if (firstDirection) draft.regions[startRegionId].exits[firstDirection] = chain[1];
    for (let i = 1; i < chain.length; i++) {
      draft.regions[chain[i]].exits.west = chain[i - 1];
      if (i + 1 < chain.length) draft.regions[chain[i]].exits.east = chain[i + 1];
    }
    for (const object of Object.values(draft.objects)) if (!lifecycleClasses.has(object.classNumber)) examples[object.classNumber] ??= object.id;
    const assigned = {
      Market: [26, 47, 49, 51, 205], Workshop: [41, 42, 43, 44, 55, 59, 60, 98, 215],
      Arcade: [58, 210, 213], 'Travel Center': [32, 35, 38, 39, 45, 56, 204, 209],
      Wardrobe: [25, 30, 31, 34, 48, 203, 206], 'Town Hall': [40, 46, 52, 54, 61], 'Class Gallery': [23],
    };
    const imageFor: Record<number, string> = {
      23: 'o.quips1.img', 25: 'o.rug01.img', 26: 'o.teddy.img', 30: 'x.caphat.img', 31: 'o.magicbottleR.img', 32: 'o.amult1.img', 34: 'o.bodychanger.img', 35: 'o.directionsigns.img',
      38: 'o.glassdoor2.img', 39: 'o.door7.img', 43: 'o.printdeco.img', 44: 'o.keys01.img',
      45: 'o.magicbottleR.img', 47: 'o.bookcase.img', 49: 'o.nupawn.img', 51: 'o.trashpawn.img',
      52: 'o.registry2.img', 54: 'o.fj_signboard02.img', 55: 'o.spray1.img', 56: 'o.portalarch1.img',
      58: 'o.fj_DICE.img', 203: 'o.magicbottleR.img', 204: 'o.directionsigns.img',
      205: 'o.cashier.img', 209: 'o.keys01.img', 210: 'o.aa.Slots16.img', 213: 'o.fj_DICE.img',
    };
    const fixed = new Set([34, 38, 39, 40, 41, 43, 46, 47, 49, 51, 52, 54, 56, 58, 60, 61, 98, 204, 205, 210, 213, 215]);
    for (const [room, numbers] of Object.entries(assigned)) for (const [index, number] of numbers.entries()) {
      if (examples[number]) continue;
      const fields: DynamicFields = {}, properties: DynamicFields = {}, extra: Partial<GameObject> = { fields, properties, portable: !fixed.has(number) };
      if (number === 26) fields.denom = 25;
      if (number === 32 || number === 45 || number === 209) fields.charges = 10;
      if (number === 55) Object.assign(fields, { charges: 20, canCharges: 20 });
      if (number === 25) Object.assign(fields, { oppositeCorner: [170, 240, 0], flatType: 0 });
      if (number === 30) Object.assign(fields, { slot: 0, action_type: 1, action_menu: 1 });
      if (number === 31) Object.assign(fields, { action_type: 1, action_menu: 1 });
      if (number === 54) fields.text = 'Welcome to WorldsAway.app. Explore the districts and ride the town shuttle.';
      if (number === 45) properties.effect = { type: 'color', colors: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].reverse() };
      if (number === 56) properties.connection = { address: String(startRegionId), areaCode: 0, aliases0: 'Lobby' };
      if (number === 61) {
        Object.assign(fields, { initialized: 1, interval: 30, presentationEnable: 1, presentationAutostart: 1 });
        properties.banner = { text: 'Welcome to WorldsAway.app! Claim a welcome memento.', presentations: { 1: { text: 'Your WorldsAway.app welcome memento', limit: 1 } } };
      }
      if (number === 203) Object.assign(fields, { charges: 5, potionType: 'mood', potionDuration: 30 });
      if (number === 58) Object.assign(fields, { num_dice: 2, die_sides: 6 });
      if (number === 34) for (const [i, image] of ['a.fjdefmale.img', 'a.fjdeffemale.img'].entries()) {
        fields[`bodyname${i}`] = i ? 'Female' : 'Male'; fields[`bodyURL${i}`] = choose(image, 'a.fjdefmale.img');
      }
      if ([38, 39, 45].includes(number)) properties.destinationRegionId = startRegionId;
      if (number === 209) Object.assign(fields, { destination: String(startRegionId), menuEntry: 'Return to Lobby' });
      if (number === 46) {
        fields.num_available = [10, 0, 0, 0, 0, 0, 0, 0]; fields.rent = [10, 0, 0, 0, 0, 0, 0, 0];
        properties.plans = { 0: { available: 10, rent: 10, info: 'A private home for 10 tokens per week.', periodMs: 604800000 } };
      }
      if (number === 210) Object.assign(fields, { reel1sequence: '012', reel2sequence: '012', reel3sequence: '012', rewardmatrix: '5>000', menuEntry: 'Play slots', salePrice: 1 });
      if (number === 213) Object.assign(fields, { maxResult: 6, menuEntry: 'Spin', salePrice: 0 });
      if ([210, 213].includes(number)) extra.cashReserve = 100;
      if (number === 49) fields.markDown = 50;
      const object = add(number, regionIds[room], registry.get(number)!.name, choose(imageFor[number], 'o.teddy.img'),
        [70 + index % 4 * 120, 180 + Math.floor(index / 4) * 40, 0], extra);
      if (number === 213) for (let prize = 0; prize < 6; prize++) {
        add(27, object.regionId, `Spinner prize ${prize + 1}`, choose('o.teddy.img'), [prize, 0, 0], { containerId: object.id, slot: prize, portable: false });
      }
      if (number === 61) add(27, object.regionId, 'WorldsAway welcome memento', choose('o.teddy.img'), [0, 0, 0], { containerId: object.id, slot: 0, portable: false });
      if (number === 210) for (let reel = 0; reel < 3; reel++) {
        add(27, object.regionId, `Reel ${reel + 1}`, choose('o.fj_DICE.img'), [reel, 0, 0], { containerId: object.id, slot: reel, portable: false });
      }
    }
    // A durable master document serves both newspaper sales and printing.
    const master = add(37, regionIds.Workshop, 'WorldsAway Gazette', choose('o.bookopen.img'), [0, 0, 0], {
      portable: false, containerId: examples[43], slot: 0, fields: { blank_page_max: 100, documentFlags: 4 },
    });
    draft.documents[master.id] = { objectId: master.id, title: 'WorldsAway Gazette',
      text: 'Welcome to WorldsAway.app. Explore the districts, ride the town shuttle, rent a home and build your world.',
      pages: ['Welcome to WorldsAway.app. Explore the districts, ride the town shuttle, rent a home and build your world.'], updatedAt: store.clock() };
    draft.objects[examples[47]].properties!.masterId = master.id;
    const stops = [startRegionId, regionIds.Market, regionIds['Travel Center']].map((id, index) => add(204, id,
      `Shuttle stop ${index + 1}`, choose('o.directionsigns.img'), [440, 230, 0], { portable: false }));
    const bus = add(53, stops[0].regionId, 'Town shuttle - sit to ride', choose('o.bench1.img'), [420, 245, 0], { portable: false });
    configureBusRoute(draft, { id: 1, name: 'Town shuttle', vehicleObjectId: bus.id, stopObjectIds: stops.map(stop => stop.id), intervalSeconds: 30, startAt: store.clock() + 30000 });
    const marker = { id: DISTRICT_MIGRATION, installedAt: store.clock(), createdIds, regionIds, examples,
      busObjectId: bus.id, stopObjectIds: stops.map(stop => stop.id), lobbyExit: firstDirection ?? null };
    draft.contentMigrations ??= {}; draft.contentMigrations[DISTRICT_MIGRATION] = marker;
    return marker;
  }, { action: 'worldsaway-districts-installed' });
}
