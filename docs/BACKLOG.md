# Backlog (à transformer en issues GitHub)

État : le cœur on-chain et le scénario en ligne de commande fonctionnent sur le Testnet (offre, acceptation, escrow, mesure, libération, remboursement). Reste l'API, l'interface, la documentation de soutenance.

## Alexia Kairouz : lead blockchain
- [ ] Relire `src/xrpl/market.js` et valider les choix (CancelAfter, destinations, frais)
- [ ] Gérer les erreurs fréquentes : `tecNO_PERMISSION`, `tecNO_TARGET`, `tecCRYPTOCONDITION_ERROR`
- [ ] Tester le cas limite : tentative de libération avec une mauvaise Fulfillment (doit échouer)
- [ ] Tester le cas : EscrowCancel avant CancelAfter (doit échouer), pour la démo « personne ne triche »
- [ ] Bonus : prime indexée sur oracle (`OracleSet`) ou jeton « kWh effacé » sur le DEX

## Minh-Duc Joseph Nguyen : back-end et oracle de mesure
- [ ] API Node.js (Express) : `GET /offers`, `POST /offers`, `POST /offers/:hash/accept`, `GET /escrows`, `POST /settle`
- [ ] Brancher `demo.js` sur l'API (extraire le scénario en fonctions réutilisables)
- [ ] Persistance de l'état (aujourd'hui `data/state.json`) et reprise après redémarrage
- [ ] Lire l'historique on-chain depuis le ledger plutôt que depuis l'état local

## Alexis Gauthron : architecture et sécurité
- [ ] Revue sécurité : aucune seed dans Git (vérifier l'historique), `.env` ignoré
- [ ] Tests des scénarios (réussite, échec, mixte) et des cas limites
- [ ] Vérifier que le README est reproductible depuis un clone vierge (et en Codespaces)
- [ ] Protocole de reprise si le Testnet est réinitialisé
- [ ] Section « limites anticipées » pour la soutenance

## Quentin Robalo : front-end et UX
- [ ] Interface web : liste des offres, bouton d'acceptation, statut de chaque escrow
- [ ] Liens vers `testnet.xrpl.org` pour chaque transaction
- [ ] Charte WattPact et support de soutenance (10 min de présentation)
- [ ] Parcours de démo chronométré (5 min)

## Équipe
- [ ] Envoyer le lien du dépôt GitHub (jeudi soir)
- [ ] Répétition de la soutenance (vendredi matin)
- [ ] Préparer les réponses aux questions du jury : pourquoi pas une base de données, rôle du vérificateur, vie privée, passage à l'échelle
