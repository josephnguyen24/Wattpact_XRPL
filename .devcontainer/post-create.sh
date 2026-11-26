#!/usr/bin/env bash
# Exécuté une fois à la création du Codespace.
set -u

echo "==> Installation des dépendances"
npm install

echo "==> Tests unitaires (hors réseau)"
npm test || echo "Tests en échec : voir la sortie ci-dessus."

# Chaque personne a SES propres comptes de test (le faucet est gratuit).
# Échec non bloquant : le faucet peut être saturé, relancer alors : npm run setup:wallets
if [ ! -f .env ]; then
  echo "==> Création des 5 comptes Testnet (faucet)"
  npm run setup:wallets || echo "Faucet indisponible : relancer 'npm run setup:wallets' dans quelques secondes."
fi

echo
echo "Prêt. Vérifier l'accès : npm run check | Démo : npm run demo:mixed"
echo "Rappel : .env contient des seeds de test, il est ignoré par Git. Ne jamais le partager."
