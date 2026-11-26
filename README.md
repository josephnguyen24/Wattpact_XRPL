# WattPact

Marché de l'effacement de consommation sur le XRP Ledger (Testnet). Projet du Blockchain Challenge XRPL, ING5 ECE Paris, sujet Énergie.

Aux heures de pointe (18h-20h l'hiver), on paie les foyers qui baissent leur consommation. Ça existe déjà, mais le foyer doit croire l'opérateur sur parole. Dans WattPact, la prime est bloquée dans un escrow **avant** l'effort : l'opérateur ne peut plus la reprendre, le vérificateur peut la débloquer mais elle ne peut aller qu'au foyer.

Trois acteurs, cinq comptes de test : un opérateur (paie), un vérificateur (mesure et tranche), trois foyers.

## Ce qui se passe sur le ledger

1. **Offre** : `Payment` + Memo de l'opérateur (créneau, objectif -20 %, prime 5 XRP). Son hash sert d'identifiant.
2. **Acceptation** : `Payment` + Memo signé par le foyer, qui référence le hash de l'offre.
3. **Prime bloquée** : `EscrowCreate` vers le foyer, avec une `Condition` (hash d'une valeur secrète du vérificateur) et un `CancelAfter`.
4. **Mesure** : `Payment` + Memo du vérificateur avec l'empreinte SHA-256 de chaque relevé. La consommation reste hors chaîne.
5. **Objectif atteint** : `EscrowFinish` avec la valeur secrète, la prime part au foyer.
6. **Objectif manqué** : `EscrowCancel` après `CancelAfter`, la prime revient à l'opérateur.

Référence = moyenne du même créneau sur les 5 derniers jours de semaine. Objectif atteint si conso <= 80 % de la référence.

## Installation

Node.js 20+.

```bash
git clone https://github.com/josephnguyen24/Wattpact_XRPL.git
cd Wattpact_XRPL
npm install
npm run setup:wallets   # crée les 5 comptes via le faucet, seeds dans .env
npm start               # http://localhost:3000
```

En Codespaces : Code > Codespaces > Create codespace, tout s'installe tout seul.

Si le Testnet a été réinitialisé, relancer `npm run setup:wallets` : les comptes sont ré-alimentés avec les mêmes adresses. Si le Wi-Fi bloque le port 51233, on bascule sur un serveur en port 443 (voir `XRPL_SERVERS` dans `.env.example`).

## Démo

Ouvrir deux onglets : `#operateur` et `#foyer1`, par exemple.

1. Opérateur : publier l'offre.
2. Foyers : accepter (ou le lien « faire accepter les 3 foyers » pour aller vite).
3. Opérateur : bloquer les primes.
4. Foyer : « Vérifier sur le ledger ». Le navigateur relit l'offre, l'acceptation et l'escrow directement sur le Testnet, sans passer par notre serveur.
5. Vérificateur : régler les baisses (par défaut 2 réussites, 1 échec), publier les relevés.
6. Opérateur : récupérer la prime non gagnée une fois l'échéance passée.

Chaque transaction a son lien vers testnet.xrpl.org. Pour une démo courte : `CANCEL_AFTER_SECONDS=60` dans `.env`.

Autres scripts :

```bash
npm run demo:mixed      # le même scénario en ligne de commande (aussi demo:success, demo:fail)
npm run settle          # remboursement des primes manquées
npm run anti-triche     # essaie de tricher, le ledger refuse
npm test
```

`anti-triche` envoie de vraies transactions frauduleuses : le foyer qui se paie avec une fausse valeur secrète ou sans valeur (`tecCRYPTOCONDITION_ERROR`), l'opérateur qui reprend la prime avant l'échéance (`tecNO_PERMISSION`). Puis la vraie libération, qui paie le foyer et pas le vérificateur.

## Code

- `src/xrpl/` : connexion (avec serveurs de secours), transactions, crypto-condition PREIMAGE-SHA-256 faite avec `node:crypto`
- `src/offchain/` : simulateur de compteurs (déterministe), calcul de la référence, verdict
- `src/server/` : API Express utilisée par l'interface
- `public/` : interface, sans build
- `src/scripts/` : setup, démo CLI, settle, anti-triche

## Sécurité

- Comptes de test uniquement. Les seeds sont dans `.env`, jamais commitées, jamais affichées.
- La valeur secrète de chaque escrow est dérivée (HMAC du secret du vérificateur + offre + foyer) et jamais stockée. Elle n'apparaît on-chain qu'au moment de la libération.
- Le serveur écoute sur `127.0.0.1` seulement : il signe avec les seeds, il ne doit pas être joignable depuis le Wi-Fi de l'école.
- Rien de personnel on-chain : seulement des empreintes.

## Limites

- La mesure reste hors chaîne : il faut faire confiance au vérificateur sur le relevé. Il publie l'empreinte avant de trancher, donc il ne peut pas changer le relevé après coup.
- Un foyer peut gonfler sa conso les jours d'avant pour améliorer sa référence. La moyenne sur 5 jours limite l'effet sans le supprimer.
- Un escrow par foyer et par événement : ça ne passe pas à des millions de foyers tel quel.
- Les particuliers n'ont pas de wallet. Cible plus réaliste : le règlement entre agrégateurs et fournisseurs.
- L'escrow natif ne gère que le XRP, d'où une prime en XRP.

## Équipe

- Alexia Kairouz : cheffe de projet, blockchain
- Minh-Duc Joseph Nguyen : back-end, mesure
- Alexis Gauthron : architecture, sécurité
- Quentin Robalo : front-end

Détails : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/BACKLOG.md](docs/BACKLOG.md).
