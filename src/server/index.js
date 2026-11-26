/**
 * API + interface WattPact. Lancer : npm start  ->  http://localhost:3000
 *
 *   GET  /api/accounts                 adresses publiques et soldes des 5 comptes de test
 *   GET  /api/offers                   offres et statut de chaque escrow
 *   POST /api/offers                   { slot, targetReduction, primeXrp }  publie une offre
 *   POST /api/offers/:hash/accept      { foyer }  acceptation signée + prime verrouillée
 *   POST /api/offers/:hash/measure     { reductions: { foyer1: 0.25, ... } }  mesure + libérations
 *   POST /api/offers/:hash/settle      rembourse les primes manquées après CancelAfter
 *
 * Écoute sur 127.0.0.1 par défaut : l'API signe avec les seeds de test, elle ne doit pas être
 * exposée sur le Wi-Fi de l'école (HOST=0.0.0.0 en Codespaces, où le port reste privé).
 */
import express from "express";
import { fileURLToPath } from "node:url";
import * as svc from "./service.js";

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(fileURLToPath(new URL("../../public", import.meta.url))));

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    res.status(status).json({ error: e.message });
  }
};

app.get("/api/accounts", wrap(() => svc.accounts()));
app.get("/api/offers", wrap(() => svc.listOffers()));
app.post("/api/offers", wrap((req) => svc.createOffer(req.body)));
app.post("/api/offers/:hash/accept", wrap((req) => svc.acceptAndLock(req.params.hash, req.body?.foyer)));
app.post("/api/offers/:hash/measure", wrap((req) => svc.measureAndRelease(req.params.hash, req.body?.reductions)));
app.post("/api/offers/:hash/settle", wrap((req) => svc.settleOffer(req.params.hash)));
app.post("/api/reset", wrap(() => (svc.resetLocal(), { ok: true })));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.CODESPACES ? "0.0.0.0" : "127.0.0.1");
app.listen(PORT, HOST, () => console.log(`WattPact : http://localhost:${PORT}`));
