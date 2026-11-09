# Authored WorldsAway.app world

A new data directory starts with ten regions and 76 objects before a player enters. The three original starter rooms are followed by Market, Workshop, Arcade, Travel Center, Wardrobe, Town Hall and Class Gallery. Every concrete class in the 58-class snapshot is represented. Base classes, Account, Region Group, Region and actor identities retain their structural or dedicated lifecycles.

`contentMigrations.starter-1` records the initial guide/bank/shop/pet installation. `contentMigrations.worldsaway-districts-1` records district IDs, example object IDs, shuttle vehicle and stop IDs. Each marker is committed atomically. Reopening a world preserves renamed rooms, purchased items and deleted stock.

The Lobby normally has Garden to the north, Library to the east and Market to the south. From Market, east visits each subsequent district; west returns along the street. A custom world uses the first available lobby exit. Operator-created regions retain their own exits and addresses.

The bank starts each new profile with a 1,000-token bank balance. The gift Vendroid transfers existing finite stock. Newsstand sales and the Gutenberg use a saved Gazette master; produced copies are portable. The rental Manager offers plan 0 at 10 tokens per seven days with ten initially available homes. Player housing is created on rental. Slots have three real reel objects and a finite cash reserve. The Spinner has six prize items. The Banner has a welcome message and one-per-avatar prize stock.

The town shuttle is a class 53 Seating object. Route 1 visits class 204 stops at the Lobby, Market and Travel Center with a 30-second interval. Sit/Stand uses existing native request IDs; departure moves the bus, its seated passengers and their entire inventory in one transaction. Admission and population restrictions apply to each passenger. An inaccessible destination holds the entire bus. Restart coalesces missed departures rather than replaying them.

The district objects are usable examples of authored rules. Some equipment requires pickup, a free hand, held exact cash, an owned target, a remaining charge, or a builder/admin role. The public scene does not grant authority to configure someone else's object. Refer to [request coverage](browser-coverage.md), [device actions](object-actions.md) and [special automation](special-automation.md) for contracts and configuration.
