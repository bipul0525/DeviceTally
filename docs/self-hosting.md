# Run the DeviceTally server yourself (without Cloudflare)

DeviceTally's server normally runs on your free Cloudflare account. You can also run the **same server** anywhere that runs Docker or Node.js:
- a VPS or a home server;
- Railway, Fly.io, InstaCloud, or any other host that runs a Dockerfile.

Your data is kept in one SQLite file. The apps and trackers work the same with either server: they only need its address.

| | Cloudflare (default) | Docker / Node |
|---|---|---|
| Setup | In the app, about 3 minutes | `docker compose up -d` on a machine you run |
| Cost | Free plan | Your machine or host |
| Database | Cloudflare D1 (daily free limits) | One SQLite file, no daily limits |
| HTTPS | Included | Add it yourself (below) |
| Updating the server | **Update server** button in the app | `git pull && docker compose up -d --build` |
| Backups | Cloudflare keeps 30 days (time travel) | Copy the data folder (below) |

## 1. Start it with Docker

You need Docker with Compose, and git.

```sh
git clone https://github.com/bipul0525/devicetally
cd devicetally/worker
docker compose up -d
docker compose logs
```

The log prints the **setup token**:
```
DeviceTally server on port 8787, data in /data
Not set up yet. In the DeviceTally app: Sign in as admin, tick "First time on this server", setup token: …
```

Then open the DeviceTally app and:
1. Choose **Sign in as admin**.
2. Tick **First time on this server**.
3. Enter your server's address (e.g. `https://devicetally.example.com`) and the setup token.
4. Choose your email and password.

From then on, add computers from **Devices → Add device**, the same as with Cloudflare.

## 2. Put it behind HTTPS

Computers send their usage and a device key to the server, and you sign in with your password, so **use HTTPS** for anything outside your home network.

The simplest way is [Caddy](https://caddyserver.com), which gets a certificate automatically. You need a domain name pointing at your server. Add Caddy to `docker-compose.yml`:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    command: caddy reverse-proxy --from devicetally.example.com --to devicetally:8787
    volumes: [caddy-data:/data]
```
Also add `caddy-data:` under `volumes:` at the end of the file, and remove the `ports:` lines from the `devicetally` service so it's reachable only through Caddy.

Hosts like Railway and Fly.io give you HTTPS automatically.

On a home network only, `http://<the server's local IP>:8787` works too.

## 3. Hosts

These hosts run the same Dockerfile. The one rule is to give it a **persistent disk mounted at `/data`**; without one, your data is lost when the container restarts.

**Railway**
1. New project → **Deploy from GitHub repo**, with your fork of DeviceTally.
2. Set the **Root directory** to `worker`. Railway finds the Dockerfile.
3. Add a **Volume** mounted at `/data`.
4. Under **Settings → Networking**, choose **Generate domain**. That `https://…` address is your server address.
5. Read the setup token from **Deploy logs**.

**Fly.io**
```sh
cd devicetally/worker
fly launch --no-deploy          # accept the Dockerfile; internal port 8787
fly volumes create devicetally_data --size 1
```
Then add this to `fly.toml`:
```toml
[mounts]
  source = "devicetally_data"
  destination = "/data"
```
Then run `fly deploy` and `fly logs` (the setup token is printed there). Your address is `https://<app>.fly.dev`.

**InstaCloud and other Docker hosts**
1. Deploy the `worker` folder (or its Dockerfile).
2. Expose port **8787**, and attach a persistent volume at **`/data`**.
3. Use the HTTPS address the host gives you.
4. Read the setup token from the logs.

Run **only one copy** of the server, because SQLite is a single file on one disk. Don't scale it to several instances.

## 4. Without Docker (Node.js 22.13+)

```sh
cd devicetally/worker
npm ci && npm run build:node
DATA_DIR=/var/lib/devicetally PORT=8787 npm start
```
Keep it running with systemd, pm2, or similar.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `DATA_DIR` | `/data` in Docker, `./data` otherwise | Where the database (`devicetally.db`) and the generated setup token are kept |
| `SETUP_TOKEN` | made once and printed in the log | The one-time token for creating the admin |
| `RELEASE_REPO` | `bipul0525/devicetally` | Where the server's install links download the app and tracker from |

Behind a proxy, the server takes the client's address from the **last** `X-Forwarded-For` entry, which is the one your own proxy adds. That address is used for the limit on join attempts.

## Updating

```sh
cd devicetally && git pull
cd worker && docker compose up -d --build
```
Database changes are applied automatically at start. They only ever add to the database, never remove anything.

When an app update needs a newer server, the app tells you, and shows this command instead of the Cloudflare **Update server** button.

## Backups

Everything is in the data folder.

With Docker:
```sh
docker compose exec devicetally node -e "new (require('node:sqlite').DatabaseSync)('/data/devicetally.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp devicetally:/data/backup.db ./devicetally-backup.db
```
Without Docker, copy `devicetally.db` while the server is stopped. You can also use **Settings → Data → Export** in the app at any time.

## Moving from Cloudflare

There's no automatic move yet. Export your data (**Settings → Data → Export**) for safekeeping. Then set up the new server, and have each computer **Join with a code** from it. Each tracker uploads the history still in Claude Code's transcripts on that computer.
