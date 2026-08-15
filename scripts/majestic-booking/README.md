# Surveillance de créneau — Majestic Escape Game (Atlantide)

Script qui surveille un créneau de réservation et, **dès qu'il se libère**, effectue la
**première étape** de la réservation (sélection du créneau) puis s'arrête en laissant le
navigateur ouvert pour que tu finalises toi-même.

Par défaut : <https://majestic-escapegame.paris/atlantide/>, le **15/08/2026 à 20h00**,
vérification **toutes les 10 minutes**.

## Ce que le script fait (et ne fait pas)

| Fait                                                        | Ne fait pas                                          |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| Ouvre la page, accepte les cookies, va sur la date cible     | Ne remplit aucun formulaire, aucune coordonnée        |
| Détecte si le créneau 20h est libre ou complet               | Ne valide jamais un paiement                          |
| Alerte (bip, notification système, webhook optionnel)        | Ne re-verrouille pas le créneau en boucle             |
| Clique **une seule fois** sur le créneau quand il est libre  | Ne martèle pas le site (1 requête / 10 min + jitter)  |

> **Pourquoi une seule fois ?** La plupart des moteurs de réservation bloquent le créneau
> 10 à 15 minutes dès que tu entres dans le tunnel. Rejouer l'étape 1 toutes les 10 minutes
> le garderait verrouillé en permanence et empêcherait les autres clients de réserver — en
> plus de te faire probablement bannir. Ici on boucle sur la **vérification**, et l'étape 1
> n'est jouée qu'une fois, au moment où ça compte.

## Installation

Prérequis : Node.js ≥ 18.

```bash
cd scripts/majestic-booking
npm install
npx playwright install chromium
```

## Utilisation

```bash
# Cas nominal : surveille le 15/08/2026 20h toutes les 10 min,
# puis déclenche l'étape 1 dès que c'est libre
node watch-slot.mjs

# Un autre créneau / une autre salle
node watch-slot.mjs --url https://majestic-escapegame.paris/titanic/ --date 2026-09-12 --time 21:30

# Surveillance seule, sans aucun clic de réservation
node watch-slot.mjs --no-first-step

# Vérification unique (pour piloter par cron) — code retour 0 si libre, 2 sinon
node watch-slot.mjs --once --headless --no-first-step

# Alerte sur téléphone via ntfy.sh
node watch-slot.mjs --webhook https://ntfy.sh/mon-topic-prive
```

Laisse la fenêtre du terminal ouverte : le script tourne en boucle jusqu'à ce que le créneau
se libère, que l'heure du créneau soit passée, ou que tu fasses `Ctrl+C`.

### Options

| Option                | Défaut                        | Rôle                                                        |
| --------------------- | ----------------------------- | ----------------------------------------------------------- |
| `--url <url>`         | page Atlantide                | Page de réservation                                          |
| `--date <AAAA-MM-JJ>` | `2026-08-15`                  | Jour visé                                                    |
| `--time <HH:MM>`      | `20:00`                       | Heure visée                                                  |
| `--interval <sec>`    | `600`                         | Intervalle entre deux vérifications                          |
| `--jitter <sec>`      | `45`                          | Aléa ajouté à l'intervalle (évite un rythme robotique)       |
| `--once`              | off                           | Une seule vérification puis sortie (mode cron)               |
| `--no-first-step`     | off                           | N'effectue jamais l'étape 1, se contente d'alerter           |
| `--headless`          | off                           | Navigateur invisible (déconseillé : tu veux reprendre la main) |
| `--max-checks <n>`    | illimité                      | Arrêt après n vérifications                                  |
| `--webhook <url>`     | —                             | Notification HTTP à chaque alerte (ntfy, Slack, Discord…)    |
| `--webhook-format`    | auto                          | `ntfy` (texte + en-têtes) ou `json` ; auto-détecté sur l'URL  |
| `--out-dir <chemin>`  | `./out`                       | Captures, logs et dumps                                      |
| `--inspect`           | off                           | Mode diagnostic (voir plus bas)                              |
| `--time-regex <re>`   | auto                          | Regex du libellé horaire, si l'auto-détection se trompe      |
| `--slot-selector <s>` | auto                          | Sélecteur CSS du créneau, court-circuite l'auto-détection    |
| `--pre-click <a,b>`   | —                             | Textes à cliquer avant de chercher les créneaux (ex. nb de joueurs) |
| `--browser-path <p>`  | Chromium de Playwright        | Utiliser un Chrome/Chromium déjà installé                    |
| `--next-label <txt>`  | —                             | Bouton cliqué après le créneau (ex. `Réserver`, `Suivant`)   |
| `--no-stop-after-start` | off                         | Continue de vérifier même après l'heure du créneau           |

Les principales options ont aussi un équivalent en variable d'environnement :
`MEG_URL`, `MEG_DATE`, `MEG_TIME`, `MEG_INTERVAL`, `MEG_WEBHOOK`, `MEG_WEBHOOK_FORMAT`,
`MEG_SLOT_SELECTOR`, `MEG_CHROMIUM`.

## Si le créneau n'est pas détecté

Le widget de réservation du site n'a pas pu être inspecté au moment de l'écriture du script :
la détection est donc **heuristique** (elle cherche, dans toutes les frames de la page, les
éléments cliquables dont le texte ressemble à `20h`, `20:00`, `20 h 00`… et regarde s'ils sont
désactivés / marqués « complet »).

Si ça ne colle pas, lance le mode diagnostic :

```bash
node watch-slot.mjs --inspect
```

Il produit dans `out/` :

- `inspect.png` — capture pleine page,
- `inspect.html` — HTML complet,
- `inspect.json` — tous les éléments horaires trouvés, frame par frame, avec leur état.

La console liste chaque créneau détecté sous la forme `[LIBRE]` / `[PRIS]`. Il suffit ensuite
de relancer avec le bon sélecteur :

```bash
node watch-slot.mjs --slot-selector '.booking-slot[data-time="20:00"]'
```

Si le site demande de choisir un nombre de joueurs avant d'afficher les créneaux :

```bash
node watch-slot.mjs --pre-click "4 joueurs,Continuer"
```

## Codes de sortie (mode `--once`)

| Code | Sens                                                              |
| ---- | ----------------------------------------------------------------- |
| `0`  | créneau libre (et étape 1 jouée si elle était demandée)            |
| `1`  | erreur de configuration / Playwright absent                        |
| `2`  | créneau trouvé mais complet                                        |
| `3`  | créneau introuvable ou plantage — **la détection est à revoir**    |
| `4`  | l'heure du créneau est passée, plus rien à surveiller              |

Le `3` est volontairement distinct du `2` : sinon un widget qui change de structure
ressemblerait éternellement à « complet » et tu raterais le créneau sans le savoir.

## Depuis un téléphone

Le script a besoin de Node + Chromium : il ne tourne pas sur iOS ni sérieusement sous
Android. Le téléphone sert à **recevoir l'alerte**, pas à faire tourner la surveillance.

### Option A — ntfy (n'importe quelle machine qui reste allumée)

Installe l'app [ntfy](https://ntfy.sh), abonne-toi à un topic au nom imprévisible
(les topics sont publics), puis :

```bash
node watch-slot.mjs --no-first-step --webhook https://ntfy.sh/<ton-topic>
```

Les URL `ntfy.sh` / `ntfy.io` sont détectées automatiquement (envoi en texte brut, avec
titre, priorité haute et notification cliquable). Pour un ntfy auto-hébergé, force le
format avec `--webhook-format ntfy` ; pour Slack, Discord ou n8n, laisse le format `json`.

### Option B — GitHub Actions, zéro machine

Le workflow [`.github/workflows/watch-slot.yml`](../../.github/workflows/watch-slot.yml)
lance une vérification toutes les 10 minutes et, dès que le créneau se libère, **ouvre une
issue assignée au propriétaire du dépôt** → l'app GitHub mobile envoie une notification
push. Tu ouvres le lien, tu réserves depuis le téléphone, tu fermes l'issue (tant qu'elle
est ouverte, aucune alerte en double n'est créée).

À savoir :

- **Un workflow planifié ne tourne que depuis la branche par défaut** : il faut merger ce
  fichier sur `main` pour que le cron démarre.
- Le cron est en UTC (`*/10 6-17 15 8 *` = toutes les 10 min de 08h à 19h50 heure de Paris,
  le 15 août) et GitHub peut le décaler de 5 à 15 minutes en période de charge.
- Optionnel : ajoute un secret de dépôt `MEG_WEBHOOK` pour recevoir *aussi* la notif ntfy.
- Le job tourne toujours avec `--no-first-step`. Une CI qui ouvre un tunnel de réservation
  que personne ne finalise ne sert à rien et bloquerait le créneau pour les autres.
- Si le code `3` remonte, le job échoue exprès (GitHub t'envoie un mail) : c'est le signal
  que le widget a changé ou que le site filtre les IP GitHub. L'artefact du run contient les
  journaux, et `--inspect` en local permet de recaler les sélecteurs.

Tu peux aussi déclencher le workflow à la main depuis l'onglet Actions (`workflow_dispatch`),
y compris depuis le navigateur du téléphone.

## Lancer en tâche de fond

### macOS / Linux — nohup

```bash
cd scripts/majestic-booking
nohup node watch-slot.mjs > out/nohup.log 2>&1 &
```

### cron toutes les 10 minutes (mode alerte seule)

```cron
*/10 * * * * cd /chemin/vers/scripts/majestic-booking && /usr/bin/node watch-slot.mjs --once --headless --no-first-step --webhook https://ntfy.sh/mon-topic-prive >> out/cron.log 2>&1
```

En mode cron, garde `--no-first-step` : une tâche de fond invisible ne doit pas ouvrir un
tunnel de réservation que personne ne va finaliser. Tu reçois l'alerte, tu lances le script
en mode normal (ou tu réserves à la main).

## Journal

Toutes les vérifications sont horodatées dans `out/runs.log`, et l'étape 1 produit une capture
`out/etape1-<timestamp>.png` — pratique pour vérifier après coup ce que le script a fait.
