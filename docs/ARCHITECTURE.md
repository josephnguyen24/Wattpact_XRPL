# Architecture WattPact

## Séparation on-chain / off-chain

| On-chain (XRPL Testnet) | Off-chain |
|---|---|
| Offre figée (Payment + Memo) | Simulateur de compteurs |
| Acceptation signée par le foyer | Calcul de la référence (5 jours comparables) |
| Prime verrouillée (EscrowCreate + Condition) | Verdict (objectif atteint ?) |
| Hash du relevé (Memo) | Relevés en clair (jamais publiés) |
| Libération (EscrowFinish + Fulfillment) ou remboursement (EscrowCancel) | Interface web, API Node.js, état local |

Principe : la blockchain porte les **engagements** et le **règlement** ; la mesure du monde physique reste hors chaîne et ne publie que son empreinte.

## Flux

```
Opérateur --Payment+Memo(offre)--> Vérificateur           (offre figée)
Foyer     --Payment+Memo(hash offre)--> Opérateur         (acceptation signée)
Opérateur --EscrowCreate(Condition, CancelAfter)--> Foyer (prime bloquée)
Vérificateur --Payment+Memo(hash relevés)--> Opérateur    (mesure ancrée avant le verdict)
  objectif atteint : Vérificateur --EscrowFinish(Fulfillment)--> prime au foyer
  objectif manqué  : après CancelAfter, EscrowCancel --> prime rendue à l'opérateur
```

## Escrow conditionnel

- **Condition** (publique, dans EscrowCreate) : `A0258020` + SHA-256(préimage) + `810120`.
- **Fulfillment** (secrète, dans EscrowFinish) : `A0228020` + préimage (32 octets).
- Préimage = HMAC-SHA256(`VERIFIER_SECRET`, `offreHash|adresseFoyer`) : unique par foyer et par offre, recalculable par le vérificateur, jamais stockée ni publiée avant libération.
- L'opérateur voit la condition mais ne peut pas deviner la préimage ; le vérificateur peut libérer mais la destination est figée dans l'escrow (le foyer).
- `CancelAfter` : passé ce délai, n'importe qui peut annuler ; la prime retourne à l'opérateur.

## Décisions techniques

- **XRPL natif, pas de smart contract** : l'escrow conditionnel est natif, rien à écrire ni à auditer.
- **Aucune dépendance de crypto-condition** : format PREIMAGE-SHA-256 construit avec `node:crypto` (testé).
- **Serveurs de secours** : le Wi-Fi de l'école peut bloquer le port 51233 ; `XRPL_SERVERS` liste des serveurs sur le port 443.
- **Simulateur déterministe** : mêmes relevés à chaque exécution, donc démo reproductible.
- **`submitAndWait` + `tesSUCCESS`** : on ne considère une transaction réglée qu'une fois validée.

## Pistes (bonus, vendredi matin si le cœur est terminé)

- Prime indexée sur un prix publié par oracle (`OracleSet`, XLS-47), à vérifier sur le Testnet.
- Jeton « kWh effacé » échangeable sur le DEX.
