# WorldsAway.app server

**Live demo:** [worldsaway.app](https://worldsaway.app) — try the browser client connected to a hosted world.

This project is based on the WorldsAway server protocol circa 1995, from the original WorldsAway service available on CompuServe and owned by Fujitsu. The original artwork from that era is used with permission from Fujitsu.

WorldsAway.app is a persistent multiplayer world server for the sibling browser client and the native WorldsAway-compatible protocol. The implementation lives entirely in this directory. Source and utilities are strict TypeScript, compiled to Node.js ESM. The running server uses Node.js built-in modules and needs no npm runtime dependencies or external database.

It implements handlers for **all 204 browser gameplay requests**, registers **all 58 available class schemas and 710 message schemas**, and supplies a playable authored world with an example of every concrete class. Protocol and behavioral verification are recorded in [browser coverage](docs/browser-coverage.md), [class coverage](docs/feature-coverage.md), and [validation](docs/validation.json).

This is an independent server implementation. Exact equivalence to AltAway's private server code, historical world database, server-side scripts, or operational policies cannot be established from client resources. The reports keep that distinction explicit. In particular, saved action-editor Tcl is metadata; NPC automation uses the documented declarative programs. The implementation has complete coverage of the supplied browser request catalog; this is not a claim of independently verified parity with every behavior of the live AltAway service.

## Run the world

Requires **Node.js 20 or newer**, npm, and a compatible WorldsAway MAG/WSRES cache or an existing resource pack. The sibling browser client requires Node.js 22 or newer, so use Node.js 22+ when running both projects. The world server itself does not require Tcl, native executables, or an external database.

Run these commands from this repository's root:

```sh
npm ci
npm run build
```

Resource packs are local inputs excluded from Git. A fresh code checkout needs either:

- An existing pack containing `manifest.json` and `payload.bin`, placed in `resources/` or selected with `--resource-pack-dir`.
- A compatible local cache, imported once into a directory that does not already exist:

```sh
npm run resources:import -- /path/to/AltAway ./resources
```

If `resources/` already contains a pack, skip the import. See [resources and portability](#resources-and-portability) for another pack location or direct cache use. After providing resources, validate them and start the server:

```sh
npm run check
npm start
```

| Service | Default address |
| --- | --- |
| World directory, authentication and management | http://127.0.0.1:8080 |
| Native world TCP | 127.0.0.1:1701 |
| Filename asset RPC | 127.0.0.1:1702 |
| Health | http://127.0.0.1:8080/health |
| Account | `demo` |
| Password | `demo` |
| Avatar | `Demo` |

Use Ctrl+C to stop cleanly. Data persists under `data/` by default; restarting retains avatars, objects, possessions, mail, balances, housing, NPC state, timers and bus schedules. The original `wa-server` implementation and its saved data are separate.

For another directory or ports:

```sh
npm start -- --data-dir /path/to/world-data --http-port 8180 --world-port 1711 --rpc-port 1712
```

## Connect the browser client

Set up the browser bridge using the [browser client README](../browser-client/README.md), including its Node.js and Tcl prerequisites. With the repositories checked out side by side, start it in another terminal:

```sh
cd ../browser-client
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4173, choose **File → Connect**, select **WorldsAway.app**, and use `http://127.0.0.1:8080` as the server address. Load the world list, select WorldsAway.app, sign in with `demo / demo`, and choose Demo. The browser bridge remains responsible for TCP and Tcl support. First-time login works with an empty browser resource cache; the world supplies its schemas and assets.

The AltAway service remains available in the local selector. Hosted mode stays pinned to its operator-configured backend. [Railway deployment](docs/railway-deployment.json) records the hosted backend configuration and dated validation evidence. For a native Windows client, see the [launcher guide](docs/launcher.md).

New avatars begin in **Outside The Rose** when that imported region is available; worlds without it use their configured starting region. Returning avatars resume in their saved region. New profiles enter as Ghosts. Materialize using the avatar menu before walking, carrying items, using the bank, or adopting pets. Each profile starts with 1,000 tokens in its bank account. Withdraw cash at the Lobby's Local bank; paid devices use physical held Tokens and authoritative prices.

## Explore the world

The Lobby, Garden and Library retain the chest, postbox, guide NPC, bank, gift Vendroid, book and adoptable dog. Travel south from a new Lobby to the additional districts, then east/west along the street:

| District | Examples |
| --- | --- |
| Market | Cash, newspaper sales, Pawn, Recycler, Cashier |
| Workshop | Builder/Fiddle tools, Gutenberg printing, keys, spray paint, weapons, Engraver, Decorator |
| Arcade | Dice, funded slot machine with real reels, Spinner with finite prize stock |
| Travel Center | Amulet, Compass, Door, Elevator, Magic, Teleport, Bus Stop, Portkey |
| Wardrobe | Flat, Accessory, Use, body changer, knick-knack, Potion, Clothing |
| Town Hall | Robot, rental Manager, Registry, Sign and Banner |
| Class Gallery | Quip example and the end of the district street |

The town shuttle uses native Seating and Bus Stop classes and travels between the Lobby, Market and Travel Center every 30 seconds. Sit on it to ride and stand to leave. Each passenger must be admitted to the destination. See [district details](docs/districts.md) and [NPC, companion and bus configuration](docs/special-automation.md).

Content installation is idempotent. Purchased or deleted stock stays gone after a restart. For a new smaller world use `--no-districts`; this does not delete already installed districts. Use a separate `--data-dir` for independent worlds.

The Dockerfile enables the optional [AltAway survey import](docs/survey-import.md) through `WORLDSAWAY_SURVEY_IMPORT_FILE`.
It adds the 46 catalogued regions to the existing world, preserves the full
source archive, and adds an **Explore AltAway** door to the starting lobby.
The import retains its partial coverage and does not reset players or world state.

## Accounts and builder access

Players can choose **Create account** in the browser client and supply an account name, password, and first avatar name. Registration creates both identities atomically, gives the account three avatar slots, and grants the ordinary player role on entry. Duplicate account/avatar names show a conflict without leaving a partially created account. Set `WORLDSAWAY_ALLOW_REGISTRATION=false` to turn off public registration while retaining existing accounts.

For operator account administration or role changes, stop the server first:

```sh
node dist/src/cli.js --add-account alice --avatar Alice
node dist/src/cli.js --set-role Demo --role admin
```

The account command prompts for a masked password. `--password-stdin` supports automation and `--capacity 1` through `8` sets avatar capacity. Roles are `player`, `builder`, and `admin`; authority comes from saved server state. Demo is an ordinary player until explicitly granted a role. `--no-demo` disables demo-account creation in a new data directory.

All concrete classes can be created and edited through the native builder requests and authenticated `/api/world`. Account, abstract base, region, Avatar and Ghost records have dedicated lifecycles. See [builder actions](docs/builder-actions.md) and [management API](docs/management.md).

## Implemented services

| Area | Server behavior |
| --- | --- |
| Identity and transport | World discovery; salted password hashes; one-use login tickets; avatar creation/selection; native fragmented/coalesced frames; bounded filename RPC; versioned resource bootstrap |
| World and presence | Durable regions and groups, directional exits, per-region object identities, multiplayer scene deltas, admission and population controls |
| Avatars and social | Ghost/materialization, bodies/heads, walking, speech, ESP, durable mail, friends/ignore preferences, gestures, moods including asleep, facing, following, web tours |
| Inventory | Get/drop/give, hand and pockets, nested containers, capacity/ownership/locks, accessories/clothing, seating, keys, spraying and engraving |
| Economy | Physical Tokens, separate bank balances, exact payments, deposits/withdrawals, vending, pawn, cashiers, finite prize stock and funded game payouts |
| Documents | Text/pages/binders, printing, newspapers, recycling, parcels, registry, signs and banner presentations |
| Travel and housing | Doors, elevators, teleporters, portkeys, buses, leases/rent/refunds/co-owners, guest policy and owner-exit cleanup |
| Special behavior | Literal and programmed NPC dialogue/trades, pet adoption/following, durable potion effects/expiry, Magic, randomizers, slot machines, spinners and decorators |
| Staff | Object/region/group authoring, typed field/property writes, action metadata, moderation, promotion, image-type changes, forced logout and privileged owner lookup |

The two coverage reports distinguish schema support, handler contracts, conditional receivers, tests, and unverified upstream behavior. A request can correctly fail due to permissions, empty stock, an exhausted charge, missing configuration, or insufficient funds.

## Resources and portability

`resources/manifest.json` and `resources/payload.bin` contain a bounded data-only snapshot: **1,637 MAG resources and 3,538 filename assets**, about 50.7 MB of payload in the currently installed pack. The manifest records the exact counts and hashes for each imported generation. Startup verifies SHA-256 hashes, extents, identities, native file checksums and the aggregate resource profile. It does not need the sibling `wa` directory when the pack is present. Account files, remembered credentials, runtime logs and native executables are excluded from import.

To import another compatible local cache, choose a new destination:

```sh
npm run resources:import -- /path/to/AltAway /path/to/new-resource-pack
npm start -- --resource-pack-dir /path/to/new-resource-pack
```

Import refuses to overwrite an installed pack. An explicit `--client-dir` uses a raw MAG/WSRES cache instead. A damaged installed pack fails explicitly. The legacy media/Tcl resources are supplied local inputs, separate from the authored server code, and `resources/` is ignored by Git. A code checkout needs its own compatible pack or cache. Thirteen unavailable method references across eight class definitions are omitted from the served derived profile, with details in the coverage reports; no missing original method code is fabricated.

## TypeScript development

`src/` contains the server implementation; `scripts/` contains typed build, launch, coverage and resource-import tools. `npm run build` checks and emits `dist/src/*.js`, `dist/scripts/*.js`, public `.d.ts` declarations and source maps. `npm start` runs the compiled server. `npm run dev` runs the source with automatic reload through the development-only `tsx` loader.

The compiler uses `strict: true` and refuses to emit on errors. `src/types.ts` defines durable identities, accounts, objects, avatar profiles, roles and world state; `src/action-types.ts` defines requests, contexts and transaction results. Runtime-supplied CUTESI fields and declarative device configuration use the documented `DynamicFields` boundary; the codecs and world validator still validate those values before transmission or persistence.

Comments explain the native wire conventions, region-local identifiers, authority checks, transaction/reply ordering, file replacement and backup rules, finite stock and currency, companions, and hosted volume ownership. JavaScript tests remain independent consumers of the emitted JavaScript so they exercise the same artifact as production. A compiled-only test runs without source files or development dependencies.

Resources, `protocol/` and mutable `data/` remain beside `dist/`; building never moves or deletes saved accounts and worlds. The multi-stage Docker build keeps the compiler and loader out of the running image. The recorded Railway configuration uses `node dist/scripts/start-hosted.js --host 0.0.0.0 --no-demo`. See [migration validation](docs/typescript-migration.md) for the compiler and runtime checks.

| Path | Purpose |
| --- | --- |
| `src/` | HTTP/authentication, native transport, world state and gameplay implementation |
| `scripts/` | Build, resource import, coverage, native launcher and hosted startup tools |
| `test/` | JavaScript tests against the compiled implementation |
| `protocol/browser-requests.json` | Browser gameplay request catalog |
| `content/` | Authored or imported world content inputs |
| `docs/` | Protocol, gameplay, operations and validation references |
| `resources/` | Local resource pack; excluded from Git |
| `data/` | Mutable accounts, world snapshots, locks and imports; excluded from Git |
| `dist/` | Generated JavaScript, declarations and source maps; excluded from Git |

| Command | Purpose |
| --- | --- |
| `npm run build` | Clean and compile `dist/` with TypeScript checks |
| `npm run typecheck` | Check source types without emitting files |
| `npm run dev` | Run source with automatic reload |
| `npm start -- --help` | List compiled server options |
| `npm run check` | Typecheck, build and validate the configured resource input offline |
| `npm test` | Build and run the Node.js test suite |
| `npm run coverage` | Print the resource/class/action coverage ledger |
| `npm run coverage:write` | Regenerate the feature and browser coverage reports under `docs/` |
| `npm run resources:import -- SOURCE DESTINATION` | Create a new resource pack from a compatible cache |
| `npm run smoke -- --help` | Show the native protocol smoke-client options |

Commands that run `dist/` tools require a prior build. Resource checks, coverage and resource-dependent tests require a pack or compatible cache; `npm run typecheck` does not. Coverage reports are intentional repository documentation, so review their changes when regenerating them.

## Verify

```sh
npm run check
npm test
npm run coverage:write
```

Tests cover every class/schema codec, ownership, permissions, multiplayer synchronization, persistent restarts, transaction failures and rollback, currency conservation, mail, documents, housing, device behavior, NPC programs, buses and companions. A copied server is tested without sibling source/cache directories. Two extra browser integration tests run when the sibling browser build exists; physical raw-cache corpus tests are conditional on that separate input. The browser integration starts with an empty cache and exercises real HTTP → bridge → native TCP → world → RPC paths.

For the browser's own checks:

```sh
cd ../browser-client
npm run check
npm test
```

`npm run smoke -- --help` documents the independent native smoke client. Run smoke against an already running server.

## Configuration and operation

`node dist/src/cli.js --help` lists all options. CLI values override `WORLDSAWAY_HOST`, `WORLDSAWAY_ADVERTISE_HOST`, `WORLDSAWAY_HTTP_PORT`, `WORLDSAWAY_WORLD_PORT`, `WORLDSAWAY_RPC_PORT`, `WORLDSAWAY_ADVERTISE_WORLD_PORT`, `WORLDSAWAY_ADVERTISE_RPC_PORT`, `WORLDSAWAY_PUBLIC_URL`, `WORLDSAWAY_DATA_DIR`, `WORLDSAWAY_RESOURCE_PACK_DIR`, `WORLDSAWAY_CLIENT_DIR`, `WORLDSAWAY_WORLD_NAME`, and `WORLDSAWAY_SURVEY_IMPORT_FILE`. `WORLDSAWAY_ALLOW_REGISTRATION` accepts `true` or `false`.

Set environment variables in your shell or hosting configuration; the application does not automatically load `.env` files. For example:

```sh
WORLDSAWAY_ALLOW_REGISTRATION=false npm start -- --no-demo
```

The optional survey import is selected by `WORLDSAWAY_SURVEY_IMPORT_FILE`; see its [configuration and recovery guide](docs/survey-import.md) before enabling it on saved state.

For another machine on a network, bind a reachable interface and advertise the actual server address:

```sh
npm start -- --host 0.0.0.0 --advertise-host 192.168.1.10
```

The Node browser bridge must be able to reach the HTTP, native TCP and RPC endpoints. Native TCP uses the legacy unencrypted transport; local testing defaults to loopback. The bundled Dockerfile requires both a prepared `resources/` pack and `content/altaway-regions-2026-11-08.json` in the build context. These are local inputs excluded from Git, so a GitHub checkout alone is not a complete Docker build context. Prepare an upload directory from a machine that has those inputs:

```sh
npm ci
npm run deploy:prepare -- /tmp/worldsaway-deploy/context
docker build -t worldsaway-app /tmp/worldsaway-deploy/context
docker run --rm -p 127.0.0.1:8080:8080 -p 127.0.0.1:1701:1701 -p 127.0.0.1:1702:1702 \
  -v worldsaway-data:/app/data worldsaway-app
```

Use a new destination outside the checkout for each preparation. The preparer validates the resource pack and survey, copies an allowlist of build inputs and the three required asset files, and writes a SHA-256 manifest beside the upload directory. It excludes accounts, saved worlds, credentials, Git metadata, dependencies and other local resource/content files. Missing required inputs fail before an upload directory is created; adding an empty `content/` directory does not fix the required survey input.

This example publishes the ports on the Docker host's loopback interface. For clients on another host, publish reachable interfaces and pass an appropriate `WORLDSAWAY_ADVERTISE_HOST`. To disable demo-account seeding, append the complete command `node dist/src/cli.js --host 0.0.0.0 --no-demo` after the image name; Docker arguments after the image replace its default command.

For the existing Railway backend, upload that prepared directory explicitly:

```sh
npx --yes @railway/cli up /tmp/worldsaway-deploy/context --path-as-root --no-gitignore \
  --project f83fe1b9-1444-4fe8-b0d7-ffa20d7ef902 \
  --environment b45249cd-055f-4fee-87e3-d051abfd598d \
  --service dbda1f0f-7f7a-4b9c-86fb-39e3cf3563fd
```

Keep this service on local source uploads while its asset inputs remain outside Git. Reconnecting the GitHub source would again build without them. Upload only the prepared directory; running `railway up --no-gitignore` over the working checkout could also include mutable accounts and other local files. The raw survey remains outside Git because it includes observations excluded by the world importer. The existing Railway volume retains saved accounts and world state across source uploads.

When HTTP and native TCP have different public addresses, configure `--public-url https://your-world-service.example` separately from `--advertise-host native-proxy.example`. `--advertise-world-port` and `--advertise-rpc-port` control the connection file's public ports without changing listener ports. A single public TCP proxy can forward to native port 1701 because that listener multiplexes filename RPC; advertise the same proxy port for both values. The dedicated local RPC listener remains separate. Public URLs require HTTPS; loopback HTTP URLs are accepted for local development.

Use one running process per data directory. `accounts.json` stores hashes and identities; `world.json` stores game state; `world.json.bak` retains the previous transaction. A directory lock prevents concurrent writers. Corrupt or unsupported data is never silently reset. Read [persistence and recovery](docs/persistence.md) before manual recovery. No external deployment is performed by these startup commands.

The recorded Railway deployment uses a 500 MB volume at `/data` for accounts and world state, one replica, and disabled sleeping and deployment overlap. Its hosted startup helper prepares the mounted directory and, when started as root, drops application privileges to uid 1000. Set `WORLDSAWAY_DATA_DIR=/data` when using that mount. `WORLDSAWAY_RECOVER_STALE_LOCK=true` is reserved for an exclusive volume with one replica; see [persistence and recovery](docs/persistence.md) before enabling it. Public hosting should use `--no-demo` and retain durable storage between deployments.

## Files kept out of Git

[`.gitignore`](.gitignore) excludes installed dependencies, compiled output, runtime state, imported legacy resources, local environment files, logs, native `.iv` login handoffs, coverage output, and editor/OS files. Sanitized `.env.example` and `.env.*.example` templates remain eligible for tracking. Source files, the lockfile, tests, authored content and documentation evidence remain eligible for tracking. Keep any custom `--data-dir` or imported resource-pack destination outside the checkout, or add its exact path to your local `.git/info/exclude`.
