# Persistent world state

`src/world-store.ts` adds a world database beside the existing account store.
It never reads or writes `accounts.json`, original client caches, remembered
account files or logs. The containing server must keep its existing
`AccountStore` directory lock while this store is active. `WorldStore` does not
take a second incompatible lock.

## Files and commit behavior

| File | Purpose |
| --- | --- |
| `world.json` | Current world snapshot, format 1 |
| `world.json.bak` | Last-good snapshot copied before the most recent replacement attempt |
| `world.json.<random>.tmp` | Short-lived candidate, removed on success or failure |

Every mutation runs in a synchronous transaction. The store clones the current
snapshot, applies the callback, checks the complete object/region graph, writes
and `fsync`s a new file, saves the previous file as a backup, and atomically
renames the candidate into place. The live in-memory state changes only after
the final replacement succeeds. A retained transaction draft cannot mutate
committed state afterward. Read APIs return detached copies.

The directory is also synced where the operating system permits it. Directory
syncing is best effort on platforms that do not support opening/syncing a
directory. This is a single-process JSON store, not a distributed database or
a substitute for an external backup strategy. Snapshots are bounded to 64 MiB.

A corrupt or unsupported file causes an explicit startup error; it is never
silently replaced with a new world. To recover deliberately, stop the server,
preserve the damaged file under a separate name, inspect `world.json.bak`, then
restore the validated backup as `world.json`. A restored backup loses changes
made after that snapshot. There is no destructive automatic format migration.

## Schema

The root contains `format`, `revision`, creation/update timestamps,
`startRegionId`, counters in `next`, and these maps. Map keys are stringified
numeric IDs, while record IDs are numbers. IDs are stable across restarts;
native client noids are assigned by the runtime rather than persisted here.

| Map | Record shape |
| --- | --- |
| `regions` | `{id,name,objectId,exits,properties}` |
| `objects` | `{id,classNumber,regionId,containerId,ownerId,fields,capacity,portable,locked}` |
| `avatars` | `{id,accountId,name,objectId,regionId,balance,ghost,role,preferences,friends,ignored,mailbox}` |
| `documents` | `{objectId,title,text,updatedAt}` |
| `mail` | `{id,fromId,toId,fromName,subject,body,createdAt,readAt}` |
| `timers` | `{id,objectId,kind,dueAt,payload}` |
| `regionGroups`, `actions` | Plain JSON records owned by builder/runtime handlers |
| `contentMigrations` | One-time authored-content markers, including `starter-1` |

`ledger` stores balance transfers/opening balances. `audit` keeps the latest
5,000 mutation records. Additional plain JSON runtime fields can be stored
without changing the persistence layer. Functions, class instances, undefined
values, non-finite numbers, excessive nesting and reserved prototype keys are
rejected. Decoded Buffer/typed-array fields are canonicalized to numeric arrays
before saving, so dynamic CUTESI byte fields round-trip as plain JSON.
Wire schemas and server-only class fields belong in `object.fields`;
the class registry determines which fields are transmitted. Client-only
pointers/callbacks should not be persisted.

Each region's `objectId` identifies its class-20 root. Contained objects must
exist in the same region as their parent, containment must be acyclic, and
direct child counts must fit container capacity. Owned objects reference a
world avatar profile. Each avatar's object must belong to that profile and
share its region. Money uses nonnegative safe integers; public transfer helpers
reject fractional values, overdrafts and overflow.

## Initial authored world

On the first start the default store seed creates a lobby, garden and library
with connected exits, a shared chest, postbox, bench, welcome document and bag.
The gameplay runtime then calls `ensureStarterContent` from
`src/starter-content.ts` on new and existing worlds. Its `starter-1` migration
adds eight objects using validated class fields and admitted images:

| Default room | Additional objects |
| --- | --- |
| Lobby | Local bank ATM; Local guide NPC and its head |
| Library | Library gifts Vendroid; free teddy, 5-Token cocoa and 10-Token roses |
| Garden | Unowned adoptable dog |

The existing start and secondary region IDs determine placement, with
fallbacks for custom worlds. The migration does not create or rename rooms,
overwrite existing object/profile records, reset balances or edit accounts.
All new objects and `contentMigrations['starter-1']` commit atomically. The
marker records version/install time, created object IDs, selected room IDs
and image version/checksum metadata. A failure leaves no partial installation.
The normal previous-snapshot backup is retained.

Once marked, the migration does not run again. Purchasing or deleting stock
does not make it respawn on restart. The Vendroid sells finite saved objects,
rather than an unlimited product template. This is authored local demo state;
no historical world database or full NPC script engine is included.

`ensureAvatar(accountAvatar)` initializes a stable world profile for an existing
account avatar with a Ghost object, opening balance 1,000, empty preferences,
friend/ignore lists and mailbox. New profiles begin in **Outside The Rose** when
available. The imported region's stable source identity takes precedence over
its name, so renaming it preserves the arrival destination. Regions pending
deletion are excluded; without an available Rose region, the configured
`startRegionId` is used. Existing profiles retain their saved region.
It accepts explicit `regionId`, `classNumber`,
`role` and `balance` options. The default Ghost preserves the earlier connected
scene. The store initially creates a zero-capacity Ghost; the gameplay runtime
materializes it into a ten-slot Avatar and creates its head when needed.
Subsequent ghosting retains the saved ten-slot inventory server-side and hides
its contents from the Ghost wire view. It does not erase carried possessions.
An explicit initial class-21 profile still requires the caller to supply the
complete appearance/inventory setup.

Roles are `player`, `builder` and `admin`. The persistence API stores a role;
network action handlers must decide which authenticated account can assign or
exercise it. `WorldStore` does not grant a role based on client-supplied flags.
Stop the server, use `node dist/src/cli.js --set-role Demo --role admin` from
`server`, then restart to grant the local Demo avatar explicit authority.

Bank balances and physical class-26 Tokens are separate. Opening balances and
bank exchanges are recorded durably; paid devices and housing consume held
Tokens according to authoritative prices. Restarting or applying content
migrations does not replenish a profile's opening balance.

`src/presence-policy.ts` applies the authored housing `kickOutOnExit` rule
inside the runtime's transaction. The last connected owner/co-owner leaving
or disconnecting relocates online and offline non-owner guests to the safe
start region. A connected co-owner prevents removal; an offline owner's
saved region does not. Guest actors, nested inventory and logical binder
archives move together, clearing seating/following while retaining IDs,
ownership, mail, balances and document text. Ground furnishings and guest
ground possessions stay in the home. Travel and its guest relocation commit
together; a bad fallback or failed save aborts that transaction. Publication
updates live sessions after the durable change.

## API

```js
const world = new WorldStore(dataDir, {
  clock: () => Date.now(),
  seed: true,
  startRegionName: 'WorldsAway.app Lobby',
});
const profile = world.ensureAvatar(accountAvatar);
const snapshot = world.snapshot();
```

Reads are `snapshot`, `getRegion`, `getObject`, `getAvatar`, `listRegions`,
`listObjects(filters)`, `getDocument`, `listMail` and `dueTimers`.

Mutation helpers are:

- `createRegion({name,exits,properties,fields})`.
- `createObject({classNumber,regionId,containerId,ownerId,fields,capacity,portable,locked})`.
- `updateObject(id,patch,{actorId,admin,allowUnowned})`.
- `moveObject(id,{regionId,containerId,position},{actorId,admin,allowUnowned})`.
- `deleteObject(id,{actorId,admin,allowUnowned,recursive})`.
- `transferFunds(fromId,toId,amount,{reason})`.
- `updatePreferences(avatarId,patch)` and
  `setRelationship(avatarId,otherId,'friends'|'ignored',enabled)`.
- `writeDocument(objectId,{title,text},{actorId,admin,allowUnowned})`.
- `sendMail(fromId,toId,{subject,body})`, `readMail(avatarId,messageId)` and
  `deleteMail(avatarId,messageId)`.
- `scheduleTimer(objectId,kind,dueAt,payload)`, `cancelTimer(timerId,options)`
  and `consumeDueTimers(now)`.
- `finalizePendingRegions(occupiedRegionIds)` for delayed region/group retirement.

Moving a container moves all descendants to the destination region. The public
move helper enforces portability, ownership, locked/foreign destinations,
capacity and cycle checks. Deleting an occupied container requires `recursive`;
its documents and object timers are removed too. Region roots and avatar
objects require explicit lifecycle operations rather than generic deletion.

Mail is private to its recipient; avatar mailboxes contain numeric IDs into
the global mail map. Ignored senders are rejected and mailboxes are bounded to
1,000 messages. Profile IDs must exist before relationships or messages can
refer to them, including offline account avatars.

Durable timers contain data, not executable callbacks. The runtime consumes
due records atomically in due-time/ID order and dispatches the known `kind`.
Consumption happens at most once in the state store; an external side effect
after consumption still requires its own idempotence/retry policy. The store
never evaluates a saved action or timer as JavaScript/Tcl source.

Delayed retirement recognizes `region.properties.pendingDeletion` and
`regionGroup.pendingDeletion`. Occupied regions are retained; the designated
start region is never deleted. Once a pending region is empty, offline avatar
actors, nested inventory, owned ground possessions and their logical binder
contents are preserved in the start region (or with an already-moved binder).
Public region furnishings and their documents/timers are removed. Inbound
exits and region-group membership are repaired; a pending group disappears
after its final member is removed. Avatar identities, balances and private
mail remain intact. The helper returns deleted region IDs and relocated avatar
IDs and records an intentional audit entry. The runtime must reject new entry
into retiring regions and call this helper after travel/disconnect/startup.

For compound server actions:

```js
const result = world.transaction(draft => {
  const object = draft.objects[objectId];
  // The authenticated handler performs its action-specific checks here.
  object.fields.name = newName;
  return { objectId };
}, {
  actorId,
  action: 'rename',
  details: { objectId },
  authorize: snapshot => /* server policy */ true,
});
```

Transactions must be synchronous and cannot nest. An authorization hook must
return `true` to proceed. This API is a trusted server boundary: raw client
messages must not be passed to a draft callback without handler validation.
The global validator enforces state consistency, not the complete semantics
or authorization policy of every class action.

World avatar names are separate from the account store's chooser names.
Gameplay renaming must synchronize those names through the account runtime or
define an explicit alias policy; this module never edits the account file.

## Validation

Run `node --test server/test/world-store.test.mjs` from the project root.
The tests cover startup, restart, detached state, transaction failure, injected
disk replacement failure, stable counters, ownership/capacity/cycle checks,
balance conservation, private mail/documents and preservation of corrupt files.

## WorldsAway.app districts and transport

A separate idempotent `worldsaway-districts-1` migration adds seven districts, all concrete class examples, and a three-stop shuttle. `busRoutes` stores schedule progress in world.json. Use `--no-districts` for a new small starter-only world. Neither migration respawns purchased/deleted objects after its marker is installed.

The additive `worldsaway-bank-state-1` device-state repair activates the unmodified starter bank's operational native image state once. It preserves renamed/reconfigured banks and player balances, and its marker commits atomically with the state correction.
