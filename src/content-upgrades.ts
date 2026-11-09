import type { WorldStore } from './world-store.js';
/** Idempotent native device state repairs for already installed authored content. */
export function ensureContentUpgrades(store: WorldStore) {
  const migration = 'worldsaway-bank-state-1';
  const before = store.snapshot();
  if (before.contentMigrations?.[migration]) return before.contentMigrations[migration];
  return store.transaction(draft => {
    const bankId = draft.contentMigrations?.['starter-1']?.objects?.atm;
    const bank = draft.objects[bankId];
    let updated = false;
    // o.atm01.img state0 is named "off"; state1 is its operational "default".
    // Only repair the unchanged original starter device; retain operator changes.
    if (bank?.classNumber === 33 && bank.fields.name === 'Local bank'
        && bank.fields.imageURL === 'o.atm01.img' && bank.fields.choreState === 0) {
      bank.fields.choreState = 1; updated = true;
    }
    const marker = { id: migration, installedAt: store.clock(), updated, bankObjectId: bankId ?? null };
    draft.contentMigrations ??= {}; draft.contentMigrations[migration] = marker;
    return marker;
  }, { action: 'worldsaway-device-states-upgraded' });
}
