# bitdoze-crowdsec-dash

A self-hosted web dashboard for [CrowdSec](https://www.crowdsec.net/): read-only
monitoring, decisions, and guided proxy/WAF configuration.

**Status: pre-alpha.** The specification and implementation plan live in
[`crowdsec-dashboard-specification.md`](./crowdsec-dashboard-specification.md).

## Development

Requires Node >= 22.17 (`.nvmrc` pins 24) and npm.

```sh
npm ci
npm run dev
```

On first start the server runs migrations, then prints a one-time setup token:

```
Setup required: open http://localhost:5173/setup and enter token: <token>
```

Open `/setup`, enter the token, and create the first administrator account.

## Production

```sh
npm run build
ORIGIN=http://localhost:3000 npm start
```

`ORIGIN` is the public URL of the app and is required by the production server
(`server/index.js`); it pins the request origin because adapter-node 6 cannot
derive it from the environment. `DATA_DIR` (default `./data`) holds the SQLite
database and auto-generated secrets.

## License

MIT — see [LICENSE](./LICENSE).
