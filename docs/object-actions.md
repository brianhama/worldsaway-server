# Physical objects and durable device actions

`src/object-actions.ts` implements the local server policies behind the
recovered request shapes. `OBJECT_REQUESTS` records each supported request ID,
reply ID, class-specific `replyByClass` overrides and receiver class set.
`replyIdForObjectRequest(id, classNumber)` selects the same reply for successful
actions, rejected actions and runtime errors before dispatch. The transaction evaluator is also exported
as `applyObjectAction` for independent tests. All action state lives in
`world.json`; original client caches and account credentials are not edited.

The packet names, argument fields and reply/notice IDs come from the original
Tcl and type-4 CUTESI resources. The ownership, economy, stock and moderation
rules are authored local rules. They are not a recovered original server
implementation or an assertion of its exact historical business policy.

## Implemented families

| Behavior | Request IDs | Main replies / notices |
| --- | --- | --- |
| Rename / describe | 26, 76 | 70 / 28; 77 |
| Pickup / drop held item | 1575, 1580 | 70 / 1576; 1582 / 1581 |
| Give another avatar an item | 1605 | 1609 / 1606 |
| Put / pocket / take | 85, 89, 93, 97 | 86 / 87; 90 / 91; 70 / 95 |
| Open / close container | 1608, 1611 | 80 contents vector; 70 / 1612 |
| Pocket listing / nested path retrieval | 1711, 1714 | 1712 / 1715 |
| Open, close, lock, unlock, combination | 300, 303, 337 | 70 / 301 / 304; 338 |
| Sit / stand | 2401, 2405 | 2402 / 2403; 2406 / 2407 |
| Head, accessory, clothing | 3601, 3605, 3201, 3205, 20602, 20605 | 70 and the recovered class notices |
| Use / accessory animation | 4151, 3211 | 4152 / 4153; 3212 / 3213 |
| Spray / compass | 1035, 3424, 3427 | 70 / 1036; 3425 / 3428 |
| Door / teleport / elevator | 2351, 1202, 4102 | 70 then runtime region transition |
| Token split / pocket merge | 1139, 85, 89 | 1142, 1152, 1156 and token notices |
| Bank balance / deposit / withdraw | 2801, 2806, 2810 | 2802, 2807, 2812 |
| Bank statistics / configuration | 30, 2815 | 2813 / 70 |
| Teleport connection configuration read | 30 on Teleport class 56 | 1206 |
| Pawn appraisal / sale | 2561, 2565 | 2562 / 2566 |
| Vendroid browse, purchase, stock, unload | 2671, 2675, 2678, 2682 | 2672 / 2673; 80; 2679 / 2680; 2683 / 2684 |
| Document state / orientation | 2720, 2730 | 2721 / 2722; 2731 / 2732 |
| Document / binder metadata | 2710, 2712, 2715, 2717 | 2711, 2713, 2716, 2718 |
| Document creation / index listing | 2737, 2740, 2735 | 2738, 2741, 2736 |
| Binder add / remove / delete | 2743, 2747, 2724 | 2744, 2748, 70 |
| Read / write / reorder pages | 2781, 2771, 2761 | 2780, 2770 / 2772, 2762 |
| Blank page split / transfer / publish flag | 2791, 2796, 2751 | 2792 / 2793, 2797 / 2798, 70 |
| Printing master / copy | 4353, 4357, 4361 | 4354, 4358, 4362 |
| Recycler input / paper production | 4303, 4311 | 4304, 4312 |
| Body style purchase / configuration / activation | 3301, 3304, 3313 | 70 / 3302 / 3314 |
| Magic activation / configured effect | 2131, 2134 | 70 / 2132; scene data refresh |
| Newsstand purchase / master | 4403, 4407 | 80 / 70 |
| Physical post / receive | 4453, 4457 | 70 / 4458 |
| Registry display name / listing | 2924, 2920 | 70 / 2925; 2921 |
| Dice roll / reveal | 4501, 4505 | 4502 / 4503; 4506 / 4507 |
| Weapon prop animation | 5101 | 5102 / 5103 |
| Banner data / configuration / state | 5605, 5621, 5631 | 5606 / 70 |
| Banner prize / stock / unload | 5675, 5678, 5682 | 80, 5679, 5683 |
| Engraving | 9908 | 70 / 28 |
| Staff summon / join / travel | 3101, 3117, 3106, 3107 | 70 then runtime transition |
| Avatar / account ban, mute, freeze | 3114, 3116, 1701, 1703 | 70; durable expiry and runtime enforcement |

Some common physical actions apply to many classes. The authoritative receiver
scope is the exported table; a client cannot gain a behavior by sending a
different class's request ID. Unrecognized IDs return `false` to the runtime
dispatcher rather than manufacturing a success reply.

The recovered Tcl reuses three request IDs with different replies: request 30
expects 2813 for ATM class 33 and 1206 for Teleport class 56; Tokens class 26
expects 1152 for request 85 and 1156 for request 89. Other physical classes use
86 and 90 for those inventory operations. Reply selection depends on the
receiver class even when decoding or authorization fails.

## State and authority

An object has a global persistent ID. Native NOIDs are per-session references,
so the adapter resolves incoming references before mutating state and sends
`context.ref(...)` wrappers for recipient-specific mapping. Object fields do
not store another client's temporary NOID.

Container membership is `containerId` plus `slot` and `fields.position[0]`.
Slot 0 is the Avatar hand, 1 the head, 2 pocket tokens, 3 clothing, and 4 onward
ordinary pockets. Container moves enforce capacity, occupied slots, cycles,
region visibility, explicit ownership, closed/locked access and private Avatar
inventories. A Ghost has capacity 0; inventory operations require an Avatar
actor. Giving transfers the existing object's ownership, including owned
contents, and requires an empty recipient hand.

Documents use a separate durable record with title, author, pages and binder
entries. A binder is not a native container: class 37 declares capacity 0.
Indexed documents are hidden with `archivedIn` rather than assigned an illegal
physical parent. Runtime scene construction must omit archived objects and
their descendants. Document mutations require ownership and respect the
read-only flag. Page limits are enforced before committing changes.

Prices, destinations, stock and effect definitions come from server state.
Request fields never provide privileged prices or ownership. Fresh persisted
staff authority is required for moderation; a stale session role cannot
preserve a revoked privilege. Account bans are also stored in `accountBans`
so making another avatar cannot bypass the restriction. The runtime enforces
ban, mute, freeze and region-admission decisions.

Primary travel uses `context.moveActorInDraft` inside the action transaction.
Door, Teleport, elevator and configured magic moves therefore commit actor and
nested inventory locations together with any cash payment, ledger entry or
magic charge. The success reply follows the durable commit, then
`context.publishTravel` publishes the scene without another world write.
Contexts without the draft hook retain the legacy `teleport` adapter fallback.

## Money and machine configuration

Bank `avatar.balance` and physical Tokens class 26 `fields.denom` are distinct
stores of value. Withdrawals debit the bank and create/add held tokens;
deposits consume held tokens and credit the bank. Splitting and merging tokens
conserve value. Device flows that make the client destroy its held payment
require the exact price, avoiding an unseen remainder. Vending transfers an
existing stock item and credits its seller; it does not mint sale proceeds.

Vendroids preserve the recovered display convention: physical slot 0 contains
the displayed item, while `currentSlot` identifies that item's empty storage
home. Browsing moves the old display into its home and the selected item into
slot 0, then updates `currentSlot` and the displayed price. Native menu 2674
therefore buys the item actually shown when it sends request 2675 with slot 0.
The virtual-grid menu may also buy an explicit nonzero storage slot. Stocking
and unloading maintain the same convention, reserve one slot for the display,
and publish the recovered notices. Purchases and unloads clear the root
item's stock immobility flag. Older layouts are normalized in the action
transaction and refreshed before subsequent use.

This slot behavior follows Tcl `00050a2c.tcl`, stock/unload methods
`00050a30.tcl` and `00050a33.tcl`, native menu `00050a29.tcl` and virtual-grid
menu `00050a86.tcl`. Server-side item identity and `salePrice` determine the
purchase; a stale displayed price cannot authorize a cheaper payment.

Only explicitly authored `forSale` / `properties.forSale` pickups create a
Cashier `pendingSale` record. `salePrice` alone is not a bill: it also serves
appraisal and vending semantics. Pending goods cannot be gifted, pawned,
engraved or stocked before payment, while pocket moves remain possible.

Local policies need configuration before their specialized operation:

- Teleport configuration is stored in `properties.connection` by request 1207.
  Request 30 reads `address`, `aliases0..4`, `secret_address` and `areaCode`
  into reply 1206, with `dummyfielda` set to zero. Reading the configuration
  requires object ownership, current staff authority or ownership of its region.
- A Body changer needs the selected `bodyURL0..7`, `bodyDefault0..7` and
  `bodycost0..7`; no image filename is guessed.
- Newsstands need `properties.masterId` pointing to a Document.
- Magic supports explicit data effects `color`, `visibility` and `teleport`.
  It never sends the recovered executable-Tcl notice field or evaluates code.
- Banners persist advertisement/presentation data and stock. Prize copies
  preserve configured item/document contents, reject nested-container copies,
  and enforce per-avatar limits.
- Randomizers use `num_dice`, `die_sides`, `offset` and cryptographic server
  randomness. Hidden results are masked for the respective packet audience
  until the roller/owner reveals them.

Missing configuration, full inventories, sold-out stock, invalid paths and
insufficient funds produce recovered failure codes. A successful class
serialization is not a successful purchase or configured game operation.

## Physical mail

Postage follows recovered library `000c000b.tcl`: five tokens per item, plus
five per usable Container slot and recursive postage for its contents. The
server calculates this from state and rejects a stale submitted postage.
Payment comes from pocket Tokens. A durable mail record stores label text,
sender, recipient and attachment object ID. The attachment is archived without
losing its identity, then transferred into the recipient's empty hand exactly
once. Text mail and physical parcels therefore use shared durable mailbox
identities without treating a label as an object serialization.

## Validation and limits

`test/object-actions.test.mjs` checks recovered schemas, ownership, container
cycles/slots, cash conservation, page/binder persistence, purchases, giving,
Vendroid display rotation, selected-item pricing, grid purchases, reserved
storage capacity and stock portability,
private pocket paths, admission-before-payment, physical parcel replay,
revoked staff authority, account-ban persistence, dice privacy and configured
body/counter behavior. It also checks Teleport configuration persistence,
class-specific replies for unauthorized/malformed requests, and Tokens reply
variants. A balanced-brace scan of all 96 owned literal Tcl request IDs found
the three shared-ID reply variants documented above. An injected final-file
rename failure checks rollback of paid and charge-consuming travel, absence
of success/scene publication, and successful retry with nested inventory.
All mutations use WorldStore candidate transactions;
rejected actions do not advance committed state.

Native Windows UI execution for every animation/menu has not been established
by these tests. The server supplies defined local behavior, not the original
service's historical content, tax/rent economy, moderation policy or arbitrary
server-authored executable scripts.

## WorldsAway.app staff requests

Administrator-only requests 1681, 1683, 1686 and 1699 support durable promotion/demotion, avatar image type, forced logout and account-owner lookup. Target identity is validated against the current room and authority comes from the persisted role. Printed and purchased newspaper copies are portable even when their source master is fixed.
