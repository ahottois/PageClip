<!-- Astuce : ajoutez ici une capture d’écran ou un GIF de démo, par exemple : <p align="center"><img src="docs/demo.gif" width="640" alt="PagePin en action"></p> -->

<h1 align="center">📌 PagePin</h1>

<p align="center">
  <b>Des post-it sur n’importe quel site web.</b><br>
  <b>Sticky notes on any website.</b><br>
  <b>Post-it su qualsiasi sito web.</b>
</p>

<p align="center">
  <img alt="Version 2.0.0" src="https://img.shields.io/badge/version-2.0.0-4f46e5">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-4f46e5">
  <img alt="Chrome" src="https://img.shields.io/badge/Chrome-extension-4f46e5?logo=googlechrome&logoColor=white">
</p>

<p align="center">
  <a href="#français">Français</a> · <a href="#english">English</a> · <a href="#italiano">Italiano</a>
</p>

---

## Français

**PagePin** est une extension Chrome qui permet de coller des notes, comme des post-it, sur n’importe quel site web, puis de les retrouver exactement au même endroit.

### Comment ça marche

1. **Activez** : cliquez sur l’icône PagePin, puis sur **« Activer le mode annotation sur ce site »**.
2. **Cliquez et écrivez** : cliquez n’importe où sur la page, écrivez votre note, puis **« Épingler la note »**. Une bulle numérotée (la *puce*) apparaît à cet endroit.
3. **Retrouvez** : ouvrez la liste de vos notes depuis l’icône PagePin et cliquez sur l’une d’elles. PagePin vous ramène sur la page, au bon endroit, avec une bulle qui pulse.

### Fonctions

- 📝 **Notes riches** : titre, gras, italique, listes à puces ou numérotées
- 🏷️ **Étiquettes, priorité et couleur** pour classer vos notes
- ⏰ **Rappels** : une notification arrive à l’heure choisie (une seule fois, tous les jours, chaque semaine ou chaque mois). Un clic dessus vous ramène à la note.
- 🔎 **Retrouver une puce** même sur les longues pages à chargement progressif : PagePin fait défiler la page jusqu’à elle
- 📅 **Tableau de bord** : recherche, filtres (site, priorité, statut, couleur), agenda (jour, semaine, mois, année) et 5 thèmes
- 📤 **Export** des rappels en `.ics` et `.yaml`, et ajout en un clic à Google Agenda ou Outlook
- 🔒 **Vie privée** : pas de compte, pas de serveur. Vos notes restent dans votre navigateur.

### Installation

PagePin s’installe à la main, en mode développeur :

1. Sur cette page GitHub, cliquez sur **Code → Download ZIP**, puis décompressez le fichier.
2. Dans Chrome, ouvrez `chrome://extensions`.
3. Activez le **« Mode développeur »** (en haut à droite).
4. Cliquez sur **« Charger l’extension non empaquetée »** et choisissez le dossier qui contient `manifest.json`.

Épinglez ensuite PagePin dans la barre du navigateur (icône puzzle 🧩).

> [!TIP]
> Après une mise à jour des fichiers, cliquez sur le bouton ⟳ de PagePin dans `chrome://extensions`.

<details>
<summary><b>Pour les développeurs</b></summary>

&nbsp;

Extension **Manifest V3** en JavaScript natif, sans dépendance ni étape de build.

| Fichier | Rôle |
|---|---|
| `manifest.json` | Configuration et permissions |
| `background.js` | Service worker : alarmes de rappel et notifications |
| `content.js` / `content.css` | Mode annotation, puces et fenêtres de note injectés dans les pages |
| `popup.html` / `popup.js` | Menu de l’icône (activer, filtrer, ouvrir le tableau de bord) |
| `dashboard.html` / `dashboard.js` | Tableau de bord, agenda et exports |

| Permission | Pourquoi |
|---|---|
| `storage` | Enregistrer vos notes dans le navigateur |
| `alarms`, `notifications` | Déclencher les rappels à l’heure choisie |
| `activeTab`, `scripting`, `tabs` | Activer le mode annotation sur l’onglet courant et rouvrir la page d’une note |
| `<all_urls>` | Afficher vos puces sur n’importe quel site |

Les seuls liens externes sont les boutons « Outlook » et « Gmail Agenda » du tableau de bord, qui ouvrent un nouvel onglet quand vous cliquez dessus.

</details>

---

## English

**PagePin** is a Chrome extension that lets you stick notes, like sticky notes, on any website, then find them again at the exact same spot.

> [!NOTE]
> The extension’s interface is currently in French. Button names are shown in French, with their translation.

### How it works

1. **Turn it on**: click the PagePin icon, then **“Activer le mode annotation sur ce site”** *(= turn on annotation mode)*.
2. **Click and write**: click anywhere on the page, write your note, then **“Épingler la note”** *(= pin the note)*. A numbered bubble (the *pin*) appears at that spot.
3. **Find it again**: open your notes list from the PagePin icon and click one. PagePin takes you back to the page, at the right spot, with a pulsing bubble.

### Features

- 📝 **Rich notes**: title, bold, italic, bulleted or numbered lists
- 🏷️ **Labels, priority and color** to organize your notes
- ⏰ **Reminders**: a notification arrives at the time you choose (once, daily, weekly or monthly). Click it to jump back to the note.
- 🔎 **Finds your pin** even on long pages that load progressively: PagePin scrolls the page until it reaches it
- 📅 **Dashboard**: search, filters (site, priority, status, color), agenda (day, week, month, year) and 5 themes
- 📤 **Export** reminders as `.ics` and `.yaml`, and add them to Google Calendar or Outlook in one click
- 🔒 **Private by design**: no account, no server. Your notes stay in your browser.

### Installation

PagePin is installed manually, in developer mode:

1. On this GitHub page, click **Code → Download ZIP**, then unzip the file.
2. In Chrome, open `chrome://extensions`.
3. Turn on **“Developer mode”** (top right).
4. Click **“Load unpacked”** and choose the folder that contains `manifest.json`.

Then pin PagePin to the browser toolbar (puzzle icon 🧩).

> [!TIP]
> After updating the files, click PagePin’s ⟳ button in `chrome://extensions`.

<details>
<summary><b>For developers</b></summary>

&nbsp;

A **Manifest V3** extension written in plain JavaScript, with no dependencies and no build step.

| File | Role |
|---|---|
| `manifest.json` | Configuration and permissions |
| `background.js` | Service worker: reminder alarms and notifications |
| `content.js` / `content.css` | Annotation mode, pins and note windows injected into pages |
| `popup.html` / `popup.js` | Icon menu (turn on, filter, open the dashboard) |
| `dashboard.html` / `dashboard.js` | Dashboard, agenda and exports |

| Permission | Why |
|---|---|
| `storage` | Save your notes in the browser |
| `alarms`, `notifications` | Trigger reminders at the chosen time |
| `activeTab`, `scripting`, `tabs` | Turn on annotation mode on the current tab and reopen a note’s page |
| `<all_urls>` | Show your pins on any website |

The only external links are the dashboard’s “Outlook” and “Gmail Agenda” buttons, which open a new tab when you click them.

</details>

---

## Italiano

**PagePin** è un’estensione di Chrome che permette di attaccare note, come dei post-it, su qualsiasi sito web e di ritrovarle esattamente nello stesso punto.

> [!NOTE]
> L’interfaccia dell’estensione è per ora in francese. I nomi dei pulsanti sono indicati in francese, con la traduzione.

### Come funziona

1. **Attiva**: clicca sull’icona di PagePin, poi su **«Activer le mode annotation sur ce site»** *(= attiva la modalità annotazione)*.
2. **Clicca e scrivi**: clicca ovunque sulla pagina, scrivi la nota, poi **«Épingler la note»** *(= fissa la nota)*. Nel punto cliccato compare una bolla numerata (il *pin*).
3. **Ritrova**: apri l’elenco delle note dall’icona di PagePin e clicca su una. PagePin ti riporta alla pagina, nel punto giusto, con una bolla che pulsa.

### Funzioni

- 📝 **Note ricche**: titolo, grassetto, corsivo, elenchi puntati o numerati
- 🏷️ **Etichette, priorità e colore** per organizzare le note
- ⏰ **Promemoria**: una notifica arriva all’ora scelta (una volta, ogni giorno, ogni settimana o ogni mese). Un clic ti riporta alla nota.
- 🔎 **Ritrova il pin** anche nelle pagine lunghe a caricamento progressivo: PagePin scorre la pagina fino a raggiungerlo
- 📅 **Dashboard**: ricerca, filtri (sito, priorità, stato, colore), agenda (giorno, settimana, mese, anno) e 5 temi
- 📤 **Esporta** i promemoria in `.ics` e `.yaml` e aggiungili a Google Calendar o Outlook con un clic
- 🔒 **Privacy**: nessun account, nessun server. Le note restano nel tuo browser.

### Installazione

PagePin si installa a mano, in modalità sviluppatore:

1. In questa pagina GitHub clicca su **Code → Download ZIP**, poi decomprimi il file.
2. In Chrome apri `chrome://extensions`.
3. Attiva la **«Modalità sviluppatore»** (in alto a destra).
4. Clicca su **«Carica estensione non pacchettizzata»** e scegli la cartella che contiene `manifest.json`.

Poi fissa PagePin nella barra del browser (icona puzzle 🧩).

> [!TIP]
> Dopo un aggiornamento dei file, clicca sul pulsante ⟳ di PagePin in `chrome://extensions`.

<details>
<summary><b>Per gli sviluppatori</b></summary>

&nbsp;

Estensione **Manifest V3** in JavaScript nativo, senza dipendenze né fase di build.

| File | Ruolo |
|---|---|
| `manifest.json` | Configurazione e permessi |
| `background.js` | Service worker: allarmi dei promemoria e notifiche |
| `content.js` / `content.css` | Modalità annotazione, pin e finestre delle note inseriti nelle pagine |
| `popup.html` / `popup.js` | Menu dell’icona (attivare, filtrare, aprire la dashboard) |
| `dashboard.html` / `dashboard.js` | Dashboard, agenda ed esportazioni |

| Permesso | Perché |
|---|---|
| `storage` | Salvare le note nel browser |
| `alarms`, `notifications` | Far scattare i promemoria all’ora scelta |
| `activeTab`, `scripting`, `tabs` | Attivare la modalità annotazione nella scheda corrente e riaprire la pagina di una nota |
| `<all_urls>` | Mostrare i pin su qualsiasi sito |

Gli unici link esterni sono i pulsanti «Outlook» e «Gmail Agenda» della dashboard, che aprono una nuova scheda quando ci clicchi.

</details>
