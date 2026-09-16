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

app.get("/api/checkins", (req, res) => {
  let rows = db.checkins.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (req.query.truckId) rows = rows.filter((c) => c.truckId === req.query.truckId);
  if (req.query.status) rows = rows.filter((c) => c.status === req.query.status);
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
  const { truckId, status } = req.query;
  let rows = db.checkins.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (truckId) rows = rows.filter((c) => c.truckId === truckId);
  if (status) rows = rows.filter((c) => c.status === status);

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
