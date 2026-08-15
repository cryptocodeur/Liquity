#!/usr/bin/env node
/**
 * watch-slot.mjs
 *
 * Surveille un créneau de réservation (par défaut : Atlantide, Majestic Escape
 * Game, le 15/08/2026 à 20h00) et, dès qu'il est disponible, effectue UNE FOIS
 * la première étape de la réservation (sélection du créneau) puis s'arrête en
 * laissant le navigateur ouvert pour que tu finalises à la main.
 *
 * Le script ne remplit aucun formulaire, ne saisit aucune coordonnée et ne
 * valide jamais un paiement.
 *
 * Volontairement : la boucle de 10 min ne ré-entre PAS dans le tunnel de
 * réservation en boucle. Ré-ouvrir l'étape 1 toutes les 10 min garderait le
 * créneau verrouillé en permanence côté moteur de résa et le rendrait
 * inaccessible aux autres clients. On boucle sur la *vérification*, pas sur la
 * mise en panier.
 *
 * Usage :
 *   node watch-slot.mjs                          # surveille puis étape 1
 *   node watch-slot.mjs --once                   # une seule vérification (cron)
 *   node watch-slot.mjs --inspect                # dump du DOM pour régler les sélecteurs
 *   node watch-slot.mjs --no-first-step          # alerte seulement, ne clique rien
 *
 * Voir README.md pour toutes les options.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "\nPlaywright est introuvable. Installe-le d'abord :\n"
      + `  cd ${__dirname} && npm install && npx playwright install chromium\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------- CLI / config

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const raw = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq !== -1) args[key] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(fs.readFileSync(path.join(__dirname, "README.md"), "utf8"));
  process.exit(0);
}

const bool = (v, dflt) => (v === undefined ? dflt : v !== "false" && v !== "0" && v !== false);

const CFG = {
  url: args.url ?? process.env.MEG_URL ?? "https://majestic-escapegame.paris/atlantide/",
  date: args.date ?? process.env.MEG_DATE ?? "2026-08-15",
  time: args.time ?? process.env.MEG_TIME ?? "20:00",
  intervalSec: Number(args.interval ?? process.env.MEG_INTERVAL ?? 600),
  jitterSec: Number(args.jitter ?? 45),
  maxChecks: Number(args.maxChecks ?? 0), // 0 = illimité
  once: bool(args.once, false),
  inspect: bool(args.inspect, false),
  firstStep: bool(args.firstStep, true) && !bool(args.noFirstStep, false),
  headless: bool(args.headless, false),
  timeoutMs: Number(args.timeout ?? 45000),
  outDir: args.outDir ?? path.join(__dirname, "out"),
  webhook: args.webhook ?? process.env.MEG_WEBHOOK ?? null,
  // "ntfy" (texte brut + en-têtes) ou "json" ; auto-détecté sur l'URL par défaut
  webhookFormat: args.webhookFormat ?? process.env.MEG_WEBHOOK_FORMAT ?? null,
  // Échappatoires si l'auto-détection ne suffit pas (voir --inspect) :
  slotSelector: args.slotSelector ?? process.env.MEG_SLOT_SELECTOR ?? null,
  timeRegex: args.timeRegex ?? null,
  preClick: (args.preClick ?? "").toString().split(",").map((s) => s.trim()).filter(Boolean),
  nextLabel: args.nextLabel ?? null, // ex: "Réserver" — bouton cliqué après le créneau
  stopAfterStart: bool(args.stopAfterStart, true),
  browserPath: args.browserPath ?? process.env.MEG_CHROMIUM ?? null,
};

/** Codes de sortie — pensés pour être exploitables depuis cron / CI. */
const EXIT = {
  AVAILABLE: 0, // créneau libre (et étape 1 jouée si demandée)
  ERROR: 1, // erreur de configuration / lancement
  TAKEN: 2, // créneau détecté mais complet
  BROKEN: 3, // créneau introuvable ou plantage : la détection est à revoir
  PAST: 4, // l'heure du créneau est passée, plus rien à surveiller
};

const MONTHS_FR = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(CFG.date);
if (!dateMatch) {
  console.error(`Date invalide : "${CFG.date}" (format attendu : AAAA-MM-JJ)`);
  process.exit(EXIT.ERROR);
}
const timeMatch = /^(\d{1,2})[:h.]?(\d{2})?$/.exec(CFG.time);
if (!timeMatch) {
  console.error(`Heure invalide : "${CFG.time}" (format attendu : HH:MM)`);
  process.exit(EXIT.ERROR);
}

const TARGET = {
  year: Number(dateMatch[1]),
  month: Number(dateMatch[2]), // 1-12
  day: Number(dateMatch[3]),
  hour: Number(timeMatch[1]),
  minute: Number(timeMatch[2] ?? 0),
};
TARGET.monthName = MONTHS_FR[TARGET.month - 1];
TARGET.at = new Date(TARGET.year, TARGET.month - 1, TARGET.day, TARGET.hour, TARGET.minute, 0);
TARGET.iso = CFG.date;
TARGET.label = `${String(TARGET.day).padStart(2, "0")}/${String(TARGET.month).padStart(2, "0")}/${TARGET.year} `
  + `${String(TARGET.hour).padStart(2, "0")}h${String(TARGET.minute).padStart(2, "0")}`;

// Reconnaît « 20:00 », « 20h », « 20 h 00 », « 20H00 »… mais pas un « 20 » isolé
// (qui serait un numéro de jour dans le calendrier).
const TIME_RE_SRC = CFG.timeRegex
  ?? `(?:^|[^\\d])${TARGET.hour}\\s*[hH:.]\\s*(?:${String(TARGET.minute).padStart(2, "0")})?(?![\\d])`;

// ------------------------------------------------------------------- utilitaires

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleString("fr-FR", { hour12: false });
const norm = (s) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

fs.mkdirSync(CFG.outDir, { recursive: true });
const LOG_FILE = path.join(CFG.outDir, "runs.log");

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* pas bloquant */
  }
}

async function notify(title, body) {
  process.stdout.write("\x07\x07\x07"); // bip terminal
  const cmd = process.platform === "darwin"
    ? ["osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]]
    : process.platform === "linux"
    ? ["notify-send", [title, body]]
    : null;
  if (cmd) {
    try {
      const child = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
      child.on("error", () => {}); // notify-send/osascript absent : on n'interrompt rien
      child.unref();
    } catch {
      /* best effort */
    }
  }
  if (CFG.webhook) {
    // ntfy attend du texte brut + des en-têtes ; Slack/Discord/n8n attendent du JSON.
    const isNtfy = CFG.webhookFormat
      ? CFG.webhookFormat === "ntfy"
      : /(^|\/\/|\.)ntfy\.(sh|io)\//.test(CFG.webhook);
    const init = isNtfy
      ? {
        method: "POST",
        // Les en-têtes HTTP doivent rester en ASCII : on retire les accents du titre.
        headers: { Title: norm(title).toUpperCase(), Priority: "urgent", Tags: "tada", Click: CFG.url },
        body, // l'URL est déjà portée par l'en-tête Click (notification cliquable)
      }
      : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${title} — ${body}`, content: `${title} — ${body}`, title, body }),
      };
    try {
      const res = await fetch(CFG.webhook, init);
      if (!res.ok) log(`Webhook : réponse ${res.status}`);
    } catch (e) {
      log(`Webhook KO : ${e.message}`);
    }
  }
}

/** Exécute `fn` sur la frame principale puis sur chaque iframe, renvoie le 1er résultat non vide. */
async function inFrames(page, fn) {
  for (const frame of page.frames()) {
    try {
      const result = await fn(frame);
      if (result) return { frame, result };
    } catch {
      /* frame détachée / cross-origin non scriptable */
    }
  }
  return null;
}

// ------------------------------------------------------------- bannière cookies

async function dismissCookieBanner(page) {
  const labels = [
    "Tout accepter",
    "Tout accepter et fermer",
    "Accepter tout",
    "J'accepte",
    "Accepter",
    "OK pour moi",
    "Accept all",
    "Accepter et continuer",
  ];
  for (const frame of page.frames()) {
    for (const label of labels) {
      try {
        const btn = frame.getByRole("button", { name: new RegExp(`^\\s*${label}\\s*$`, "i") }).first();
        if (await btn.isVisible({ timeout: 400 })) {
          await btn.click({ timeout: 2000 });
          await sleep(600);
          return true;
        }
      } catch {
        /* pas de bannière ici */
      }
    }
  }
  return false;
}

// ------------------------------------------------------------ sélection de date

/** Essaie de positionner le widget sur la date cible. Renvoie une description de ce qui a été fait. */
async function selectDate(page) {
  // 1) input[type=date] natif
  const nativeInput = await inFrames(page, async (frame) => {
    const el = frame.locator('input[type="date"]').first();
    return (await el.count()) > 0 && (await el.isVisible().catch(() => false)) ? el : null;
  });
  if (nativeInput) {
    await nativeInput.result.fill(TARGET.iso);
    await nativeInput.result.dispatchEvent("change").catch(() => {});
    await sleep(1500);
    return "input[type=date]";
  }

  // 2) calendrier : on navigue jusqu'au bon mois puis on clique le jour
  const wanted = `${norm(TARGET.monthName)} ${TARGET.year}`;
  for (let hop = 0; hop < 18; hop++) {
    const header = await inFrames(page, async (frame) => {
      return await frame.evaluate(() => {
        const sel =
          '[class*="month" i],[class*="mois" i],[class*="datepicker" i] .switch,caption,h1,h2,h3,h4,[class*="calendar" i] [class*="title" i],[class*="header" i]';
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.innerText || "").trim();
          if (t && t.length < 40 && /\d{4}/.test(t)) return t;
        }
        return null;
      });
    });

    const headerText = header?.result ? norm(header.result) : null;
    if (!headerText) break; // pas de calendrier détecté : on sort et on cherche les créneaux tels quels
    if (headerText.includes(norm(TARGET.monthName)) && headerText.includes(String(TARGET.year))) break;

    const advanced = await inFrames(page, async (frame) => {
      const candidates = [
        '[aria-label*="suivant" i]',
        '[aria-label*="next" i]',
        '[title*="suivant" i]',
        '[class*="next" i]',
        '[class*="suivant" i]',
        '[class*="arrow-right" i]',
      ];
      for (const sel of candidates) {
        const el = frame.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          await el.click({ timeout: 3000 });
          return sel;
        }
      }
      return null;
    });
    if (!advanced) break;
    await sleep(900);
    if (hop === 17) log("Navigation calendrier : limite de 18 mois atteinte.");
  }

  // clic sur le jour
  const clicked = await inFrames(page, async (frame) => {
    return await frame.evaluate((day) => {
      const bad = /disab|unavail|indispo|complet|full|sold|old|new|outside|other|muted|passe/i;
      const nodes = document.querySelectorAll(
        'td,button,a,li,span,div[role="button"],[class*="day" i],[class*="jour" i]',
      );
      for (const el of nodes) {
        if (el.querySelectorAll("*").length > 2) continue;
        const t = (el.innerText || "").trim();
        if (t !== String(day)) continue;
        const cls = `${el.className || ""} ${el.parentElement?.className || ""}`;
        if (bad.test(cls) || el.getAttribute("aria-disabled") === "true" || el.disabled) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      }
      return false;
    }, TARGET.day);
  });

  await sleep(1800);
  return clicked ? `calendrier → jour ${TARGET.day}` : "date non sélectionnable (widget déjà positionné ?)";
}

// ------------------------------------------------------- détection des créneaux

const MARK_ATTR = "data-meg-slot";

/** Marque dans le DOM les éléments qui ressemblent à un créneau horaire et renvoie leur état. */
async function collectSlots(frame, reSource, onlyTarget) {
  return await frame.evaluate(
    ({ reSource, onlyTarget, attr }) => {
      const re = new RegExp(reSource, "i");
      const anyTime = /(?:^|[^\d])([01]?\d|2[0-3])\s*[hH:.]\s*([0-5]\d)?(?![\d])/;
      const bad = /disab|unavail|indispo|complet|full|sold|booked|reserved|passe|closed|ferme/i;

      for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);

      const out = [];
      const nodes = document.querySelectorAll(
        'button,a,li,td,label,span,div,input[type="radio"],input[type="button"]',
      );
      for (const el of nodes) {
        if (el.querySelectorAll("*").length > 6) continue; // on veut la feuille, pas le conteneur
        const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        if (!text || text.length > 60) continue;
        const matcher = onlyTarget ? re : anyTime;
        if (!matcher.test(text)) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        // dédoublonnage : si le parent a déjà été retenu au même endroit, on garde l'enfant
        const idx = out.length;
        el.setAttribute(attr, String(idx));

        const style = getComputedStyle(el);
        const parent = el.parentElement;
        // Contexte affiché dans les rapports : large, purement informatif.
        const ctxEl = el.closest("li,td,div,article,section") || el;
        const ctx = (ctxEl.innerText || "").trim().slice(0, 160);
        // Contexte utilisé pour DÉCIDER : uniquement l'élément et, s'il est petit,
        // son parent direct. Sinon un « complet » sur un créneau voisin ferait
        // passer le créneau cible pour indisponible.
        const nearText = parent && parent.querySelectorAll("*").length <= 4
          ? (parent.innerText || "").trim()
          : text;
        const cls = `${el.className || ""} ${parent?.className || ""}`;

        const unavailable = Boolean(el.disabled)
          || el.getAttribute("aria-disabled") === "true"
          || el.classList.contains("disabled")
          || bad.test(cls)
          || bad.test(text)
          || bad.test(nearText)
          || style.pointerEvents === "none"
          || Number(style.opacity) < 0.5;

        out.push({
          index: idx,
          text,
          context: ctx.replace(/\s+/g, " "),
          className: (el.className || "").toString().slice(0, 120),
          tag: el.tagName.toLowerCase(),
          available: !unavailable,
          reason: unavailable ? "marqué indisponible (classe/texte/état)" : "cliquable",
        });
      }
      return out;
    },
    { reSource, onlyTarget, attr: MARK_ATTR },
  );
}

/** Cherche le créneau cible dans toutes les frames. */
async function findTargetSlot(page) {
  for (const frame of page.frames()) {
    let slots;
    try {
      slots = await collectSlots(frame, TIME_RE_SRC, true);
    } catch {
      continue;
    }
    if (!slots.length) continue;
    const available = slots.find((s) => s.available);
    return { frame, slots, slot: available ?? slots[0] };
  }
  return null;
}

// ------------------------------------------------------------------- navigation

async function openBookingPage(browser) {
  const context = await browser.newContext({
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(CFG.timeoutMs);
  await page.goto(CFG.url, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: CFG.timeoutMs }).catch(() => {});
  await dismissCookieBanner(page);
  await sleep(1200);

  for (const label of CFG.preClick) {
    const hit = await inFrames(page, async (frame) => {
      const el = frame.getByText(new RegExp(label, "i")).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 4000 });
        return true;
      }
      return null;
    });
    log(hit ? `Pré-clic « ${label} » : ok` : `Pré-clic « ${label} » : introuvable`);
    await sleep(1200);
  }

  return { context, page };
}

// ---------------------------------------------------------------- mode --inspect

async function runInspect(browser) {
  const { context, page } = await openBookingPage(browser);
  await selectDate(page).then((how) => log(`Sélection de date : ${how}`));

  const report = [];
  for (const frame of page.frames()) {
    let slots = [];
    try {
      slots = await collectSlots(frame, TIME_RE_SRC, false);
    } catch {
      continue;
    }
    if (!slots.length) continue;
    report.push({ frameUrl: frame.url(), slots });
  }

  const shot = path.join(CFG.outDir, "inspect.png");
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(CFG.outDir, "inspect.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(CFG.outDir, "inspect.html"), await page.content());

  console.log("\n=== Frames et créneaux détectés ===");
  if (!report.length) console.log("Aucun élément horaire trouvé. Regarde inspect.png / inspect.html.");
  for (const f of report) {
    console.log(`\n--- ${f.frameUrl}`);
    for (const s of f.slots) {
      console.log(
        `  [${s.available ? "LIBRE  " : "PRIS   "}] <${s.tag}> "${s.text}"  class="${s.className}"\n`
          + `             contexte: ${s.context.slice(0, 100)}`,
      );
    }
  }
  console.log(`\nCapture : ${shot}\nDétail  : ${path.join(CFG.outDir, "inspect.json")}`);
  console.log(
    `\nSi le créneau ${TARGET.hour}h n'apparaît pas correctement, relance avec\n`
      + `  --time-regex '<ta regex>'   ou   --slot-selector '<ton sélecteur CSS>'\n`,
  );

  if (!CFG.headless) {
    console.log("Navigateur laissé ouvert — Ctrl+C pour quitter.");
    await new Promise(() => {});
  }
  await context.close();
}

// --------------------------------------------------------------- vérification

/**
 * Une passe : ouvre la page, va sur la date, cherche le créneau.
 * @returns {{status:'available'|'taken'|'not-found', detail:string, page?:object, context?:object, hit?:object}}
 */
async function checkOnce(browser) {
  const { context, page } = await openBookingPage(browser);
  const how = await selectDate(page);
  log(`Sélection de date (${TARGET.iso}) : ${how}`);

  if (CFG.slotSelector) {
    const custom = await inFrames(page, async (frame) => {
      const el = frame.locator(CFG.slotSelector).first();
      if ((await el.count()) === 0) return null;
      const disabled = await el.isDisabled().catch(() => false);
      const visible = await el.isVisible().catch(() => false);
      return { el, ok: visible && !disabled };
    });
    if (custom) {
      return custom.result.ok
        ? { status: "available", detail: `sélecteur ${CFG.slotSelector}`, page, context, hit: { frame: custom.frame, locator: custom.result.el } }
        : { status: "taken", detail: `sélecteur ${CFG.slotSelector} désactivé`, page, context };
    }
    return { status: "not-found", detail: `sélecteur ${CFG.slotSelector} absent`, page, context };
  }

  const found = await findTargetSlot(page);
  if (!found) {
    return { status: "not-found", detail: `aucun élément « ${CFG.time} » sur la page`, page, context };
  }
  const { frame, slot, slots } = found;
  const detail = `${slots.length} élément(s) « ${CFG.time} » — retenu : <${slot.tag}> "${slot.text}" (${slot.reason})`;
  if (!slot.available) return { status: "taken", detail, page, context };

  return {
    status: "available",
    detail,
    page,
    context,
    hit: { frame, locator: frame.locator(`[${MARK_ATTR}="${slot.index}"]`) },
  };
}

/** Première (et unique) étape : clic sur le créneau, capture, alerte. On ne va pas plus loin. */
async function doFirstStep(result) {
  const { page, hit } = result;
  log("Créneau libre → première étape de réservation (clic sur le créneau).");
  await hit.locator.scrollIntoViewIfNeeded().catch(() => {});
  await hit.locator.click({ timeout: 10000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await sleep(2500);

  if (CFG.nextLabel) {
    const next = await inFrames(page, async (frame) => {
      const el = frame.getByRole("button", { name: new RegExp(CFG.nextLabel, "i") }).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 8000 });
        return true;
      }
      return null;
    });
    log(next ? `Bouton « ${CFG.nextLabel} » cliqué.` : `Bouton « ${CFG.nextLabel} » introuvable.`);
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await sleep(2000);
  }

  const shot = path.join(CFG.outDir, `etape1-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  log(`Capture de l'étape 1 : ${shot}`);
  log(`URL atteinte : ${page.url()}`);
  await notify(
    "Créneau disponible !",
    `${TARGET.label} — première étape effectuée, à toi de finaliser dans le navigateur.`,
  );
  return shot;
}

// ------------------------------------------------------------------------ main

async function main() {
  log(`Cible : ${CFG.url}`);
  log(`Créneau surveillé : ${TARGET.label}  (regex horaire : /${TIME_RE_SRC}/i)`);
  log(
    CFG.inspect
      ? "Mode --inspect : diagnostic du widget, aucune réservation."
      : CFG.once
      ? "Mode --once : une seule vérification."
      : `Intervalle : ${CFG.intervalSec}s (± ${CFG.jitterSec}s)`,
  );
  if (!CFG.firstStep) log("Mode surveillance seule (--no-first-step) : aucun clic de réservation.");

  const browser = await chromium.launch({
    headless: CFG.headless,
    ...(CFG.browserPath ? { executablePath: CFG.browserPath } : {}),
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const shutdown = async () => {
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (CFG.inspect) {
    await runInspect(browser);
    await browser.close();
    return;
  }

  let checks = 0;
  for (;;) {
    checks++;
    if (CFG.stopAfterStart && new Date() > TARGET.at) {
      log(`Le créneau ${TARGET.label} est passé — arrêt de la surveillance.`);
      await browser.close();
      process.exit(EXIT.PAST); // distinct de « libre » : indispensable en mode cron
    }

    let result;
    try {
      result = await checkOnce(browser);
      log(`Vérification #${checks} → ${result.status.toUpperCase()} : ${result.detail}`);
    } catch (e) {
      log(`Vérification #${checks} → ERREUR : ${e.message}`);
    }

    if (result?.status === "available") {
      if (CFG.firstStep) {
        try {
          await doFirstStep(result);
          log("Terminé. Le navigateur reste ouvert : finalise la réservation à la main.");
          if (!CFG.headless) {
            await new Promise(() => {}); // on ne ferme pas, l'utilisateur reprend la main
          }
          await browser.close();
          process.exit(EXIT.AVAILABLE);
        } catch (e) {
          log(`Échec du clic sur le créneau : ${e.message} — nouvelle tentative au prochain cycle.`);
        }
      } else {
        await notify("Créneau disponible !", `${TARGET.label} est libre sur ${CFG.url}`);
        if (CFG.once) {
          await result.context?.close();
          await browser.close();
          process.exit(EXIT.AVAILABLE);
        }
      }
    }

    await result?.context?.close().catch(() => {});

    if (CFG.once) {
      await browser.close();
      process.exit(
        result?.status === "available"
          ? EXIT.AVAILABLE
          : result?.status === "taken"
          ? EXIT.TAKEN
          : EXIT.BROKEN, // not-found / exception : la détection est à revoir, pas « complet »
      );
    }
    if (CFG.maxChecks && checks >= CFG.maxChecks) {
      log(`Limite de ${CFG.maxChecks} vérifications atteinte — arrêt.`);
      break;
    }

    const wait = CFG.intervalSec * 1000 + Math.floor(Math.random() * CFG.jitterSec * 1000);
    log(`Prochaine vérification dans ${Math.round(wait / 1000)}s.`);
    await sleep(wait);
  }

  await browser.close();
}

await main();
