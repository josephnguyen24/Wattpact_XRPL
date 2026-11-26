# WattPact

**Marché de l'effacement de consommation sur le XRP Ledger (Testnet).**
Le réseau publie une offre, le foyer l'accepte, et la prime pour les kWh effacés se règle par escrow conditionnel : la prime est verrouillée avant l'effort, personne ne peut revenir sur sa promesse.

Projet du Blockchain Challenge XRPL (ING5, ECE Paris), sujet Énergie. Réseau : **XRPL Testnet**, sans smart contract ni EVM Sidechain. Aucune donnée personnelle on-chain.

## Le problème

Aux heures de pointe, le réseau est sous tension. Rémunérer les foyers qui baissent leur consommation existe déjà, mais le foyer doit croire l'opérateur sur parole. Ici, celui qui paie n'est pas celui qui juge, et celui qui juge ne peut pas toucher l'argent.

| Acteur | Rôle | Compte de test |
|---|---|---|
| Opérateur de flexibilité | Publie l'offre, finance la prime | `operator` |
| Vérificateur (gestionnaire de comptage) | Mesure, calcule la référence, valide l'objectif | `verifier` |
| Foyers | Acceptent l'offre, réduisent leur consommation | `foyer1`, `foyer2`, `foyer3` |

## Scénario

```
Offre -> Acceptation -> Verrouillage (escrow) -> Mesure -> Libération  ou  Remboursement
```

| Étape | Transaction XRPL | Ce qui est on-chain |
|---|---|---|
| Offre | `Payment` + Memo | Créneau, objectif (-20 %), prime (5 XRP) |
| Acceptation | `Payment` + Memo | Hash de l'offre acceptée, signé par le foyer |
| Verrouillage | `EscrowCreate` (Condition, CancelAfter) | Montant, foyer destinataire, condition |
| Mesure | `Payment` + Memo | Hash du relevé, jamais la consommation |
| Libération | `EscrowFinish` (Fulfillment) | Valeur secrète révélée si consommation <= 80 % de la référence |
| Remboursement | `EscrowCancel` | Retour de la prime à l'opérateur, après CancelAfter |

La référence est la moyenne du même créneau sur les 5 derniers jours comparables (jours de semaine). L'objectif est atteint si la consommation mesurée est au plus 80 % de la référence.

## Installation

Prérequis : Node.js LTS (>= 20), npm, Git. Aucune clé ni inscription : le XRP de test vient d'un faucet.

```bash
git clone https://github.com/josephnguyen24/Wattpact_XRPL.git
cd Wattpact_XRPL
npm install
npm run check            # vérifie l'accès au Testnet (serveurs de secours inclus)
npm run setup:wallets    # crée et alimente les 5 comptes de test, écrit .env
npm test                 # tests unitaires (hors réseau)
```

### GitHub Codespaces (recommandé pour l'équipe)

Aucune installation, et le réseau de l'école n'est pas concerné (le Codespace tourne dans le cloud).

1. Sur la page du dépôt : **Code > Codespaces > Create codespace on main**.
2. Attendre la fin du démarrage : `.devcontainer/` installe les dépendances, lance les tests et crée vos 5 comptes Testnet.
3. Vérifier : `npm run check`, puis `npm run demo:mixed`.

Chaque membre a **son propre Codespace et ses propres comptes de test** : rien à partager, aucune seed ne circule. Si le faucet est saturé au démarrage, relancer `npm run setup:wallets`. Les ports 3000 (API) et 5173 (interface) sont redirigés automatiquement.

Pensez à **arrêter ou supprimer** votre Codespace quand vous avez fini (quota gratuit limité) : un Codespace inactif s'arrête seul après 30 min.

### Comptes de test

`npm run setup:wallets` crée 5 comptes via le faucet et écrit leurs seeds dans `.env` (non versionné) ; il affiche les **adresses publiques** et un lien vers l'explorateur. Les adresses ne sont pas figées dans ce dépôt : le Testnet peut être réinitialisé. Si un compte a disparu, relancer `npm run setup:wallets` : les comptes manquants sont ré-alimentés avec les mêmes seeds (mêmes adresses), sans toucher à `.env`. Si le faucet est saturé, le script réessaie automatiquement.

## Interface web

```bash
npm start              # http://localhost:3000
```

Parcours de démo, entièrement dans le navigateur :

1. **Opérateur** : publier l'offre (créneau, objectif, prime).
2. **Foyers** : cliquer « Accepter » pour chaque foyer ; l'acceptation est signée par le foyer, puis la prime est verrouillée en escrow.
3. **Vérificateur** : régler la réduction réelle de chaque foyer (par défaut : 2 réussites, 1 échec), puis « Publier les relevés et régler » : les empreintes partent on-chain, les primes gagnées sont libérées.
4. **Remboursement** : après le compte à rebours `CancelAfter`, « Rembourser l'opérateur ».

Chaque transaction a son lien vers testnet.xrpl.org. L'API (`src/server/`) écoute sur `127.0.0.1` : elle signe avec les seeds de test et ne doit pas être exposée sur le réseau de l'école. L'état local (hashs, séquences d'escrow) est dans `data/app-state.json`, ignoré par Git ; aucune seed ni valeur secrète n'y est écrite.

| Méthode | Route | Effet on-chain |
|---|---|---|
| GET | `/api/accounts` | Adresses publiques et soldes |
| GET | `/api/offers` | Offres et statut de chaque escrow |
| POST | `/api/offers` | `Payment` + Memo (offre) |
| POST | `/api/offers/:hash/accept` | `Payment` + Memo signé par le foyer, puis `EscrowCreate` |
| POST | `/api/offers/:hash/measure` | `Payment` + Memo (empreintes), puis `EscrowFinish` si objectif atteint |
| POST | `/api/offers/:hash/settle` | `EscrowCancel` après `CancelAfter` |

## Lancer la démonstration en ligne de commande

```bash
npm run demo:success   # les 3 foyers atteignent l'objectif : 3 primes libérées
npm run demo:mixed     # 2 foyers réussissent, 1 échoue : 2 libérées, 1 verrouillée
npm run demo:fail      # aucun foyer n'atteint l'objectif
npm run settle         # rembourse à l'opérateur les primes manquées, une fois CancelAfter passé
npm run settle -- --wait   # idem, en attendant CancelAfter
npm run anti-triche    # tentatives de fraude soumises au Testnet : toutes refusées par le ledger
```

| Tentative (`npm run anti-triche`) | Résultat on-chain |
|---|---|
| Le foyer se paie avec une fausse valeur secrète | `tecCRYPTOCONDITION_ERROR` |
| Le foyer se paie sans valeur secrète | `tecCRYPTOCONDITION_ERROR` |
| L'opérateur reprend la prime avant `CancelAfter` | `tecNO_PERMISSION` |
| Le vérificateur libère avec la bonne valeur | Prime versée au **foyer** (destination figée), rien au vérificateur |

Chaque étape affiche le lien de la transaction sur [testnet.xrpl.org](https://testnet.xrpl.org). La durée avant `CancelAfter` se règle avec `CANCEL_AFTER_SECONDS` dans `.env` (180 s par défaut).

**Pour la soutenance** : lancer le scénario d'échec quelques minutes avant le passage, puis `npm run settle` pour montrer la prime déjà remboursée dans l'explorateur ; jouer le scénario de réussite en direct.

## Structure

```
src/
  config.js            paramètres, rôles, liens explorateur
  xrpl/                couche blockchain (xrpl.js)
    client.js          connexion avec serveurs de secours, soumission + vérification tesSUCCESS
    conditions.js      crypto-condition PREIMAGE-SHA-256 (sans dépendance externe)
    market.js          offre, acceptation, escrow, mesure, libération, remboursement
    memo.js            encodage / décodage des Memos
  offchain/            logique hors chaîne
    simulator.js       compteurs simulés, déterministes (graine fixe)
    verifier.js        référence, verdict, empreinte du relevé
    state.js           état local de la démo (data/state.json, ignoré par Git)
  server/              API Express (index.js) et service métier (service.js)
  scripts/             check-testnet, setup-wallets, demo, settle, anti-triche
public/                interface web (HTML, CSS, JS sans build)
test/                  tests unitaires (node:test)
docs/                  architecture, backlog
```

## Sécurité

- Comptes de test uniquement : **aucune seed Mainnet**, jamais.
- Les seeds restent dans `.env` (dans `.gitignore`) et ne sont jamais affichées par les scripts.
- Aucune donnée personnelle on-chain : seul le hash du relevé est publié. Les foyers sont des comptes fictifs.
- La valeur secrète de chaque escrow est **dérivée** (HMAC-SHA256 du secret du vérificateur, de l'offre et du foyer) et n'est pas stockée : elle n'est révélée on-chain qu'à la libération.

## Limites assumées

- **Mesure hors chaîne** : le vérificateur reste un point de confiance ; il publie le hash du relevé avant son verdict.
- **Fraude à la référence** : limitée par une moyenne sur plusieurs jours.
- **Échelle** : un escrow par foyer et par événement.
- **Vie privée** : seul le hash du relevé est on-chain.
- **Adoption** : wallets et réglementation freinent les particuliers ; cible réaliste : le règlement entre agrégateurs et fournisseurs.
- Prime en XRP Testnet (l'escrow natif ne gère que le XRP).

## Équipe

| Rôle | Membre |
|---|---|
| Cheffe de projet, lead blockchain | Alexia Kairouz |
| Back-end et oracle de mesure | Minh-Duc Joseph Nguyen |
| Architecture et sécurité | Alexis Gauthron |
| Front-end et UX | Quentin Robalo |

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) et [docs/BACKLOG.md](docs/BACKLOG.md).
