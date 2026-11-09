# Class and message registry

`src/classes.ts` implements the descriptor layer shared by all **58 recovered
classes** and **710 recovered message schemas**. It also indexes all **469
available Tcl method resources** as metadata. This is structural coverage:
authoritative action semantics are implemented separately by the world and
action services. Parsing a method or schema is not a claim that every action
in the original service has been reconstructed.

## APIs

```js
import { ClassRegistry } from './src/classes.ts';

const registry = new ClassRegistry(resources);
const avatarClass = registry.get(21);
const fields = registry.defaults(21);
fields.name = 'Alice';
fields.noid = 16;

registry.validateObject({ classNumber: 21, fields });
const payload = registry.encodeObject({ classNumber: 21, fields });
const decoded = registry.decodeInstance(21, payload);
```

| API | Meaning |
| --- | --- |
| `registry.classes` | Map keyed by numeric class number |
| `registry.list()` | Classes ordered by number |
| `registry.get(number)` | Class header, instance descriptor, parsed fields, dependencies and methods |
| `registry.defaults(number, {scope: 'server'})` | Defaults for both shared and server-only fields |
| `registry.encodeObject(object)` | Packed instance bytes, with the class number included |
| `registry.decodeInstance(number, bytes)` | Decode and verify the class number using that class's descriptor |
| `registry.validateObject(object, options)` | Validate class fields, ranges and array lengths without transmitting them |
| `registry.getMessage(id)` | Original message descriptor and parsed fields |
| `registry.encodeMessage(id, fields)` | Encode a message body; envelope is a separate transport concern |
| `registry.decodeMessage(id, bytes)` | Decode a bounded message body |
| `registry.methodContract(class, id)` | Last declared available client-method candidate for that method ID |
| `registry.requestContracts(class)` | Lexical request/reply candidates from every declared available method |

Object values may be flattened or passed as `{classNumber, fields}`. Object
IDs must be resolved to the local numeric NOID before encoding; the codec
does not allocate identifiers or implement containment/ownership.

The parsed field records expose `name`, `scope`, `type`, `width`, `count`,
`min`, `max`, `wire` and the original descriptor text. `count` is `null` for a
scalar, a number for a fixed array, or the name of an earlier integer field
for a variable array. This lets action/admin code validate and expose fields
without inventing a universal object layout.

## Wire representation

The default encoder and decoder select **only `b` fields**, the native
CUTESI mode-3 behavior. The `c` fields describe client-only runtime storage,
including pointer slots, callbacks and container tables. The `s` fields hold
server-only values such as a Portkey destination or slot-machine sequences.
Neither category is transmitted in an ordinary world instance. Persistence
can retain `b` and `s` values, while avoiding client-only pointer state.

This follows the native filter predicate at earlier VZones function
`0x0042eae0`: mode 3 accepts the shared `b` category, mode 1 accepts `b/c`,
mode 2 accepts `b/s`, mode 4 accepts `c`, and mode 5 accepts `s`. The old
description that mode 3 accepts all three categories should not be used to
construct instances. The working Region/Ghost wire fixtures also omit the
client-only fields.

The complete admitted class/message corpus uses these supported categories:

| Type | Wire encoding |
| --- | --- |
| `u1`, `u2`, `u4` | Unsigned integers, big endian for widths 2 and 4 |
| `i1`, `i2`, `i4` | Signed two's-complement integers, big endian for widths 2 and 4 |
| `b` | One normalized byte, zero or one |
| `c` | Byte/character scalar or fixed/dynamic byte array |
| `s` | Windows-1252 text followed by NUL |

Fixed character fields accept a string of at most the declared byte count, or
a byte array/Buffer for opaque structures such as packed avatar-name tables.
Short values are padded with zero; exact-width values need not include NUL
because CUTESI transmits a fixed byte array. Individual action services must
apply their own stricter C-string/name bounds where the client requires them.
Decoding returns fixed fields as text by default and preserves the exact bytes
in the nonenumerable `rawCharFields` map. Use `{charArrays: 'buffer'}` for a
lossless byte-oriented view. Dynamic `c` arrays and dynamic `u1` arrays decode
to Buffers; other integer arrays decode to numeric arrays.

Dynamic array counts are inferred from the provided array when the count
field is absent. A supplied count must match exactly. No cooked pointer or
native structure padding is inserted. Message 11 therefore encodes to 282
bytes, and message 13 to 70 bytes. Their recovered native Windows senders
append 288 and 72 bytes respectively. `decodeMessage` accepts either the
packed form or exactly six/two additional zero bytes for these two messages;
it rejects partial padding, nonzero padding and other trailing data by
default. The account protocol parser separately accepts both exact sizes and
ignores the native forms' unused tail bytes. See
[the handshake layout and native evidence](protocol.md#login-and-avatar-selection).

Windows-1252 text preserves accented letters, typographic quotes and the euro
sign. It rejects characters outside that encoding rather than silently
truncating JavaScript UTF-16 to bytes. User-visible text policy and length
limits still belong to the relevant action service.

## Bounds and unsupported grammar

The default limits are a 1 MiB payload, 256 KiB individual string, 1,048,576
array elements and 2,048 descriptor fields. Ranges and lengths are checked
before allocation or serialization. Unterminated strings, invalid count
references, class-number mismatches and trailing bytes are rejected.

No admitted class or type-4 message descriptor needs selector branches,
object-reference-like `o` values, or special `z` fields. Those categories are
therefore rejected explicitly instead of assigning an unverified wire shape.
Resource-type descriptors are not automatically world-message descriptors;
their dedicated cache cookers remain separate.

## Methods and request contracts

Class method dependencies are resolved from the actual served resource set.
Metadata retains the raw resource ID/version, `msg_num`, Tcl source, and
literal request candidates with target, request ID, reply ID, line and field
names. Source is never evaluated by the registry.

A client method ID differs from a server request ID. For example, resource
`0x00050050` is client method **25**, and its Tcl sends request **26** to
`$self`, expecting reply **70**. Server dispatch must use the outgoing request
contract or explicit handler ID, not assume `msg_num` is an incoming opcode.

Several classes declare more than one resource with the same client method
number. `methodVariants` preserves all those candidates and their original
dependency order. The convenience `methods` Map exposes the last declared
available candidate; this is a metadata choice, not a proof of native method
lookup precedence. `requestContracts` includes all declared variants. Dynamic
Tcl substitutions and nonliteral requests remain analysis limits.

## Validation

`node --test test/classes.test.mjs` checks independently specified endian,
signed, boolean, string and array vectors; Windows-1252 behavior; fixed binary
tables; invalid/truncated inputs; all 58 original class encodings; and all 710
original message descriptors. It confirms the original Region and Ghost
packed lengths (178 and 162 bytes), HereIs offsets, and known login padding.
These are protocol tests, not an execution of the Windows client or Tcl.
