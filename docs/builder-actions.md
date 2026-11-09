# Scene Builder, region editing and player housing

`src/builder-actions.ts` implements 55 request contracts recovered from the
cached client Tcl and message descriptors. It uses the shared class registry
for types and packet encoding and the world store for atomic persistence.

This module separates two authorities:

- Editor operations require a persisted avatar role of `builder` or `admin`.
  A client's actor flags, object `userLevel`, permission bits, or a `role` field
  in a request do not grant that role.
- Personal home and owned-object operations require the persisted owner,
  co-owner where appropriate, or server administrator. Ordinary players can
  rent and pay for their own homes without receiving editor privileges.

All identities and native NOIDs are resolved through the runtime. An arbitrary
global object ID supplied by a client is not a substitute for an accessible
native object reference. The class registry validates edited instance fields;
identity, ownership, actor links, roles and balances cannot be changed through
the generic field/property editor.

## Recovered request families

| Requests | Replies | Implemented behavior |
| --- | --- | --- |
| `200`, `5310` | `70`, `5311` | Create one or a bounded batch of concrete class instances; Builder variant returns the new native NOID |
| `201`, `5314` | `70` | Duplicate an empty object, retaining its class fields and properties |
| `202`, `5318` | `70` | Delete a non-actor, non-region empty object; protect managers with active leases |
| `3051`, `3053` | `70` | Legacy Fiddle create/delete aliases with the same server-side editor authority |
| `203`, `206` | `204`, `207` | Read typed fields and list writable server/both fields |
| `205` | `80` | Change a typed field, returning an updated contents vector and refreshing observers |
| `208`, `210` | `209`, `70` | Read/write named editor properties |
| `211` | `212` | Public-safe menu metadata: URL, help, description and `.popDests` |
| `161`, `165`, `194`, `186` | `162`, `70` | Read URL, set an owned object's HTTP(S) URL/label, description and glue state |
| `5302`, `5306`, `5333`, `5322` | `70`, `5323` | Builder rename, description, color map, and the original newline-based object editor payload |
| `220`, `221`, `222`, `223`, `225`, `226` | `70`, `224`, `227` | Create, duplicate, mark for deletion, inspect, modify and list regions |
| `230`, `231`, `232`, `233`, `235`, `236`, `237`, `238` | `70`, `234`, `239` | Create/duplicate/mark/inspect/modify region groups; add/remove members and list groups |
| `30001`, `30003`, `30004`, `30006` | `30002`, `70`, `30005` | Inspect/edit action bindings and persist named action source as non-executable metadata |
| `4001`, `4005`, `4009`, `4013`, `4016`, `4020`, `4024`, `4028` | `4002`, `4006`, `70`, `4014`, `4017`, `4021` | Rental-manager plan information, lease creation/payment/break, quote, information URL, co-owners and address changes |
| `131`, `137`, `139`, `141`, `143`, `147`, `150` | `70`, `148`, `151` | Home guest admission/owner-exit policy, active guest eviction, owners and access information |

An unknown request returns `false` to the enclosing dispatcher. A malformed,
inaccessible or unauthorized recognized request gets its matching failure
reply. Requests are not acknowledged with fabricated success.

## Class-neutral editor behavior

Concrete classes with complete native identity, containment and position fields
can be authored using the recovered class defaults. Abstract base classes
0–4, server-only Account/Region Group classes 10/11, Region 20, Avatar 21 and Ghost 22 have dedicated
lifecycle paths and cannot be created/deleted as ordinary items. Region roots
are created with valid Region schemas; actor creation remains the account and
world runtime's responsibility.

Numeric scalar/array fields are checked against their CUTESI widths and array
lengths. Fixed text follows the client's Windows-1252 encoding and bounds.
Client-only pointer/callback fields are excluded. Effective container capacity
updates must fit the class's native slot count and cannot strand existing
contents. New containers initialize `reducedCapacity` to the usable slot count,
not to zero or an amount to subtract.

The `5322` object editor follows `000c0070.tcl` exactly: name, glued/background/
immobile flags, image filename/default, chore, price, sixteen colors, URL label,
URL, help, orientation, coordinates, then class-specific extras. Filename
images must exist in the admitted resource store. The glue, background and
immobile bits are `512`, `4` and `2` as recovered from the client helpers.

Region duplication copies authored world objects and document text while
remapping container identities. It does not duplicate an actor or the
contents of an actor's inventory. Object duplication requires an empty
container, matching the client's editor checks.

Region/group destruction is deferred: the request sets
`region.properties.pendingDeletion` (and `group.pendingDeletion`) and the world
runtime finalizes it after the last active occupant departs. The start region
cannot be marked. Store cleanup preserves offline actors/possessions and
removes dangling exits and memberships.

Region listings use explicit IDs plus Tcl-safe text lists. Group details use
the recovered 32-element numeric tables and authored 32-by-32-byte name/address
tables. The protocol shape is checked against CUTESI; the complete original
Reno GUI list/navigation behavior is still a separate interoperability test.

## Authored player housing

Manager is class **46**. Its eight `rent` and `num_available` values, or an
administrator-authored `manager.properties.plans[plan]`, define the server's
plans. No current or historical AltAway prices are inferred from the client.

Each optional plan may specify:

```js
{
  rent: 100,
  available: 4,
  periodMs: 604800000,
  maxAdvance: 12,
  info: "A locally authored weekly home lease."
}
```

Without overrides, rent and availability come from the Manager instance's
eight-element fields. The authored defaults are a seven-day period and up to
twelve prepaid periods. A plan with no available homes cannot be rented.

A successful rental creates a new region and stores:

```js
region.properties.housing = {
  ownerId, coOwnerIds: [], guestAllowed: true, kickOutOnExit: false,
  managerId, plan, rent, periodMs, maxAdvance, paidUntil
};
```

The avatar's primary-home ID and native `home_areaCode` are updated together.
Addresses are unique, co-owners must be existing avatars, and only the primary
owner or administrator can change the address, add co-owners, or end the lease.
Co-owners may inspect/pay rent and manage guest policy.

Currency is the actual held class-26 Tokens object with `fields.denom`, in the
actor's slot 0. Renting consumes **exactly** the quoted initial rent, once.
It never additionally debits the avatar's separate bank balance. A rent
payment must be a valid number of periods within the server-derived quote;
the amount is taken from held tokens, not a client-supplied price. Payments,
availability, lease state, physical cash and the ledger commit atomically.

Lease breaking returns whole unused periods minus an administrator-configured
`manager.properties.breakPenaltyPeriods` (default one). Any refund is a new
owned Tokens object in an empty hand and is included in the reply contents
vector. The home is then marked for deferred deletion and primary-home links
are cleared. These are explicit local rules, not a recovered upstream billing
implementation. Automatic rent collection or historical eviction schedules
are not reconstructed by this module.

The world runtime enforces `guestAllowed` on admission, allows owners/co-owners
through, and applies `kickOutOnExit` when the last active owner leaves. The
eviction requests target active guests and move them to the start region
through the runtime's normal teleport path. Owner names are ordinary visible
avatar names; account names, balances and saved credentials are not exposed.

## Stored action source and special classes

The original action editor exposes a text script field. This module stores and
retrieves that source and its binding, but marks it `executable: false`.
It never calls `eval`, `Function`, a shell, a CLR, a Tcl interpreter or a native
helper. Arbitrary upstream server scripts cannot be safely or accurately
reconstructed from client metadata alone.

NPCs, pets and other special classes can be created, persisted and edited
structurally through the same class registry. Their action semantics belong to
the gameplay modules and coverage ledger; editor support alone does not prove
all original NPC scripting, minigames or external integrations exist.

## Evidence and validation

The request IDs, reply IDs and editor field order come from:

- `wa-analysis/resources/extracted/text/000c006b.tcl` and `000c0070.tcl`.
- Region policy scripts `0005007e`, `00050080`, `00050082`, `00050084`,
  `00050089`, `0005008b` and the access helpers in `000c006c`.
- Builder scripts `000514b7`, `000514bb`, `000514c2`, `000514c6`, `000514ca`,
  `000514d4`.
- Manager scripts `00050fa3`, `00050fa6`, `00050fa9`, `00050fae`, `00050fb1`
  and `000c006f`.
- Matching type-4 CUTESI resources for every request and response.

Run:

```sh
node --test server/test/builder-actions.test.mjs
```

The focused tests exercise matching schema replies, persisted authority,
rollback, cloning/deletion safeguards, field/image validation, complete editor
payloads, region/group integrity, safe stored source, physical cash/rent,
co-owners, guest policy and eviction. They do not constitute a Windows editor
GUI or original-service billing test.
