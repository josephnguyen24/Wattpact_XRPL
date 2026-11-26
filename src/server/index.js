// API + interface. npm start -> http://localhost:3000
// Écoute sur 127.0.0.1 : le serveur signe avec les seeds de test, pas question de l'ouvrir
// sur le Wi-Fi de l'école. En Codespaces, 0.0.0.0 (le port reste privé par défaut).
import express from "express";
import { fileURLToPath } from "node:url";
import * as svc from "./service.js";

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(fileURLToPath(new URL("../../public", import.meta.url))));
// xrpl.js pour le navigateur : la vue foyer lit le ledger sans passer par notre API
app.use("/vendor", express.static(fileURLToPath(new URL("../../node_modules/xrpl/build", import.meta.url))));

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
app.post("/api/offers", wrap((req) => svc.createOffer(req.body)));                                  // opérateur
app.post("/api/offers/:hash/lock", wrap((req) => svc.lockAccepted(req.params.hash)));               // opérateur
app.post("/api/offers/:hash/settle", wrap((req) => svc.settleOffer(req.params.hash)));             // opérateur
app.post("/api/offers/:hash/accept", wrap((req) => svc.accept(req.params.hash, [].concat(req.body?.foyer ?? [])))); // foyer(s)
app.post("/api/offers/:hash/measure", wrap((req) => svc.measure(req.params.hash, req.body?.reductions)));         // vérificateur
app.post("/api/reset", wrap(() => (svc.resetLocal(), { ok: true })));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.CODESPACES ? "0.0.0.0" : "127.0.0.1");
app.listen(PORT, HOST, () => console.log(`WattPact : http://localhost:${PORT}`));
