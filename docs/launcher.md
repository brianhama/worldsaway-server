# Connect and upgrade the WA client runtime

Requires Node.js 20 or later and the original Windows client files.
The server may run on macOS, Linux or Windows; `wa32.exe` and `reno32.exe`
still run on Windows.

From `server`, start the server:

```bat
scripts\start-server.cmd
```

In a second Windows terminal:

```bat
scripts\launch-client.cmd --demo
```

Choose another source location when needed:

```bat
scripts\launch-client.cmd --demo --client-dir "C:\Games\WA"
```

The helper checks `/health`, POSTs encoded `account/password/avatar` fields
to `/connect.iv`, and launches the chosen native executable with one new
ASCII `.iv` handoff path. Demo credentials are `demo/demo`, avatar `Demo`.
Without `--demo`, password input is masked. `--password-stdin` accepts one
line and cannot be combined with `--demo`.

## Resource-profile isolation

The default runtime is:

```text
%LOCALAPPDATA%\WACompat\<client-hash>\<resource-profile-hash>\Client
```

The two path components are twelve-character hash prefixes. If LOCALAPPDATA
is unavailable, the OS temporary directory is the parent. The marker records
the full selected executable hash, executable name and resource profile.

The server filters the missing dependencies of all affected class
definitions rather than only the old Ghost lobby. This changes the resource
profile. The updated launcher therefore selects a new default runtime instead
of mixing the old cached definitions with the new world.

Only the selected executable, `worldsaw.fon` and optional diagnostic helper
are copied. `--editor` also selects `reno32.exe` and copies its SDT catalogs.
Original MAG/WSRES caches, saved original accounts, `aalogin.ini` and the
.NET launcher are not copied. The server delivers the validated resource
baseline and filename images to this separate writable copy.

For an explicit path, use:

```bat
scripts\launch-client.cmd --demo --runtime-dir "C:\WACompat\World03"
```

That directory must be new or already owned by this launcher with matching
hash/profile markers. Existing unrelated directories and mismatched profiles
are rejected. Do not select the original installation or erase it to resolve a
profile mismatch.

The handoff file is exclusively created and contains a short-lived one-use
ticket. Existing output files are never overwritten. The conservative native
path guard requires an ASCII path plus quote bytes to be shorter than 280
bytes; use a shorter new `--output` path when required.

## Persistent identity and actor mode

The cache/runtime directory is separate from server account and world data.
A fresh client runtime does not create another account, erase inventory,
reset bank balances or change roles. Those records come from the server's
retained `data/` directory.

New profiles start as a Ghost to preserve the confirmed baseline. Use the
client's materialization menu to become a visible Avatar with a head and
inventory. Ghost/Avatar choice and possessions are persistent; ghosting hides
carried items from the wire view without deleting them. Normal player menu
flags are now enabled, while server-side role/ownership checks still decide
which actions are permitted.

The `--editor` switch chooses an executable, not privileges. To grant an
existing local avatar staff authority, stop the server and run:

```sh
node dist/src/cli.js --set-role Demo --role admin
```

Then restart the server and reconnect. `player` and `builder` are the other
roles. In-server authoring and sensitive administrative operations use the
persisted role; client object flags cannot promote an avatar.

## Server on another machine

Start the Node server with its LAN address:

```sh
node dist/src/cli.js --host 0.0.0.0 --advertise-host 192.168.1.10
```

On Windows:

```bat
scripts\launch-client.cmd --server http://192.168.1.10:8080 --demo --client-dir "C:\Games\WA"
```

Replace the example IP. The advertised HTTP, world and RPC ports must be
reachable. A handoff containing `127.0.0.1` refers to the Windows client
machine.

The helper refuses redirects and does not start `AltAwayLogin.exe` or
`wstunnel`. The original .NET launcher can use this server's Webhost in a
separate test installation; the server advertises direct TCP. No WebSocket
relay is implemented. PowerShell wrappers accept the same options; the
`.cmd` wrappers do not require an execution-policy change.

## Obtain a handoff without Windows

```sh
node dist/scripts/launch-client.js --demo --download-only --output ./local.iv
```

The server must advertise the eventual client's reachable address. Transfer
the file promptly, then launch manually from a separate writable client copy:

```bat
wa32.exe "C:\WACompat\local.iv"
```

Generate another file for every session. The launcher `--help` lists
`--server`, `--client-dir`, `--runtime-dir`, `--account`, `--avatar`,
`--demo`, `--password-stdin`, `--editor`, `--download-only` and `--output`.

## Verification scope

The user confirmed the original 0.2.0 client connection. Automated launcher
tests check handoff parsing, bounds, credentials, runtime isolation and native
invocation using mocks. They do not execute the Windows shell wrappers or
verify every new gameplay/editor interaction. Keep a fresh profile-specific
runtime when testing the server changes and report the actual native action/error
if a menu path fails.

