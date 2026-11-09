# Management HTTP API

The API lives on the world HTTP listener, normally `http://127.0.0.1:8080`. Authenticated endpoints use POST and `application/x-www-form-urlencoded`. Supply `account`, `password`, optional owned `avatar`, and `action` in the form body. JSON configuration is encoded in the appropriate form parameter. Native object IDs in this API are durable world IDs, not per-region client noids.

| Endpoint | Behavior |
| --- | --- |
| `GET /health`, `/healthz` | Listener ports, application/version, world revision and resource profile |
| `GET /worlds3.php` | Native launcher-compatible directory |
| `POST /login` | `username`, `password`, `action=Login`; one-use connection file |
| `POST /connect.iv` | `account`, `password`, optional `avatar`; one-use connection file |
| `GET /api/capabilities` | Application identity and self-registration availability/native name limits |
| `POST /api/register` | Create an account plus its first avatar atomically using `account`, `password`, `avatar` |
| `POST /api/avatars` | List owned avatars; `action=create&name=...` creates within account capacity |
| `GET /api/classes` | All native class names, capacities and schemas |
| `GET /api/coverage` | Detailed class, literal request and handler ledger |
| `POST /api/profile` | Own profile/preferences/friend/ignore management |
| `POST /api/world` | Builder/admin world inspection and authoring |
| `GET /files/worldsaway-images.zip` | Rebuilt committed native image cache |

`/api/profile` supports `get`, `preferences`, `friend`, `unfriend`, `ignore`, `unignore`. It cannot change roles or privileged flags.

`/api/register` is the unauthenticated self-registration exception. It accepts only `account`, `password`, and `avatar` in the form body; query parameters and privilege/capacity fields are rejected. Success returns HTTP 201 and `{application:"WorldsAway.app",account:{name},avatar:{name},capacity:3}`. Account names use 1–24 safe ASCII characters, passwords 1–24 printable ASCII characters, and avatar names 1–29 safe ASCII characters. Account and avatar uniqueness is case-insensitive. Conflicts return 409; validation errors return 400. The account and its initial avatar commit in one replacement of `accounts.json`, so failed validation or persistence leaves neither identity partially created. Passwords are saved only as salted hashes. New world profiles receive the ordinary `player` role on first entry.

Self-registration is enabled by default. Set `WORLDSAWAY_ALLOW_REGISTRATION=false` to disable it; `/api/capabilities` advertises the disabled state and registration returns 403. The browser client uses its same-origin bridge to call registration; the backend rejects a directly supplied foreign browser Origin. Existing accounts and the operator's local account-administration commands remain available when self-registration is disabled.

`/api/world` supports `get`, `create-region`, `create-object`, `update-object`, `delete-object`, `configure-bus`. A saved builder or admin role is required. Builder snapshots omit accounts, balances, mail, private profile maps and other administration data. Admin world snapshots include world state but not password hashes. Account administration remains in the local CLI.

For `create-region`, provide `name` and optional JSON-object `fields` and `properties`. For `create-object`, provide `classNumber`, `regionId` and JSON-object `data`; native fields go under `data.fields`, and declarative device configuration under `data.properties`. Update/delete provide durable `id`; recursive deletion additionally uses `recursive=true` and honors document/parcel lifecycles. Common editable data keys are `fields`, `properties`, `description`, `capacity`, `portable`, `locked`, `open`, and administrator-only bounded `cashReserve`.

`configure-bus` takes a `data` JSON object with `id`, `name`, `vehicleObjectId`, `stopObjectIds`, `intervalSeconds`, optional `startAt` and `enabled`. The bus must be a loose Seating object already at one of its Bus Stop regions. When `startAt` is omitted, its first departure is scheduled one interval from now. See [configuration examples](special-automation.md).

Each world mutation is serialized with gameplay, validates current saved authority, commits before success, and publishes updated regions after commit. Invalid schemas, identity changes, missing images, impossible capacities and inconsistent containment fail without partial updates. Body size and native field limits apply. Request/action definitions and exact native field names are available in the coverage reports.
