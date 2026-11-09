# Native launcher image updates

`buildImageArchive(resources, worldName)` creates a store-method ZIP containing
`<worldName>.idx` and `<worldName>.dat`. These are the two native WSRES files
that AltAwayLogin's image-update path extracts into its `wsres` directory.

The builder uses only admitted filename assets from `ResourceStore`. It
reconstructs a compact committed record table, NUL-terminated filename pool and
contiguous data payloads. The original cache's unused allocation space,
uncommitted tail and missing candidate payload are excluded. Filenames and the
world basename are checked before they become output cache or archive names.

ZIP uses standard CRC-32/ISO-HDLC, while the WSRES row checksum uses the
separate recovered native recurrence. The code does not substitute ZIP CRC-32
for that native checksum. Supplied asset checksums are recomputed and matched
before a row is admitted. Index/data sizes are limited to 128 MiB by default;
the ZIP format uses bounded 32-bit lengths and offsets.

The clean row's opaque and reserved words are initialized to zero, matching a
fresh cache record. This optional update archive does not add missing image
assets or validate a rendered Windows client session. The direct filename RPC
path remains the source of images encountered during normal client operation.
