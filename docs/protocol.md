# WorldsAway.app protocol and shared-world runtime

The target is the supplied `wa32.exe` build, SHA-256
`e1bb810fcbbd74fca716066b7568b0da7b6f64195875f83f069c69387279b7f8`,
with its recovered MAG descriptors and Tcl request/reply contracts. Native
world/RPC integers are big-endian unless stated otherwise.

The server has codecs for all 58 class definitions and 710 message schemas.
Those descriptors include requests, replies and notices; they are not 710
independent server actions. The handler ledger registers 204 IDs against 197
distinct literal request IDs from 258 static Tcl candidates. Original server
business rules are authored locally and tracked separately from structural
and request-declaration coverage.

## HTTP discovery, login and cache updates

`GET /worlds3.php?v=<launcher-version>` returns:

```text
<world-name>|http://<advertised-host>:<http-port>/login|wa32.exe||worldsaway-images.zip
```

The five pipe-separated fields are display name, login URL, executable, flags
and image archive filename. Empty flags select direct TCP. No `w` flag or
WebSocket relay is advertised. The original launcher's doubled slash after a
trailing Webhost slash is normalized before routing.

`POST /login` accepts form fields `username`, `password` and
`action=Login`. The JavaScript helper uses `POST /connect.iv` with
`account`, `password` and optional owned `avatar`. Encode form values;
the original .NET launcher's raw concatenation has metacharacter limitations.

Success returns an ASCII CR/LF Connect record:

```ini
[Message]
messagetype=Connect
[Connect Info]
worldname=WorldsAway.app
serveraddr=127.0.0.1
loginport=1701
rpcport=1702
acctname=demo
username=demo
avatarname=Demo
loginregion=1
onetimepass=<15-character ticket>
```

Actual host/ports come from configuration. Passwords are absent from this
file. A ticket expires, is account-bound and, when explicitly selected,
avatar-bound. It is consumed once at native login and is invalid after a
server restart. Persistent world location comes from the avatar profile,
rather than treating a handoff region as authorization to enter any room.

`GET /health` provides version, ports, resource profile, counts and world
revision. `GET /files/worldsaway-images.zip` returns a clean rebuilt native WSRES
pair for the configured world; see [archives.md](archives.md).

## Management interfaces

All authenticated routes below use POST form data with `account`,
`password`, optional owned `avatar` and `action`. They are management
interfaces, not arbitrary native-message injection endpoints.

| Endpoint | Actions and authorization |
| --- | --- |
| `GET /api/classes` | Public class names, capacities and instance schemas |
| `GET /api/coverage` | Public static resource/handler ledger and limitations |
| `POST /api/avatars` | Owned list/capacity; `action=create&name=...` within account slots |
| `POST /api/profile` | `get`, `preferences`, `friend`, `unfriend`, `ignore`, `unignore`; own profile only |
| `POST /api/world` | Persisted builder/admin role; `get`, `create-region`, `create-object`, `update-object`, `delete-object` |

Profile preferences permit only the defined personal display/messaging flags;
the route cannot grant a role or staff privilege. Relationship changes use an
existing world's canonical avatar name.

World mutation parameters include:

| Action | Parameters beyond authentication |
| --- | --- |
| `create-region` | `name`; optional `fields` and `properties` JSON-object strings |
| `create-object` | `classNumber`, `regionId`, optional `data` JSON object |
| `update-object` | Global persistent object `id`, `data` JSON object |
| `delete-object` | Global persistent object `id`; optional `recursive=true` |

The object's `data.fields` follows its class schema. Identity, class,
ownership, container and region IDs cannot be patched through `data`;
dedicated lifecycle/containment operations maintain those invariants.
Abstract/base, Account, Region Group, Region, Avatar and Ghost classes have
dedicated lifecycles and are not ordinary object-create classes. Class
capacity, field encoding and admitted image names are validated. Staff role
checks are based on saved server state, never on client permission flags.
Builder world views exclude the administrator's broader profile/history data.

## World frame envelope

Each frame has an eight-byte header followed by exactly the announced body:

| Offset | Encoding | Meaning |
| ---: | --- | --- |
| 0 | BE uint16 | Receiver object/noid |
| 2 | BE uint16 | Message ID |
| 4 | BE uint32 | Body byte length |

The decoder supports fragmented headers/bodies and multiple frames in one
read, with input-buffer and body limits. The shared gameplay queue serializes
mutations; network writes use bounded backpressure and settle on close/error.

### Login and avatar selection

Client `10/11` accepts two exact body layouts: the 282-byte packed message
descriptor and the 288-byte native Windows buffer. Both use these offsets:

| Offset | Bytes | Construction |
| ---: | ---: | --- |
| 0 | 256 | NUL-terminated account |
| 256 | 16 | NUL-terminated ticket |
| 272 | 4 | Resource update cursor |
| 276 | 2 | Locale; WA initially sends 0 |
| 278 | 2 | Architecture; initially 2 |
| 280 | 2 | Client version; initially 325 |
| 282 | 6 | Present only in the native padded layout; unused |

The recovered descriptor [`0004000b.cutesi.txt`](../../wa-analysis/resources/extracted/text/0004000b.cutesi.txt)
contains 282 explicit bytes. Native
[`0x004128a0`](../../wa-analysis/native-survey/ghidra-wa32/functions/0x4128a0.json)
clears a 288-byte buffer, sets the fields above, converts the integer fields
to network byte order, and appends all 288 bytes. The remaining six bytes are
zero in that construction. The server ignores these unused bytes when the
padded layout is received. Other body sizes are rejected with the received
size in the diagnostic; this does not establish which layout a particular
user's client sent.

The initial architecture and version values are data, not layout selectors:
the supplied WA binary starts with architecture 2 and version 325, but no
recovered branch chooses a different login layout from those fields. The
eight-byte frame header is separate from either body size. Native
[`0x00492610`](../../wa-analysis/native-survey/ghidra-wa32/functions/0x492610.json)
swaps the header's two uint16 fields and uint32 body length without adding
another header or changing that length.

After validation, configuration `10/10` has heartbeat and three inactivity
uint32 words. Avatar list `10/12` is 276 bytes:

| Offset | Encoding | Meaning |
| ---: | --- | --- |
| 0, 2 | uint16 each | Native leading fields |
| 4 | uint32 | Current avatar count |
| 8 | uint32 | Account capacity / chooser slots |
| 12 | uint32 | Busy mask |
| 16 | uint16 | Reserved |
| 18 | Eight 32-byte names | Unused slots zero |
| 274 | uint16 | Ignore-scope field |

The avatar-list descriptor itself totals 276 bytes; no extra structure padding
is needed. The native receiver at
[`0x0043f520`](../../wa-analysis/native-survey/ghidra-wa32/functions/0x43f520.json)
reads its fields at the same offsets.

Client `10/13` accepts its 70-byte packed descriptor or 72-byte native buffer:
name[32], region uint32 at 32, two dummy bytes and 32 opaque machine bytes.
Native [`0x00413bc0`](../../wa-analysis/native-survey/ghidra-wa32/functions/0x413bc0.json)
clears and appends 72 bytes, leaving two unused trailing bytes. The server
ignores those bytes in the padded form. Account ownership, ticket binding and
availability are checked. `10/19` is keepalive;
`10/20` logs out, removes live presence and releases the busy slot without
deleting the avatar's persistent actor, location or possessions.

## Resources and derived class dependencies

The server sends all 1,637 admitted MAG resources with type descriptors first:

| Noid / ID | Payload |
| --- | --- |
| `10/16` | uint32 resource count and total raw bytes |
| `10/17` | uint32 ID, version, full-size marker, fragment length; then raw bytes |
| `10/18` | One unused zero byte; completion |

The first fragment announces the full size. A complete single fragment has
equal full size and fragment length. Middle fragments use `0xffffffff`;
the final continuation uses zero. Local cache `sM/eM` marker bytes are not
wire resource data.

The native environment loader still requests cooked `0x80050001/2` with
version request 2 and evaluates the cooked source pointer at offset 8.
Original type-5 data uses:

```text
bu4msg_num;bu2methodType;bu2methodLen;bu1method,methodLen;;
```

It is not paired with the earlier synthetic bootstrap schema.

To make every recovered class constructible where its behavior is supported,
the `region` profile derives the affected class headers without unavailable
eager method dependencies. Source class definitions affected by this input are
21, 22, 52, 57, 98, 203, 204 and 205. Thirteen references represent eight
absent method IDs. Resource counts and versions change; instance schemas,
available method bytes and source cache files do not. The omissions and hashes
are retained in the resource profile/coverage ledger, not represented as
recovered missing behavior.

The `empty` diagnostic profile does not load the shared gameplay runtime.
Keep different resource profiles in different owned client runtime folders.

## Class encoding, object IDs and shared updates

CUTESI `b` fields form the packed wire representation. `c` fields are
client-only memory/pointers; `s` fields are server-only state. Neither is
serialized as a client pointer. The generic codec handles fixed/dynamic
arrays, integer widths, booleans and Windows-1252 strings, including explicit
native trailing-padding exceptions for login/selection.

Persistent object IDs are global server identities. The runtime maps them to
native room references for each recipient. Region root is noid 0; the
recipient's Ghost occupies reserved noid 15. Other objects get bounded room
NOIDs. Actor/container/follow references in notices are mapped for the
recipient rather than copying another session's local number.

A full scene uses `0/145 NewCV` (u16 success) then `0/101 HereIs`.
HereIs contains the 112-byte contacts/actor/permissions prefix and zero-RLE CV.
Each expanded record has a BE16 length excluding its length prefix and
including its complete class instance.

After entry, changed/new instances use `0/81` contents-vector updates;
compatible removals use object notice 68. The runtime falls back to a full
scene when a safe deletion/update path requires one. Player presence,
inventory movement, class-mode conversion and region travel update other
connected room clients. Offline actors and their carried items are not
presented as online room occupants.

The actor's role and home ownership determine presentation permissions.
Normal player capabilities enable walking, speech, Ghost/materialization and
other ordinary menus. Server handlers independently enforce ownership,
access, balances, bans and role requirements.

See [world.md](world.md), [classes.md](classes.md), and the action-family
documents for the exact state and request behavior. Arbitrary saved action
source remains inert metadata; original server algorithms are not inferred
merely from a request schema.

## Filename RPC

Native `0x0042c3e0` uses `0x31` with one or two names:

| Offset | Encoding | Meaning |
| ---: | --- | --- |
| 0 | uint32 | Opcode `0x31` |
| 4 | uint32 | Count: 1 or 2 |
| 8 | Count × 64 bytes | NUL-terminated filenames |

Requests are 72 or 136 bytes, outside the world envelope. Legacy `0x30`
supports one name. In order, each file gets:

| Offset | Encoding | Meaning |
| ---: | --- | --- |
| 0 | uint32 | Zero success status or failure |
| 4 | 64 bytes | Requested filename |
| 68 | uint32 | Body length |
| 72 | uint32 | Version metadata; active native callback consumes but ignores it |
| 76 | Byte array | Exactly the success body length |

Each second file has its own header/body. A failed first file does not prevent
a valid second reply. The bounded batch connection closes afterward.
Only admitted WSRES names are served; no path traversal or arbitrary loose
filesystem downloads. Bounds and the native cache checksum are verified.

World-port RPC recognition and the dedicated RPC port are direct TCP
capabilities, not a WebSocket upgrade or relay implementation.

## Evidence limits

The user confirmed the 0.2.0 Windows connection. New tests cover real schema
encoding, state invariants, multiple synthetic sessions and durable restarts.
They do not verify every new Windows menu, animation, native editor action or
historical behavior. Full details and remaining boundaries are available in
`GET /api/coverage` and [feature-coverage.md](feature-coverage.md).

