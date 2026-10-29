# Melvor Idle – self-hosted

Plays the Steam version of Melvor Idle in any regular browser. Ownership of the base game and DLCs is checked
against the Steam client running on this machine.

## How it works

- **Steam**: `server.js` uses [steamworks.js](https://github.com/ceifa/steamworks.js) `0.3.1` (the version the
  game's own code targets). It loads Valve's `steam_api64.dll` from `node_modules/steamworks.js/dist/win64/`, which
  talks to the running Steam client. On startup the server refuses to continue if that DLL is not signed by Valve,
  so a Steam emulator can't fake ownership.
- **Ownership gate**: nothing from the game is served unless Steam reports app `1267910` as owned. DLC ownership
  (`2055140`, `2492940`, `2860590`) is asked of Steam on every page load and passed to the game.
- **Game**: the desktop app is only an iframe of `https://steam.melvoridle.com`. The server reverse-proxies that
  site onto its own origin and injects `bridge.js`, which provides the `greenworks` / `nw` objects the game expects
  from the desktop shell and forwards Steam calls (achievements, rich presence, auth ticket, Steam Cloud saves) to
  the server.
- The game folder (`../game`) is not used at all.

## Run

Requirements: Node 18+, and Steam running and signed in on this machine to the account that owns the game.

```bash
npm install
```

```bash
npm start
```

Open `http://<this machine>:8787` and sign in with the password from `config.json`. The password is generated on
first run, and you can change it there.

## config.json

| key            | default                         | notes                                                         |
| -------------- | ------------------------------- | ------------------------------------------------------------- |
| `host`, `port` | `0.0.0.0`, `8787`               |                                                               |
| `password`     | random                          | login password                                                |
| `sessionSecret`| random                          | signs login cookies; change it to log out every device        |
| `tls.cert/key` | empty                           | paths to a cert/key to serve HTTPS directly                   |
| `trustProxy`   | `false`                         | set `true` when behind a reverse proxy that sets `X-Forwarded-*` |
| `upstream`     | `https://steam.melvoridle.com`  |                                                               |

## Access from anywhere

Anyone who gets past the login plays as your Steam account, so don't expose plain HTTP to the internet. Use one of:

- a VPN such as Tailscale or WireGuard, then browse to the server's VPN address, or
- a reverse proxy with HTTPS (Caddy, nginx, Cloudflare Tunnel) in front of `127.0.0.1:8787`, with
  `"host": "127.0.0.1"` and `"trustProxy": true`.

## Saves

- Local saves live in each browser's storage, as on the website.
- Melvor Cloud saves work as usual.
- Steam Cloud saves go through the server's Steam client, so they follow you between browsers.

## Known limitations

- Discord Rich Presence is disabled, because there's no Discord client in a remote browser.
- The mod-dev "package mod" tool needs the desktop file system and won't work.
- Steam allows one active game session per account, so playing on another PC with the same account at the same
  time will conflict.
