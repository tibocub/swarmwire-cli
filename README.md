# swarmwire-cli

Send a file or a folder to someone with a link. Peer to peer, from the terminal: no account, no
server, no upload. Built on [`swarmwire-lib`](https://github.com/tibocub/swarmwire).

```
npm i -g swarmwire-cli

swarmwire send ./holiday-photos        # prints a link, keeps serving until you press ctrl-c
swarmwire get "<link>"                 # on the other machine: downloads it, resumable
```

The link is private by default: it carries a secret, so only people holding it can find you.
Pass `--public` to `send` if anyone who knows the hash should be able to.

Both commands keep a two-line status current. Receiving looks like this:

```
[=========>          ] 45% [2/3]  TOTAL: [154.2/344.0] MB
UP: 1.1 MB/s   DOWN: 8.2 MB/s   Seeders: 1  Peers: 0
```

When the download is done the bar is replaced by `[Done] you are now seeding.` and `get` keeps
running so others can fetch from you; ctrl-c stops it, `--exit` leaves as soon as it is done.
Sending shows `[Seeding]` in place of the bar.

*Seeders* are the peers connected to you that hold all of it, *Peers* the other ones. They are
your direct connections only, never counting yourself and not the whole swarm. Someone who
vanishes without saying goodbye (a pulled cable) drops off after the connection times out, about
fifteen seconds. The speeds are bytes on the wire, so a little above the size of the data. Sizes
are decimal: 1 MB is 1,000,000 bytes.

## Options

| | |
|---|---|
| `send <path> [--public]` | share a file or folder; prints a link |
| `get <link> [output] [--exit]` | fetch by link, then keep seeding it (`--exit`: leave instead); the output defaults to the name in the link |
| `--bootstrap host:port` | use a private DHT instead of the public one (for tests) |

Needs Node 20 or later. Files are shared where they lie: nothing is copied or written next to them.

## Development

```
npm test        # real processes over a private DHT, no internet needed
```

MIT.
