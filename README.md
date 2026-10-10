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

## Docker

```sh
docker run -d --name csdash \
  -p 127.0.0.1:3000:3000 \
  -v csdash-data:/data \
  ghcr.io/bitdoze/bitdoze-crowdsec-dash:edge
```

Then create the first administrator: the one-time setup token is printed in
`docker logs csdash` — open `http://localhost:3000/setup` and enter it.
For a real hostname set `-e ORIGIN=https://dash.example.com`.

With Docker Compose (`compose.yaml`):

```sh
docker compose up -d
docker compose logs -f dashboard   # setup token is logged here
```

Published image tags: `edge` (main branch), `X.Y.Z` / `X.Y` / `latest`
(releases), and `sha-<commit>`.

## Documentation

- [Deployment](docs/deployment.md) — topologies, env vars, agent, Cloudflare edge
- [Upgrading](docs/upgrading.md) — upgrade, rollback, migration notes
- [Recovery](docs/recovery.md) — failure modes, backup/restore
- [Compatibility](docs/compatibility.md) — supported matrix, limits
- [Acceptance matrix](docs/acceptance-matrix.md) — what is verified and how
- [Benchmarks](docs/benchmarks.md) — methodology and measured numbers
- [Proxy integrations](docs/proxies.md)
- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## License

MIT — see [LICENSE](./LICENSE).
