# Deploying the game-server with autoscaling on Render

This walkthrough takes the **single Starter instance** game-server you have today and turns it into an **autoscaled, multi-instance** service backed by Redis. Total time: ~30 minutes of dashboard clicks and `git push`. Total monthly cost: ~$85/mo minimum (Pro workspace + 2× Standard instances + Redis).

> Stop here if you don't actually need autoscaling yet. Your current Starter instance peaked at <1% CPU during a real debate. None of this is required to keep the app running — it's required to handle **hundreds of concurrent debates simultaneously without a manual restart**.

---

## What changed in the code

- All cluster-shared state moved out of in-memory `Map`s into Redis:
  - active games (`game:{gameId}` HASHes)
  - matchmaking queues (`queue:{gameType}` ZSETs, atomic match via Lua)
  - player → game mapping (`player-game:{userId}` STRINGs)
  - judge result cache + single-flight lock (`judge:{gameId}` + `judge-lock:{gameId}`)
- Socket.IO is now wired to the Redis adapter (`@socket.io/redis-adapter`). Cross-instance emits route through Redis pub/sub automatically.
- All outbound emits go through rooms (`user:{uid}` and `game:{gid}`) instead of direct socket references — that's what makes them cross-instance routable.
- Disconnect handling uses the cluster-wide `fetchSockets()` to detect reconnections to a *different* instance.

The server **fails fast on startup if `REDIS_URL` is missing** with a helpful error message — so you can't accidentally redeploy without provisioning Redis first.

---

## Step 1 — Upgrade the workspace to Pro

Render's autoscaling and Standard-or-better instances are gated behind the Pro workspace plan.

1. Render dashboard → workspace switcher (top left) → **Settings** → **Plan**.
2. Pick **Pro** ($19/user/mo). Confirm.

After this, the **Scaling** tab appears on every web service's settings page.

## Step 2 — Provision the Redis (Render Key/Value)

1. Dashboard → **New** → **Key/Value**.
2. Same workspace + same region as your `multiplayer-games-2gpb` service. **This matters** — cross-region traffic costs latency and money.
3. Plan: **Starter** ($10/mo) is plenty for the load this server pushes (a single active debate is <1KB in Redis; you'd need tens of thousands of concurrent debates to outgrow it). Free tier works for testing.
4. Name it something like `trendspark-redis`. Create.

Once it spins up, copy the **Internal Redis URL** from its dashboard (looks like `redis://red-xxxxx:6379`). Internal — not external — so traffic stays inside Render's network.

## Step 3 — Wire the env vars on the game-server service

1. Dashboard → `multiplayer-games-2gpb` (or whatever the service is called) → **Environment**.
2. Add:
   - `REDIS_URL` = the Internal Redis URL from Step 2.
   - `REDIS_KEY_PREFIX` = `ts:` (optional, but explicit is good).
3. Make sure these existing ones are still there:
   - `PERPLEXITY_API_KEY`
   - `OPENAI_API_KEY`
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
   - `CLIENT_URL` (or rely on the `*` default)
4. **Save changes** — Render auto-restarts the service. It should come up clean and you'll see `[redis:client] ready` and `[socket.io] redis adapter installed` in the logs.

> If startup fails with `[FATAL] REDIS_URL is not set` you forgot to save Step 3. Re-do.

## Step 4 — Bump the instance type and turn on autoscaling

1. Service → **Settings** → **Instance Type** → pick **Standard** (or higher). $25/mo each. The Starter plan can't do autoscaling.
2. Service → **Scaling**. Toggle autoscaling on.
   - **Min instances**: 2 (one is a single point of failure; two is the smallest "always-on" pair).
   - **Max instances**: start with 4. Tune later.
   - **Target CPU**: 70%.
3. **Save**.

## Step 5 — Websocket-only transport (Render has no sticky sessions, so we work around it)

Skip this step in the dashboard — there's nothing to click. Render does **not** support sticky sessions ([open feature request since 2022](https://feedback.render.com/features/p/sticky-session)). The standard fix when running Socket.IO behind a non-sticky load balancer is to disable the HTTP-polling fallback and use **websocket-only** transport.

**Why polling needs sticky sessions and websocket doesn't.** Polling makes a *new HTTP request every few seconds*. Each request goes through the LB independently, so without affinity each one can land on a different instance. The instance that receives a polling request for session `xyz` looks it up in *its own* memory — and if that session was created on a different instance, you get `400: Session ID unknown`. Websocket is one upgraded connection that lives on one instance for its entire lifetime; cross-instance routing of *events* is then handled by the redis-adapter we wired up.

Both sides are already configured for you in this commit:

- Server (`game-server/server/index.js`): `transports: ['websocket'], allowUpgrades: false`
- iOS (`Trendspark/Games/Services/SocketManager.swift`): `.forceWebsockets(true)`

**Trade-off:** websocket connections fail in some corporate firewalls / VPNs that block the WS upgrade. Not a real concern for an iOS consumer app on cellular or home wifi — they connect on every modern network. If you ever ship a web client that needs polling fallback, you'd need to either (a) host the polling-capable clients on a single-instance service, or (b) move to a platform with sticky sessions like Fly or Heroku.

## Step 6 — Push the code

```bash
cd game-server/server
git add .
git commit -m "Redis-backed shared state for horizontal scaling"
git push origin main
```

Render auto-deploys on push. Wait for the new build to go live; then watch the logs:

```
[redis:client] connecting…
[redis:client] ready
[redis:pub] ready
[redis:sub] ready
[socket.io] redis adapter installed
Server running on port 10000
```

If you see those lines on **both** running instances, you're done.

---

## How to verify it actually works

1. Open the iOS app on two devices, sign in as different users.
2. Both hit "Find Match" on the same topic. They should pair within a second or two.
3. While they're chatting, in the Render dashboard → service → **Manual Scale → Restart**. This kills one instance.
4. The surviving instance (with the redis-adapter) keeps the debate alive. The iOS clients reconnect transparently within ~12 seconds (the `RECONNECT_GRACE_MS` window) and pick up exactly where they left off — same question, same chat history (the iOS side keeps the chat array; server-side state — phase, matchRequests — is reloaded from Redis).

If both clients lose state on a restart, something's wrong with the Redis wiring. Check `REDIS_URL` and look for `[redis:*] error` lines in the logs.

---

## Local development with the same setup

There's a `docker-compose.yml` at the top of `game-server/` that starts:

- Redis 7
- two game-server instances (`gs1` on port 3001, `gs2` on 3002)
- nginx round-robin LB on port 8080 with `ip_hash` (the local equivalent of Render's session affinity)

```bash
cd game-server
cp server/.env.example server/.env   # fill in the keys
docker compose up --build
```

Hit `http://localhost:8080/` from your iOS sim instead of the Render URL. To prove the refactor really is multi-instance correct: `docker compose stop gs1` mid-debate; the players keep chatting through `gs2`.

---

## Cost reality

| Component                | Old | New |
|--------------------------|-----|-----|
| Workspace                | Hobby (free) | Pro ($19/u/mo) |
| game-server instances    | 1× Starter ($7) | 2× Standard ($50) |
| Redis (Key/Value)        | — | Starter ($10) |
| Total floor              | **$7/mo** | **$79/mo** |
| Total at peak (4× Std)   | $7/mo | $129/mo |

Worth it once your peak concurrency justifies it. Probably **not** worth it until you're consistently seeing >50% CPU on the Starter, or you simply can't tolerate the ~1 minute of downtime for a Render auto-restart.
