# NPC programs, companions, and bus routes

These services run in the same durable world transaction as their triggering action. Configuration is JSON data authored by a world operator; executable JavaScript and saved Tcl are not evaluated by these services.

NPC class 200 supports existing literal keyword dialogue and structured programs through `properties.dialogue`:

```json
{
  "default": "I have no errands today.",
  "rules": [
    {
      "id": "flower-trade",
      "match": "flowers",
      "mode": "equals",
      "once": true,
      "requires": { "introduced": true },
      "response": "Thank you, {avatar}. {npc} has a gift for you.",
      "actions": [
        { "type": "takeItem", "name": "Garden flower" },
        { "type": "giveItem", "slot": 1 },
        { "type": "setState", "key": "helped", "value": true }
      ]
    },
    {
      "match": "hello",
      "response": "Hello, {avatar}. Ask me about flowers.",
      "actions": [{ "type": "setState", "key": "introduced", "value": true }]
    }
  ]
}
```

Rules use case-insensitive substring matching unless `mode` is `equals`. `requires` compares per-avatar state values exactly. `once` persists a completion marker for this NPC and avatar. Supported actions are:

| Action | Configuration | Behavior |
| --- | --- | --- |
| `setState` | `key`, `value` | Set a bounded string, boolean, or integer in this avatar's NPC state. |
| `takeItem` | Optional `name`, `classNumber` | Transfer the caller's held, owned, fully paid item into the first free NPC slot. |
| `giveItem` | `slot` | Transfer an existing item and its nested inventory from an NPC slot into the caller's empty hand. |
| `payTokens` | `amount` | Require exact held cash and move its value into NPC cash reserves. |
| `rewardTokens` | `amount` | Transfer a funded cash reward from NPC reserves or stored Tokens; it cannot create unfunded currency. |
| `teleport` | `destination`, optional `areaCode` | Move the caller through normal destination and admission checks. |

All actions in a matched rule commit together. A full hand, missing stock, insufficient reserves, forbidden destination, or unknown action rolls back the whole conversation program. Responses support the two literal placeholders `{avatar}` and `{npc}`. Programs are bounded to 128 rules, 16 actions per matched rule, and 256 state keys per avatar. Replies use the recovered NPC speech notice 74.

Adopted class 201 pets carried by an avatar travel with that avatar's inventory. A loose adopted pet follows its owner's position and region. Set `properties.followOwner` to `false` to leave a pet stationary. Following avatars cross regions only while online and while each follower is admitted to the destination; their carried objects move in the same transaction. A refused follower stops following.

A bus uses an existing class 53 Seating object as its vehicle and class 204 Bus Stop objects as signs. Players board and leave through ordinary Sit and Stand controls. Configure a route using the operator world API's `configure-bus` action, passing a JSON `data` object:

```json
{
  "id": 7,
  "name": "Town loop",
  "vehicleObjectId": 40,
  "stopObjectIds": [41, 42, 43],
  "intervalSeconds": 30,
  "startAt": 0,
  "enabled": true
}
```

The vehicle must be loose, have capacity, and already be in one stop's region. Each route needs 2–64 distinct available stops. A vehicle serves one route. Configuration updates the signs' route numbers and records the current stop. At each due departure the bus, seated passenger profiles, and complete nested inventory move together to the next stop. An admission failure holds the whole bus and retries after its interval. Missing vehicles or stops disable their route and retain an explanatory `lastError`. Missed departures while offline coalesce to one departure after restart; the server does not replay an unbounded backlog.

Route state is stored in `world.json` under `busRoutes`, including `stopIndex`, `nextAt`, and `journeys`. Scheduled transport is authored world behavior using the recovered class interfaces; original AltAway timetables and server-side NPC scripts are not present in the supplied client resources.
