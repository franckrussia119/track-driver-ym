// Serveur de suivi de flotte et de conteneurs
// Stockage : fichier JSON simple (aucune base de donnees externe requise)

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Authentification simple (nom d'utilisateur / mot de passe)
// ---------------------------------------------------------------------------
// Identifiants configurables via variables d'environnement (recommande en
// production) ; valeurs par defaut fournies pour un demarrage immediat.
const AUTH_USERNAME = process.env.AUTH_USERNAME || "Franck119";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "CT15a119";
const SESSION_SECRET = process.env.SESSION_SECRET || "changez-ce-secret-en-production";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 heures

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  return data + "." + sig;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf-8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

const PUBLIC_PATHS = new Set(["/login.html", "/api/login", "/api/health"]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const cookies = parseCookies(req);
  if (verifySession(cookies.session)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Session expiree ou non authentifiee." });
  }
  return res.redirect("/login.html");
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const userOk = typeof username === "string" && username === AUTH_USERNAME;
  const passOk = typeof password === "string" && password === AUTH_PASSWORD;
  if (!userOk || !passOk) {
    return res.status(401).json({ error: "Nom d'utilisateur ou mot de passe incorrect." });
  }
  const token = signSession({ user: username, exp: Date.now() + SESSION_TTL_MS });
  res.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`
  );
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Persistance (fichier JSON) — suffisant pour une petite flotte (quelques
// dizaines de camions). Les ecritures sont serialisees pour eviter toute
// corruption en cas d'ecritures concurrentes.
// ---------------------------------------------------------------------------

function seedTrucks() {
  const trucks = [];
  for (let i = 1; i <= 10; i++) {
    trucks.push({
      id: crypto.randomUUID(),
      plate: "Camion-" + String(i).padStart(2, "0"),
      driver: "",
      contractor: "",
      active: true,
    });
  }
  return trucks;
}

function loadDB() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const initial = {
      trucks: seedTrucks(),
      checkins: [],
      settings: { freeDays: 2 },
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), "utf-8");
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (e) {
    console.error("Fichier de donnees corrompu, reinitialisation.", e);
    const initial = { trucks: seedTrucks(), checkins: [], settings: { freeDays: 2 } };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), "utf-8");
    return initial;
  }
}

let db = loadDB();
let writeChain = Promise.resolve();

function persist() {
  writeChain = writeChain.then(
    () => fs.promises.writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf-8")
  );
  return writeChain;
}

// ---------------------------------------------------------------------------
// API — Camions
// ---------------------------------------------------------------------------

app.get("/api/trucks", (req, res) => {
  res.json(db.trucks);
});

app.get("/api/drivers", (req, res) => {
  const names = new Set();
  db.trucks.forEach((t) => { if (t.driver && t.driver.trim()) names.add(t.driver.trim()); });
  db.checkins.forEach((c) => { if (c.driver && c.driver.trim()) names.add(c.driver.trim()); });
  res.json(Array.from(names).sort((a, b) => a.localeCompare(b, "fr")));
});

app.post("/api/trucks", async (req, res) => {
  const { plate, driver, contractor } = req.body || {};
  if (!plate || !String(plate).trim()) {
    return res.status(400).json({ error: "Le numero de plaque est requis." });
  }
  const truck = {
    id: crypto.randomUUID(),
    plate: String(plate).trim(),
    driver: (driver || "").trim(),
    contractor: (contractor || "").trim(),
    active: true,
  };
  db.trucks.push(truck);
  await persist();
  res.status(201).json(truck);
});

app.put("/api/trucks/:id", async (req, res) => {
  const truck = db.trucks.find((t) => t.id === req.params.id);
  if (!truck) return res.status(404).json({ error: "Camion introuvable." });
  const { plate, driver, contractor, active } = req.body || {};
  if (plate !== undefined) truck.plate = String(plate).trim();
  if (driver !== undefined) truck.driver = String(driver).trim();
  if (contractor !== undefined) truck.contractor = String(contractor).trim();
  if (active !== undefined) truck.active = !!active;
  await persist();
  res.json(truck);
});

// ---------------------------------------------------------------------------
// API — Points de passage (check-ins)
// ---------------------------------------------------------------------------

function filterCheckins(query) {
  let rows = db.checkins.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (query.truckId) rows = rows.filter((c) => c.truckId === query.truckId);
  if (query.status) rows = rows.filter((c) => c.status === query.status);
  if (query.driver) {
    const wanted = String(query.driver).trim().toLowerCase();
    rows = rows.filter((c) => (c.driver || "").trim().toLowerCase() === wanted);
  }
  if (query.dateFrom) {
    const from = new Date(query.dateFrom + "T00:00:00").getTime();
    if (!isNaN(from)) rows = rows.filter((c) => new Date(c.timestamp).getTime() >= from);
  }
  if (query.dateTo) {
    const to = new Date(query.dateTo + "T23:59:59.999").getTime();
    if (!isNaN(to)) rows = rows.filter((c) => new Date(c.timestamp).getTime() <= to);
  }
  return rows;
}

app.get("/api/checkins", (req, res) => {
  const rows = filterCheckins(req.query);
  const limit = parseInt(req.query.limit, 10) || 1000;
  res.json(rows.slice(0, limit));
});

app.post("/api/checkins", async (req, res) => {
  const body = req.body || {};
  if (!body.truckId || !body.status) {
    return res.status(400).json({ error: "truckId et status sont requis." });
  }
  const truck = db.trucks.find((t) => t.id === body.truckId);
  let amountReceived = null;
  if (body.amountReceived !== undefined && body.amountReceived !== null && body.amountReceived !== "") {
    const n = Number(body.amountReceived);
    amountReceived = isNaN(n) ? null : n;
  }
  const checkin = {
    id: crypto.randomUUID(),
    truckId: body.truckId,
    plate: truck ? truck.plate : "",
    driver: truck ? truck.driver : "",
    status: body.status,
    containerNo: (body.containerNo || "").trim().toUpperCase(),
    blNo: (body.blNo || "").trim().toUpperCase(),
    eirNo: (body.eirNo || "").trim(),
    location: (body.location || "").trim(),
    deadline: body.deadline || "",
    clientName: (body.clientName || "").trim(),
    amountReceived: amountReceived,
    note: (body.note || "").trim(),
    timestamp: new Date().toISOString(),
  };
  db.checkins.push(checkin);

  // Garde-fou : on conserve au maximum 20 000 points pour rester leger.
  if (db.checkins.length > 20000) {
    db.checkins = db.checkins
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 20000);
  }

  await persist();
  res.status(201).json(checkin);
});

// ---------------------------------------------------------------------------
// API — Parametres
// ---------------------------------------------------------------------------

app.get("/api/settings", (req, res) => {
  res.json(db.settings);
});

app.put("/api/settings", async (req, res) => {
  db.settings = { ...db.settings, ...(req.body || {}) };
  await persist();
  res.json(db.settings);
});

// ---------------------------------------------------------------------------
// Export CSV
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  empty_yard: "Vide - A la cour de l'entreprise",
  empty_returned: "Vide - Retourne au depot",
  loaded_export: "Plein - Vers le port",
  loaded_import: "Plein - Livraison import",
  at_terminal: "Au port / terminal",
  in_transit: "En transit",
  maintenance: "Panne / maintenance",
};

app.get("/api/export/csv", (req, res) => {
  const rows = filterCheckins(req.query);

  const header = [
    "Date/Heure", "Plaque Camion", "Chauffeur", "Statut",
    "N Conteneur", "N BL", "N EIR", "Lieu", "Echeance",
    "Client", "Montant Recu", "Remarque",
  ];
  const lines = [header.join(",")];
  for (const c of rows) {
    const line = [
      c.timestamp, c.plate, c.driver,
      STATUS_LABELS[c.status] || c.status,
      c.containerNo, c.blNo, c.eirNo, c.location, c.deadline,
      c.clientName || "",
      c.amountReceived != null ? c.amountReceived : "",
      (c.note || "").replace(/\n/g, " "),
    ].map((v) => `"${String(v || "").replace(/"/g, '""')}"`).join(",");
    lines.push(line);
  }
  const csv = "\uFEFF" + lines.join("\n"); // BOM pour Excel (accents francais)
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="export_interchanges.csv"');
  res.send(csv);
});

// ---------------------------------------------------------------------------
// Sante (utile pour Coolify / Docker healthcheck)
// ---------------------------------------------------------------------------

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Suivi de flotte en ecoute sur le port ${PORT}`);
});
