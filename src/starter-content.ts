import type { WorldStore } from './world-store.js';
import type { ClassRegistry } from './classes.js';
import type { ResourceProvider } from './resources.js';
import type { DynamicFields, Position } from './types.js';
/** Add a small, usable authored world without replacing existing world state. */
export const STARTER_CONTENT_MIGRATION = 'starter-1';

const colors = () => [...Array(16).keys()];

function asset(resources: ResourceProvider, name: string) {
  const info = resources.getFileInfo(name);
  if (!info?.data?.length) throw new Error(`Starter content requires the cached image ${name}`);
  return { name, version: info.version, checksum: info.checksum };
}

/**
 * This migration only appends objects and its marker. In particular, deleting
 * an item after installation never causes it to respawn on the next launch.
 * The WorldStore transaction supplies validation, durable replacement, backup,
 * audit history and rollback; no account or existing object record is edited.
 */
export function ensureStarterContent(worldStore: WorldStore, registry: ClassRegistry, resources: ResourceProvider) {
  const before = worldStore.snapshot();
  if (Object.hasOwn(before.contentMigrations ?? {}, STARTER_CONTENT_MIGRATION)) {
    return structuredClone(before.contentMigrations![STARTER_CONTENT_MIGRATION]);
  }

  const available = Object.values(before.regions).sort((a, b) => a.id - b.id);
  const start = (before.startRegionId === null ? undefined : before.regions[before.startRegionId]) ?? available[0];
  if (!start) throw new Error('Starter content requires an existing region');
  // Select by stable IDs, then existing rooms, so renamed rooms keep their
  // content and a custom world is never expanded or renamed by this migration.
  const garden = before.regions[2]?.id !== start.id && before.regions[2]
    || available.find(region => region.id !== start.id) || start;
  const library = before.regions[3]?.id !== start.id && before.regions[3]?.id !== garden.id && before.regions[3]
    || available.find(region => region.id !== start.id && region.id !== garden.id) || garden;
  const headName = resources.listFileNames().find(name => /^h\./i.test(name) && !/headless|poop/i.test(name));
  if (!headName) throw new Error('Starter greeter requires a cached head image');
  const assets = Object.fromEntries([
    'o.atm01.img', 'a.fjdefmale.img', headName, 'o.vendo1.img',
    'o.teddy.img', 'o.cocoacup.img', 'o.arboroses.img', 'o.dog1.img',
  ].map(name => [name, asset(resources, name)]));

  const marker = worldStore.transaction(draft => {
    const createdIds: number[] = [], objects: Record<string, number> = {};
    const add = (key: string, classNumber: number, regionId: number, name: string, imageName: string, position: Position, options: { portable?: boolean; fields?: DynamicFields; properties?: DynamicFields; containerId?: number } = {}): number => {
      const definition = registry.get(classNumber);
      if (!definition) throw new Error(`Starter content requires class ${classNumber}`);
      const portable = options.portable ?? true;
      const fields: DynamicFields = { ...registry.defaults(classNumber), name, imageURL: imageName,
        imageVersion: assets[imageName].version, position: [...position], colorMap: colors(),
        common_flags: portable ? 0 : 2, ...options.fields };
      if (Object.hasOwn(fields, 'reducedCapacity')) fields.reducedCapacity = definition.capacity;
      registry.validateObject({ classNumber, fields }, { strictFields: true });
      const id = draft.next.object++;
      draft.objects[id] = { id, classNumber, regionId, containerId: options.containerId ?? null,
        ownerId: null, capacity: definition.capacity, portable, locked: false,
        fields, ...options.properties };
      if (options.containerId !== undefined) draft.objects[id].slot = position[0];
      createdIds.push(id); objects[key] = id;
      return id;
    };

    add('atm', 33, start.id, 'Local bank', 'o.atm01.img', [330, 220, 0], {
      portable: false, fields: { choreState: 1 }, properties: { public: true,
        description: 'Your opening balance is 1000 tokens. Withdraw tokens here before buying items; deposits return held tokens to your bank account.' },
    });
    const greeter = add('greeter', 200, start.id, 'Local guide', 'a.fjdefmale.img', [210, 220, 0], {
      portable: false, fields: { npc_flags: 4 }, properties: {
        description: 'Talk to this guide for help with materializing, banking, possessions and the three local rooms.',
        dialogue: {
          materialize: 'Use your avatar menu to materialize from Ghost form. You can then walk, speak, carry objects and use the bank.',
          bank: 'Your bank account starts with 1000 tokens. Use the Local bank to withdraw tokens. The Library shop has a free teddy and items costing 5 or 10 tokens.',
          pickup: 'Materialize and keep your hand empty, then choose Get on an unowned object. Use your pockets to store it. Objects and balances survive server restarts.',
          default: 'Welcome! Materialize from Ghost form to walk and carry things. The Local bank holds your starting 1000 tokens. Visit the Library shop for a free teddy, or the Garden to adopt a dog. Ask me about materialize, bank or pickup.',
        },
      },
    });
    add('greeterHead', 24, start.id, 'Guide head', headName, [1, 0, 0], { containerId: greeter });
    const shop = add('vendroid', 57, library.id, 'Library gifts', 'o.vendo1.img', [420, 220, 0], {
      portable: false, fields: { currentSlot: 1, vendo_flags: 1 },
      properties: { public: true, description: 'Browse the gifts: the teddy is free, cocoa costs 5 tokens and roses cost 10 tokens. Purchases transfer an existing item; stock is finite.' },
    });
    // Native Vendroid slot 0 is its display; currentSlot reserves the displayed
    // item's home slot. Browse swaps the display with another stock home slot.
    for (const [key, name, image, index, price] of [
      ['teddy', 'Welcome teddy', 'o.teddy.img', 0, 0],
      ['cocoa', 'Cup of cocoa', 'o.cocoacup.img', 2, 5],
      ['roses', 'Garden roses', 'o.arboroses.img', 3, 10],
    ] as [string, string, string, number, number][]) {
      add(key, 27, library.id, name, image, [index, 0, 0], {
        containerId: shop, fields: { salePrice: price, common_flags: 2 },
        properties: { description: `${name}. Available from the Library gifts machine for ${price ? `${price} tokens` : 'free'}.` },
      });
    }
    add('pet', 201, garden.id, 'Garden dog', 'o.dog1.img', [340, 220, 0], {
      fields: { owner: 0 }, properties: { adoptable: true,
        description: 'An unowned dog. Materialize, empty your hand and choose Adopt pet to name it and make it yours.' },
    });

    const installed = { id: STARTER_CONTENT_MIGRATION, version: 1, installedAt: worldStore.clock(),
      createdIds, objects, regionIds: { start: start.id, garden: garden.id, library: library.id },
      assets: Object.values(assets) };
    draft.contentMigrations ??= {};
    draft.contentMigrations[STARTER_CONTENT_MIGRATION] = installed;
    return installed;
  }, { action: 'starter-content-installed', details: { migration: STARTER_CONTENT_MIGRATION } });
  return structuredClone(marker);
}
