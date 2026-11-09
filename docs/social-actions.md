# Social and avatar actions

`src/social-actions.ts` implements the client request contracts listed below.
Message IDs, reply IDs and field names come from the recovered WA CUTESI
descriptors and Tcl methods. The persistence and authorization rules are
authored server behavior; they are not recovered original server source.

## Implemented native contracts

| Request | Reply | Action / notices |
| ---: | ---: | --- |
| 72 | 73 | Avatar room speech; other room clients receive notice 74 |
| 109 | 111 | Online ESP to a named avatar through notice 110; an offline recipient offers the original mail dialog through notice 243 |
| 171 | 172 | Start/end private or public web tours; notice 173 updates tour state |
| 175 | 70 | Allow/remove a named current-room tour participant; notice 177 |
| 179 | 180 | Join/leave a web tour; private tours require an invitation |
| 183 | 70 | Publish HTTP/HTTPS tour URL to accepted followers through notice 184 |
| 241 | 242 | Case-insensitive lookup of a known avatar's canonical name |
| 244 | 70 | Durable ESP mail, waiting flag and online notification 248 |
| 247 | 246 | Read a bounded batch of unread ESP mail |
| 1570 | 1571 | Avatar walking; room notice 1572 and same-room followers |
| 1587 | 1588 | Ghost transition through the runtime actor-conversion hook |
| 1591 | 70 | Touch another nearby current-room Avatar; safe information notice 118 |
| 1594 | 1596 | Avatar gesture; other room clients receive notice 1595 |
| 1600 | 70 | Follow a current-room online Avatar; notice 1601 |
| 1603 | 70 | Stop following or stop an Avatar following you; notice 1604 |
| 1616 | 70 | Set Avatar mood 0–4; notice 1617 |
| 1688 | 70 | Set Avatar facing 0–3; notice 1689 |
| 1916 | 73 | Room/world status, token balance, time and persisted status flags |
| 2003 | 73 | Ghost status |
| 2005 | 2006 | Materialization through the runtime actor-conversion hook and returned contents vector |

`SUPPORTED_REQUESTS` exports the request/reply/class metadata used by the
coverage ledger. Unknown requests return `false` so the runtime can handle or
reject them explicitly. They never receive fabricated success replies.

The Avatar-class actions require class 21. Original Ghost class 22 does not
have the speech, walk, mood, facing and gesture notice methods. The client also
blocks Ghost room speech locally. A visible speaking Avatar can be heard by a
Ghost listener only when that speaking Avatar exists in the listener's CV;
notice 74 is addressed to the speaker's installed Avatar object. ESP and mail
use native/global or Region notice paths and remain available in Ghost mode.

## Persistent state and constraints

The module changes world state only through `WorldStore.transaction`. Actor
position, orientation, mood, follow relationships, tour preferences, friends,
ignored avatars, status flags and online-time counters survive restarts.
Follow and web-follow references are stored as stable global object/avatar
IDs. The runtime maps them to native session NOIDs when serializing instances.

Room speech and online ESP are transient. ESP mail is durable: its message,
recipient mailbox membership and waiting flag commit in one atomic transaction
before a success reply or notification is emitted. Reading retains each mail
record and sets its `readAt`, allowing authenticated management views to retain
history. ESP reads exclude physical parcels (`objectId`) and attachment/parcel
metadata: those records keep their unread/delivery state and archived object
until the Postbox's one-time request 4457 delivers them. The ESP waiting flag
therefore represents unread text mail, separately from physical parcel waiting.
Native responses are bounded to roughly 60 KiB per batch (one larger
valid letter is allowed); additional unread letters stay unread and generate
a waiting notification. Pipe characters in rendered letter bodies become the
single-byte broken-bar character so a body cannot inject the client's mail-list
delimiter. Original stored content is preserved.

Actor actions cannot target another player's body. Following requires a
current-room online avatar, respects the leader's refusal flag and rejects
cycles. A player may stop only their own following or a follower who currently
follows them. Same-room follower movement commits with the leader movement;
exit/teleport travel is handled separately by the runtime.

Text is validated for the native Windows-1252 encoding, including smart quotes
and the euro symbol. NUL/control injection and oversized strings are rejected.
Tour URLs permit only HTTP/HTTPS and exclude embedded credentials. On-duty
status requires a builder or administrator role; status messages do not grant
roles or privileges.

`register(session)` records a connection start and `onDisconnect(session)`
adds elapsed online seconds exactly once. The runtime calls these lifecycle
hooks; status request 15 resets the accumulated timer.

## Actor conversion integration

`setActorMode(session, mode, coords)` must return:

```js
{ actorNoid, contentsVector, afterReply }
```

`afterReply` is optional. The module first emits the recovered 1588 or 2006
reply using the original request NOID, then invokes that callback. This order
matters: the original Ghost command hides the old Avatar, shows existing Ghost
15 and sets `PlayerActor`; materialization sets the new actor and unpacks the
reply's contents vector. A full refresh before the reply could discard the
pending command's target. Avatar-mode scene projection must keep Ghost 15
available for that transition. The runtime owns the actual class/body/head/CV
conversion, not this module.

## Authored management helpers and receiver limits

`setFriend(avatarId,targetId,enabled)` and
`setIgnored(avatarId,targetId,enabled)` persist authenticated management changes
when invoked by the server's management surface. They do not imply a recovered
native mutation protocol: the original Tcl ignore command 99 changes its local
`Ignored` array and sends only name-lookup request 241. That lookup cannot tell
the server whether the user chose ignore or unignore. A server-side persistent
ignore update therefore needs the authenticated management adapter or a client
extension. This distinction is retained in the coverage documentation.

The supplied notice-1592 Tcl references `$toucher` without assigning it from
the notice first. The touch implementation uses the installed Region
information notice 118 for the recipient, while retaining the command's 70
acknowledgement and local initiating animation. This is an explicit authored
receiver workaround, not a claim that the missing assignment was recovered.

Tests use the real recovered message schemas for all emitted replies/notices,
different session NOID maps, durable reopen checks, ownership failures,
bounded mail batches, ignore preferences, follower cycles and conversion reply
ordering. They do not establish Windows GUI behavior for every later action.

## WorldsAway.app extensions

Online following chains now travel across region boundaries with per-follower admission and population checks. Carried objects and adopted pets move in the same transaction. Changing Avatar/Ghost mode clears following consistently. Robot speech uses owned class-40 objects. Status 59 distinguishes held and pocket cash from bank funds. See [special automation](special-automation.md).
