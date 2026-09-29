# Version web de test avec Supabase

Objectif : garder une application web simple pour tester avec un client, sans passer tout de suite par l'App Store ou Google Play.

## Deux espaces

### Espace salarie

- Connexion agent avec nom et matricule dans la premiere version de test.
- Demarrage de tournee par scan camera du QR Poste A.
- Scan camera obligatoire des points de controle.
- Cloture par scan camera du QR Poste A apres les trois points.
- Annulation avec motif facultatif.
- Envoi de chaque evenement vers Supabase.
- Conservation locale seulement comme secours temporaire si le reseau tombe.

### Espace patron

- Connexion patron.
- Liste des tournees en cours, terminees et annulees.
- Detail d'une tournee : agent, matricule, heure de depart, points valides, heure de chaque scan, cloture, motif d'annulation.
- Filtres par date, agent, statut et site client.
- Export CSV plus tard si besoin.
- Alertes plus tard si une tournee n'est pas terminee dans le delai attendu.

## Donnees a stocker

### `agents`

- `id`
- `name`
- `badge`
- `active`
- `created_at`

### `sites`

- `id`
- `name`
- `address`
- `active`
- `created_at`

### `checkpoints`

- `id`
- `site_id`
- `label`
- `kind`
- `qr_payload`
- `sort_order`
- `active`

### `tours`

- `id`
- `site_id`
- `agent_id`
- `status` : `active`, `completed`, `cancelled`
- `started_at`
- `completed_at`
- `cancelled_at`
- `cancel_reason`
- `created_at`

### `tour_scans`

- `id`
- `tour_id`
- `agent_id`
- `checkpoint_id`
- `scan_type` : `start`, `checkpoint`, `close`
- `scanned_at`
- `source_payload`
- `gps_lat`
- `gps_lng`
- `gps_accuracy`
- `created_at`

## Flux technique

1. L'agent scanne un QR code.
2. L'application valide localement le point attendu.
3. L'application enregistre le scan dans Supabase.
4. Supabase met a jour la tournee.
5. Le tableau de bord patron lit les donnees Supabase.
6. Plus tard, on peut ajouter le temps reel pour voir les scans arriver sans recharger.

## Prochaine etape conseillee

Creer le projet Supabase, puis ajouter dans l'application :

- un fichier de configuration `.env.example`,
- un client Supabase,
- une couche `remoteStore`,
- une page patron `/manager.html`,
- les scripts SQL de creation des tables.

La version de test peut rester hebergee en web. Cloudflare Pages affiche l'interface, et l'ecriture des scans va dans Supabase.
