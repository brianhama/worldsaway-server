# Specialized class services

`SpecialActions` implements the recovered requests for NPCs, pets, potions,
bus-stop configuration, cashiers, portkeys, slot machines, spinners and
decorators. These are authored local-world policies using the client's actual
schemas and reply IDs. They do not claim to recover the original service's
economic algorithms, NPC content, transport timetable or game odds.

The module never evaluates downloaded Tcl, JavaScript, expressions or NPC
script text. All changes occur inside a synchronous `WorldStore.transaction`;
failed permission, payment, inventory or configuration checks roll back the
entire action.

## Recovered request/reply contracts

| Class | Requests | Implemented behavior |
| --- | --- | --- |
| NPC 200 | `20010 → 70` | Literal dialogue rules, persistent conversation counters and NPC speech notice 74 |
| Pet 201 | `20103 → 20104`, `20105 → 70` | Owner lookup; adoption/name/ownership and empty-hand placement |
| Potions 203 | `20302 → 20304` | Charge use and configured local effects with persistent expiry |
| Bus Stop 204 | `20404 → 70` | Owner-controlled bounded route identifiers; notice 20405 updates peers |
| Cashier 205 | `20502 → 20503`, `20504 → 70` | Exact bill and payment for explicit pending purchases |
| Portkey 209 | `20904 → 20905`, `20906 → 70`, `20907 → 70` | Settings, owner-only configuration, permitted destination travel and exact payment |
| slotMachine 210 | `21004 → 21005`, `21006 → 21007`, `21009/21010/21012 → 70` | Play, settings, configuration, unload and stock |
| Spinner 213 | `21304 → 21305`, `21306 → 21307`, `21309/21310/21312 → 70` | Play, settings, configuration, unload and stock |
| Decorator 215 | `21503 → 21506`, `21505 → 21508` | Persistent hide/show state and owner-authorized hidden-object lists |

Every request is checked against its target class. Native NOID references are
resolved through the session before entering the transaction; persistent
records contain global object IDs, not transient local slots.

## NPC dialogue and pets

NPC dialogue is data on `object.dialogue` or `object.properties.dialogue`.
An object can map literal case-insensitive substrings to responses, plus a
`default` response, or provide `{match, response}` records. Replies are bounded
Windows-1252 strings. There is no regex or code execution. The default is a
short greeting. The successful standard reply has an empty `fail_msg`, followed
by actual NPC method-74 speech; class 200 supplies that method. This avoids an
original client method's inconsistent attempt to read `text` from reply 70.

Pet adoption requires a materialized actor and an empty hand. Unowned pets are
adoptable; a pet owned by somebody else needs explicit server-authored
`adoptable` permission or administrator authority. Adoption records the owner,
name and actor relationship and moves the same pet object into hand slot 0.
The wire `owner` field is derived from the persistent actor ID through the
runtime's local-NOID mapping. No second pet is created.

## Potions and expiry

The supported local `potionType` values are `refreshment`, `heal`,
`invisibility`, `mood` and `color`. Healing sets the Avatar's recovered `health`
field to 255. Mood and color use validated server configuration, with a default
mood of 1 or a uniform color map of 7. Invisibility sets only the visibility
bit. Every use consumes a positive charge. A zero `potionDuration` uses the
local default of 60 seconds.

Persistent effect records and `special-effect-expire` timers survive restart.
`applySpecialTimer(draft, timer)` restores the original visual state only when
the timer still owns the current effect ID. Repeated doses retain the
pre-first-dose baseline, so an older expiry cannot undo a new dose or leave
invisibility stuck. Visibility restoration preserves unrelated flag bits.
The central runtime must remove processed timers in the same transaction.

`speed`, `energy` and unknown effect names are rejected explicitly. The
recovered client does not supply a verified compatible speed/energy effect
hook; storing a label without changing behavior would not implement one.
This is a configuration limit of the local potion service, not an invented
successful effect.

## Cashiers and virtual currency

A cashier bills only carried goods with a server-authored record:

```js
item.pendingSale = {
  cashierId, buyerId, price, sellerId, paid: false
};
```

The object service creates these records when explicitly `forSale` goods are
picked up. An ordinary owned item's `salePrice` alone never creates a debt.
The bill uses captured prices, is bounded to the reply's 16-bit total, and is
not changed by later edits of display/appraisal values. Payment consumes an
owned hand Tokens object whose denomination equals the bill exactly, credits
the cashier's persistent reserve and marks the purchases paid. Replaying
payment against the same goods charges nothing again. Bank balances are not
debited a second time.

Portkeys and game stakes use the same exact-held-token rule because their
client methods destroy the complete hand-payment object after success. A
larger or smaller token amount fails without a partial charge. All currency
here is local virtual-world state; no external payment service is involved.

## Portkey travel

Settings are writable only by the device owner or server-authorized staff.
Destinations resolve to a live region or a live region group's entry/member
using the configured area code. Pending deletion, private/locked access,
housing guest restrictions and explicit allowed-avatar lists are checked
before any charge or payment. The wrapper also calls the runtime's
`canEnterRegion` preflight when provided. Group selection is fixed for that
transaction, so a second random draw cannot charge for one destination and
travel to another.

With the live runtime, Portkey charge use, exact token payment, actor/profile
movement and all carried-object locations are applied in one world-store
transaction through `moveActorInDraft`. Only after that file replacement
succeeds is a successful reply sent; `publishTravel` then updates client views
without a second persistence transaction. A failed write/rename leaves cash,
charges and locations unchanged and sends no success acknowledgement. Unit
contexts without those runtime helpers retain the older transport-only travel
fallback; the live runtime supplies both helpers.

Initial zero charges denotes an unlimited authored device; 65535 is also
unlimited. A positive last charge sets `portkeyExhausted` when decremented to
zero. That persisted flag prevents a depleted finite device from becoming
unlimited. Reconfiguration by its owner resets that state.

Bus-stop request 20404 edits at most 64 distinct numeric route identifiers and
broadcasts the recovered route-change notice. This snapshot exposes no
separate passenger boarding request for class 204. The runtime uses class53 Seating for a scheduled bus vehicle and moves seated passengers through configured stops. The default world includes a three-stop shuttle. See [special automation](special-automation.md). Original historical timetables are not claimed.

## Slot machine and spinner policy

Random draws use `node:crypto.randomInt` by default. Tests can inject a bounded
`context.random(maxExclusive)` function. Clients never supply the draw result.
Configuration and stock/unload operations require device-owner or staff
authority; another player's private inventory and unpaid goods cannot be used
as stock.

A slot machine needs actual reel objects in slots 0–2. Reel sequences contain
1–256 digit symbols. The reward matrix contains at most 15 unique rows in the
client UI's `reward>pattern` syntax: `5>777` pays five tokens, while `#3>000`
awards the actual object in prize slot 3. Patterns are three digits, and slot
prizes use slots 3–9. Empty configuration yields ordinary losing outcomes.

A spinner draws from 1 through its configured `maxResult`; a result awards the
existing prize object in slot `result - 1` when present. Empty slots are losses.
Prizes are moved into the player's hand, not cloned. The current actor must be
materialized so it has real inventory slots.

Numeric rewards are funded by the machine's persistent cash reserve and
existing Tokens prize stock. A configured payout that cannot be funded rolls
back the spin and stake. Currency is not fabricated. Outcomes, stake totals,
cash reserve, play counts, paid totals and prize placement persist. Stock
notices use recovered 21011/21013 and 21311/21313 schemas.

## Decoration state

The decorator and target must be owned by the acting avatar or controlled by
authorized staff. Region roots, actors, NPCs and contained inventory cannot be
hidden. Hiding records the original position, sets the native visibility bit,
and uses the recovered off-screen position `[-500, 0, 0]`. Showing restores
the position and clears only that bit. Finite charge exhaustion is persisted.

The hidden list includes only authorized objects in the current region and
uses safely escaped Tcl list data with per-session NOIDs. Listing does not
permanently reveal other players' objects or change the saved hidden state.

## Tests and remaining validation

`node --test test/special-actions.test.mjs` covers all 22 real request/reply
schemas, class mismatch rejection, NPC speech routing, pet persistence,
effect refresh/expiry, route permissions, exact/replayed payments, destination
denial before charging, funded outcomes, nonduplicated prizes, owner stocking,
configuration validation and persistent decorator state. These are independent
handler/persistence tests. The expanded interactions still need verification
in the Windows client; no such GUI session was executed by these tests.

## WorldsAway.app automation

Scheduled buses, loose adopted pet following, cross-region avatar following and bounded NPC dialogue/trade programs are implemented. See [special automation](special-automation.md) for current configuration and [districts](districts.md) for usable examples.
