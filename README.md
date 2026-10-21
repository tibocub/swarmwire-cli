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

While sending, the terminal shows who is connected and how many of them already have everything:

```
peers: 2 (1 with all of it)
```

Those numbers describe your direct connections only, not the whole swarm.

## Options

| | |
|---|---|
| `send <path> [--public]` | share a file or folder; prints a link |
| `get <link> [output]` | fetch by link; the output defaults to the name in the link |
| `--bootstrap host:port` | use a private DHT instead of the public one (for tests) |

Needs Node 20 or later. Files are shared where they lie: nothing is copied or written next to them.

## Development

```
npm test        # real processes over a private DHT, no internet needed
```

MIT.
