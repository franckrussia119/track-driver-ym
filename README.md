# Suivi de la Flotte & des Conteneurs

A small self-hosted app to log truck/container check-ins (from your WhatsApp
group) and track detention risk. French UI, Node.js + Express backend,
data stored in a local JSON file — no external database required.

## What it does

- **Enregistrer un Point** — log a check-in for a truck: status (empty at
  yard, loaded, in transit, etc.), container number, EIR number, location,
  and — for empty containers — a free-time return deadline.
- **Tableau de Bord** — live table of every truck's latest status, with
  containers overdue past your detention-risk threshold highlighted in red.
- **Historique** — look up where a truck was on any past date, plus a full
  filterable log with CSV export.
- **Camions** — manage your fleet list (add/edit/deactivate trucks and
  drivers).

## Running locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`. Data is stored in `data/db.json`
(created automatically on first run, seeded with 10 placeholder trucks).

## 1. Push to GitHub

```bash
cd fleet-tracker
git init
git add .
git commit -m "Initial commit: fleet & container tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

(Create the empty repository on GitHub first, without a README, then run
the commands above.)

## 2. Deploy on Coolify

1. In Coolify, click **New Resource → Application → Public/Private Git
   Repository**, and point it at your GitHub repo.
2. Coolify will detect the `Dockerfile` automatically — choose
   **Dockerfile** as the build pack if it doesn't pick it up on its own.
3. **Set a persistent volume** (important): map a volume to `/app/data`
   inside the container. Without this, every redeploy wipes your check-in
   history, since `data/db.json` lives inside the container filesystem.
   - In Coolify: Application → Storage → Add Volume →
     source: e.g. `fleet-tracker-data`, destination: `/app/data`.
4. Set the `PORT` environment variable if your Coolify setup requires a
   specific port (defaults to `3000`, which the Dockerfile also exposes).
5. Deploy. Coolify will build the image and start the container; the app
   will be reachable at the domain/URL Coolify assigns (or your custom
   domain if you attach one).
6. Visit the URL, go to the **Camions** tab, and replace the 10 placeholder
   trucks with your real plates and drivers.

## Notes / limitations

- Storage is a single JSON file with serialized writes — fine for a fleet
  of this size (a handful of people logging check-ins), not built for
  heavy concurrent write loads.
- There's a soft cap of 20,000 check-ins (oldest are trimmed automatically)
  to keep the file small; export to CSV periodically if you want to keep
  full history long-term.
- No login/auth is built in — anyone who can reach the URL can read and
  write data. If you expose this outside a private network, put it behind
  Coolify's built-in basic auth or a reverse-proxy auth layer, or add your
  own login before making it internet-facing.
- The dashboard refreshes automatically every 15 seconds; it's not
  real-time push, just polling, which is enough for this use case.
