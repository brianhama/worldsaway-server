# Region and global system actions

`src/system-actions.ts` covers seven additional recovered native contracts.
These handlers persist local authoritative state and use the exact original
request/reply field names. They never execute Tcl, native script code or
client-provided expressions.

| Request | Reply | Implemented behavior |
| ---: | ---: | --- |
| 103 | 70 | Use a configured current-region exit, validate entry and travel |
| 124 | 70 | Staff relocation by local address or region-group entry |
| 133 | 70 | Room owner/staff guest admission policy |
| 135 | 70 | Room owner/staff Avatar or Ghost population limit |
| 155 | 156 | Atomic guest policy and both population limits; broadcast 157 |
| 190 | 191 | Reposition an owned or builder-controlled room object; broadcast 192 |
| 1207 | 70 | Configure a Teleport-class connection; broadcast 1208 |

The native flat-menu method `00050ed9.tcl` iterates `validExits` indices 0–3,
starting at the Region orientation, then forwards the selected index to
command 102/request 103. This proves the wire enum. This server's association
of indices with `north/east/south/west` is an authored topology convention;
it is not a claim about the original service's compass labels. The seeded
Lobby exit 0 leads to Garden, for example.

The runtime's `prepareTeleport` first commits the avatar, actor and recursively
contained possessions, updates the session's region, and returns a deferred
publication callback. Only after that durable preparation succeeds does the
handler acknowledge travel success; the callback then publishes the destination
scene. A failed save sends a failure acknowledgement and no scene. This keeps
both requirements: durable state before success, and native success before CV
replacement. Publication failures are transport/runtime errors rather than a
second contradictory response to the same native request.
Missing exits, deleted destinations, guest restrictions and full rooms return
the recovered failure contract instead. Capacity counts online Avatar/Ghost
occupancy separately; an administrator or room owner can bypass entry limits.

Address relocation request 124 resolves a region ID, name, configured address
or alias, with an area code. `goto_reggroup` selects a persisted region group's
entry region instead. A builder can relocate their own avatar; relocating
someone else requires an administrator. Offline administrative relocations
update the stored avatar, actor and carried possessions, including archived
logical binder members and their persisted document text. An
offline `get_real` request is rejected because it cannot complete the client
materialization transition. Online `get_real` supplies Avatar mode to durable
region preparation, committing actor conversion and travel in one transaction.
A failed preparation leaves both the original mode and location unchanged.

Room controls require its primary owner, a co-owner, a builder or an
administrator. Guest policy is stored consistently in the Region root's
`region_flags` bit 2048 and the Region properties; an active housing lease's
guest policy is kept consistent too. Population controls persist
`max_avatars`/`max_ghosts`; the runtime must project these stored values and
honor admission globally, including direct teleport paths. Changing admission
does not automatically evict existing occupants; the separate recovered
guest-removal actions perform that operation.

Object positioning cannot reposition the root Region or change inventory slot
coordinates while an item is contained. It requires ownership, control of the
room, or a builder role. Repositioning someone else's actor specifically
requires an administrator. Coordinates retain the signed BE16 wire range and
orientation is limited to 0–3. The returned/global-notice item reference uses
the runtime's per-recipient NOID mapping.

Connection configuration applies only to class 56 Teleport objects controlled
by the caller. It stores address, five aliases, secret-address choice, area
code, ride cost, entry/exit sounds and operating orientation. A resolvable
local address also supplies `destinationRegionId` for the physical teleport
handler. These are persisted metadata and primitive values; an alias or
address is never evaluated as source code.

Tests encode all replies and notices using the recovered ClassRegistry
descriptors. They cover exit acknowledgement ordering, held-inventory travel,
guest/capacity denials, durable controls after reopen, staff-only address/group
relocation, offline relocation, atomic online materialization, object ownership
and Teleport metadata.
Native inventory request 1605/1711/1714 behavior remains in `object-actions.ts`.
