# WorldsAway.app persistent world and native scenes

The default `region` profile runs an authoritative shared world through
`src/runtime.ts`, backed by `src/world-store.ts`. Regions, objects, actor
mode, possessions, bank balances, documents, mail, leases, preferences and
configured timers survive a restart. Original resource caches provide the
client's classes, Tcl methods and images; they are not a recovered server
database.

The user confirmed the earlier 0.2.0 native connection. Automated checks cover
the new protocol/state behavior, but do not establish that every new menu and
editor path works interactively in Windows.

## World and identity model

The account database owns account authentication and avatar slots. The world
database adds a profile for each account avatar when needed. New profiles
start as ordinary players in Ghost mode, with an authored opening bank balance
of 1,000. The role is not inferred from a client flag or executable choice.

| Persistent record | Purpose |
| --- | --- |
| Region | Stable ID, name, class-20 root object, exits and local properties |
| Object | Stable ID, class, region, optional container/owner, class fields and physical flags |
| Avatar profile | Account/avatar identity, actor object, saved region/mode, bank balance, role and preferences |
| Documents/mail | Object text and private delivered messages |
| Region groups/actions | Authored topology and non-executable action metadata |
| Timers/history | Durable bounded jobs, economic ledger and mutation audit |

Global object IDs in saved state are distinct from native 16-bit object
numbers, or NOIDs. The runtime assigns native numbers for a room and remaps
references for each recipient. The root Region is native 0. The recipient's
Ghost is reserved native 15; ordinary mapped objects start at 16. A client
must not use a NOID from a previous region as a permanent object identity.
Management API object IDs are global IDs.

The store checks parent existence, same-region containment, cycles, container
capacity, owners and avatar/actor consistency before committing. Moving a
container or actor between regions carries its full descendant tree.
See [persistence.md](persistence.md) for exact record shapes and disk recovery.

## Starting and retaining a world

A missing world file receives an authored local starting world with connected
Lobby, Garden and Library regions. The base furnishings are a shared chest,
postbox, garden bench, welcome book and bag. The `starter-1` migration adds:

| Default room | Object and behavior |
| --- | --- |
| Lobby | Class-33 Local bank ATM; class-200 Local guide with a class-24 head |
| Library | Class-57 Library gifts Vendroid with a free teddy, 5-Token cocoa and 10-Token roses |
| Garden | Class-201 adoptable dog, initially unowned |

The guide answers literal materialization, banking and pickup help rules.
The bank exchanges bank balances and physical Tokens. The Vendroid transfers
finite existing stock; it does not create a fresh item on every purchase.
The dog uses the bounded pet adoption/naming behavior.

`src/starter-content.ts` installs that content atomically on new or existing
worlds. It appends eight objects and a `contentMigrations['starter-1']` marker,
including created IDs, selected region IDs and admitted image metadata. It
does not overwrite existing records. The start region and existing secondary
rooms are selected by stable IDs where available, with fallbacks for custom
worlds; the installer does not create or rename regions. Once marked, removed
or purchased content does not respawn on restart. Missing required images
abort the migration instead of installing partial content.

This is a local demonstration world, not an import of historical WorldsAway
data. Builders can extend it using the original editor contracts or
authenticated world API.

The optional [AltAway survey import](survey-import.md) adds the captured regions
to this existing world through an additive migration. Its source properties,
partial coverage, and repeated observations remain preserved as provenance.

Retain the same `data/` directory when replacing server code, then restart
with `npm start`. Existing accounts and world records must not be deleted to
enable new behavior. World changes use validated atomic transactions and
retain the previous `world.json` as `world.json.bak`; an unreadable or
unsupported world fails startup instead of silently becoming a new world.
The additive starter upgrade follows the same backup and rollback behavior.

The launcher isolates downloaded resources by executable and resource-profile
hash. A new default client runtime does not reset the server's account,
inventory, balance or region state. See [launcher.md](launcher.md).

## Ghost, Avatar and inventory

New profiles enter with the original Ghost class 22 and `o.ghost.img` from the
admitted cache. Normal player permissions now enable the client menus used to
materialize into Avatar class 21. Materialization chooses admitted body/head
images, creates a head if needed, and supplies an Avatar with ten inventory
slots. The actor's global ID remains stable across mode changes.

Ghosting retains possessions in the database. The wire Ghost class has no
inventory slots, so carried items are hidden while the avatar is a Ghost.
Materializing exposes those saved items again. For an already materialized
recipient, the runtime also supplies a hidden, session-local Ghost 15 needed
by the native transition; it is not a second account or saved actor.

Slots use the recovered client conventions, including a held item at slot 0
and the head at slot 1. Nested containers retain their contents and owners.
The `reducedCapacity` class field is the usable-slot limit; a new container
defaults it to its class capacity. Offline actors and their carried inventory
are omitted from other users' room scenes without removing saved objects.

Pickup/drop/give, containers, locks, wearing, heads, seating and appearance
changes have server-side ownership, capacity and class checks. A successful
reply represents an authorized state change; arbitrary client fields cannot
claim another avatar's possessions. See [object-actions.md](object-actions.md).

## Scene synchronization

`src/classes.ts` encodes all 58 recovered class definitions and 710 message
schemas. It transmits `b` fields, omits client-only `c` storage, and keeps
server-only `s` fields off the wire. CUTESI field types, counts, signed integer
ranges and Windows-1252 string limits are validated. Native cooked pointer
layout is not the packed network representation.

Initial or replacement scenes send message 145 (`NewCV`) with a two-byte
success value of 1, then message 101 (`HereIs`) with the recovered fixed
prefix and compressed contents vector. Records are ordered root/parent
before children. Each record has a BE16 byte length followed by the complete
class instance, including its class number. Zero-RLE compression is applied
to the vector.

The runtime compares each recipient's previous encoded scene with the current
view. Changed or added objects use message 81 contents vectors. Removals use
the object's message-68 delete method where supported; otherwise a coherent
full scene replaces the view. Joins, departures, movement, actor conversion
and object mutations update other clients in the same region. NOID-valued
notice fields are remapped for each recipient.

Player, builder and administrator menu flags reflect the persisted role.
These are client presentation fields; every sensitive action independently
checks server-side authority. Home owners/co-owners receive the local owner
presentation flag while in their housing region.

## Travel and admission

Regions have four exit slots derived from persisted topology. Request 103
selects an index 0–3, as established by the recovered client method. This
server names the slots north/east/south/west as a local authoring convention.
Doors, elevators, teleports and portkeys use configured local destinations.

Travel validates the destination and commits the profile, actor, coordinates
and all carried descendants together, including logical binder archives. A
travel request that materializes a Ghost can include that mode change and
head creation in the same transaction. Request/reply travel paths prepare
that durable change before acknowledging success, then publish the new scene
after the acknowledgement. A save failure therefore cannot report successful
travel. An error publishing a committed scene remains a transport error,
rather than producing a contradictory second reply.

Admission checks apply to region exits and direct teleport paths. Pending
deletion, private guest policy, housing admission and separate online
Avatar/Ghost population limits can deny entry. Administrators and the home's
owner/co-owners bypass its normal admission limits. Population controls do
not evict existing occupants by themselves; guest-removal actions are
separate. When an active home's `kickOutOnExit` policy is enabled, the last
connected owner/co-owner leaving or disconnecting moves non-owner guests to
the safe start region. Another connected owner/co-owner in that home prevents
the removal; an offline owner's saved location does not count as presence.
Online and offline guest profiles, actors and carried/binder contents move
together, with seats/following cleared. Ground objects, ownership, mail,
balances and document text are retained. Travel commits owner departure and
guest relocation together; live affected clients then receive updated scenes.

Follow relationships cannot create cycles. Following moves same-region followers during walking and carries online following chains across regions after each follower passes admission and population checks. A refused follower stops following. Tours use the recovered social contracts.

Region/group deletion is deferred while a region is occupied. Finalization
cleans inbound exits and group membership, relocates offline profiles and
their possessions safely, and never removes the start region. See
[system-actions.md](system-actions.md) and
[builder-actions.md](builder-actions.md).

## Economy, housing and devices

Physical Tokens (class 26) and the avatar's bank balance are separate stores
of virtual currency. Bank withdrawal exchanges bank balance for held Tokens;
deposit performs the reverse. Devices and housing charge validated held
Tokens according to their local server configuration. Client-provided cost,
refund or balance values do not establish a price or authorize a credit.
Economic updates and associated object changes commit together and record a
ledger entry.

Manager class 46 exposes authored rental plans, payment periods, rent,
availability, owner/co-owner rules, guest policy and refunds. Leases live in
region properties, with a profile home link. Charges consume actual held
Tokens and do not also debit the bank account. Unconfigured plans and
insufficient or incorrect cash fail using the recovered reply contract.

Persistent devices include bank/pawn/vending services, documents and binders,
printing/recycling, post/parcels, registries/banners, clothing/head tools and
configured travel. Specialized classes add data-driven NPC dialogue, pets,
bounded potion effects, bus stops, cashiers, portkeys, server-random slot
machines/spinners and decorators. These are authored compatible behaviors;
they do not claim the original service's exact business rules.

Saved timers contain a kind, deadline and plain data. The runtime applies
recognized bounded jobs, including effect expiry, and does not evaluate a
saved callback or script. Unknown jobs remain inert with an error marker.
Action-editor and NPC source strings are stored as non-executable metadata.
See [special-actions.md](special-actions.md) for supported effects and limits.
Scheduled buses carry seated passengers through configured Bus Stop regions. The default world includes a three-stop shuttle. NPC dialogue programs support bounded conditions, funded trades/rewards and travel; arbitrary original scripts remain unavailable. See [special automation](special-automation.md).

## Authoring and coverage boundaries

Stop the server before changing a local role:

```sh
node dist/src/cli.js --set-role Demo --role admin
```

Restart and reconnect. `builder` permits world authoring; `admin` also permits
the sensitive moderation and other-player actions defined by the handlers.
The editor launcher switch grants neither. Abstract classes and account/group
records are structurally decoded but cannot be spawned as physical objects;
Region and player actors have dedicated lifecycle operations.

The static ledger declares 200 handled request IDs against all 197 distinct
literal Tcl request IDs. It distinguishes declarations from tested behavior
and keeps `allOriginalBehaviorImplemented: false`. Dynamic native paths,
unavailable client methods and exact historical policies remain outside what
that count proves. The resource adapter filters missing class dependencies
from derived served definitions without changing original cache files or
instance schemas. It does not recover the omitted methods.

The explicit `--world-profile empty` profile retains the old transport-only
diagnostic entry. It has no shared gameplay runtime and does not reset saved
world data. No WebSocket relay, arbitrary server-side Tcl evaluator or
external historical world service is implemented.

## Verification

From `server`:

```sh
npm test
npm run smoke
```

Run smoke with a server listening. Tests independently check class/schema
round-trips, contents vectors, session mapping, shared rooms, durability,
authorization, inventory, economy, devices, housing and timed state. Socket
tests can report an explicit skip when the host denies binding. They do not
execute `wa32.exe` or establish every Windows GUI interaction.

See [protocol.md](protocol.md), [feature-coverage.md](feature-coverage.md) and
[feature-coverage.json](feature-coverage.json) for contracts and coverage
evidence; [validation.json](validation.json) records the verification scope.

## WorldsAway.app districts

The initial three rooms are extended by an independent idempotent district migration. A new world has ten regions and 76 objects, with usable examples of all concrete classes. See [districts](districts.md).
