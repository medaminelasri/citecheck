import { chromium } from "playwright";
import fs from "fs";

const URL = "https://www.cite-internationale-toulouse.fr/12849-demande-de-logement.htm";
const FULL_MESSAGE = "La résidence est actuellement complète pour les longs séjours.";
const STATE_FILE = "state.json";
const DAY_MS = 24 * 60 * 60 * 1000;

const CHECKIN_DATE = process.env.CHECKIN_DATE;
const CHECKOUT_DATE = process.env.CHECKOUT_DATE;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!CHECKIN_DATE || !CHECKOUT_DATE) {
  throw new Error("Missing CHECKIN_DATE or CHECKOUT_DATE");
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
}

async function sendTelegram(message) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram error: ${response.status} ${body}`);
  }
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      lastStatus: "unknown",
      lastAvailabilityAt: null,
      lastNoAvailabilityReportAt: null
    };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fillDateField(page, labelText, value) {
  const locators = [
    page.getByLabel(new RegExp(labelText, "i")),
    page.locator(`xpath=//label[contains(normalize-space(.), "${labelText}")]/following::input[1]`),
    page.locator(`xpath=//input[contains(@placeholder, "${labelText}")]`)
  ];

  for (const locator of locators) {
    try {
      if (await locator.count()) {
        const input = locator.first();
        await input.click({ force: true });
        await input.fill("");
        await input.type(value, { delay: 40 });
        await input.press("Tab").catch(() => {});
        return;
      }
    } catch {}
  }

  throw new Error(`Could not find field for: ${labelText}`);
}

async function clickSuivant(page) {
  const buttonLocators = [
    page.getByRole("button", { name: /suivant/i }),
    page.locator(`xpath=//button[contains(normalize-space(.), "Suivant")]`),
    page.locator(`xpath=//input[@type="submit" and contains(@value, "Suivant")]`),
    page.locator("text=Suivant")
  ];

  for (const locator of buttonLocators) {
    try {
      if (await locator.count()) {
        await locator.first().click({ force: true });
        return;
      }
    } catch {}
  }

  throw new Error('Could not find the "Suivant" button');
}

async function detectResult(page) {
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const currentUrl = page.url();

  const hasFullMessage = bodyText.includes(FULL_MESSAGE);
  const hasDateOk = currentUrl.includes("date_ok=1");
  const hasTypeLogement = bodyText.includes("Type de logement");
  const selectCount = await page.locator("select").count().catch(() => 0);

  const isAvailable = hasDateOk && hasTypeLogement && selectCount >= 1;
  const isUnavailable = hasFullMessage;

  return {
    currentUrl,
    isAvailable,
    isUnavailable,
    hasDateOk,
    hasTypeLogement,
    selectCount
  };
}

async function waitForStableResult(page) {
  const timeoutMs = 45000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await detectResult(page);

    if (result.isAvailable || result.isUnavailable) {
      return result;
    }

    await page.waitForTimeout(1500);
  }

  return await detectResult(page);
}

async function checkOnce() {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    locale: "fr-FR",
    timezoneId: "Europe/Paris"
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(1500);

    await fillDateField(page, "Date de début du séjour", CHECKIN_DATE);
    await fillDateField(page, "Date de fin du séjour", CHECKOUT_DATE);

    await page.waitForTimeout(1200);
    await clickSuivant(page);

    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    return await waitForStableResult(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  console.log("GitHub event:", process.env.GITHUB_EVENT_NAME);
  const state = readState();
  const now = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await checkOnce();

      console.log("Final URL:", result.currentUrl);
      console.log("isAvailable:", result.isAvailable);
      console.log("isUnavailable:", result.isUnavailable);
      console.log("hasDateOk:", result.hasDateOk);
      console.log("hasTypeLogement:", result.hasTypeLogement);
      console.log("selectCount:", result.selectCount);

      if (result.isAvailable) {
        if (state.lastStatus !== "available") {
          await sendTelegram(
            `ALERT ✅ Housing available\n\n` +
            `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
            `URL: ${result.currentUrl}`
          );
          console.log("Availability alert sent.");
        } else {
          console.log("Availability still present, no duplicate alert.");
        }

        state.lastStatus = "available";
        state.lastAvailabilityAt = new Date(now).toISOString();
        writeState(state);
        return;
      }

      if (result.isUnavailable) {
        state.lastStatus = "unavailable";

        const hadAvailabilityInLast24h =
          state.lastAvailabilityAt &&
          now - new Date(state.lastAvailabilityAt).getTime() < DAY_MS;

        const shouldSendDailyNoAvailability =
          !hadAvailabilityInLast24h &&
          (
            !state.lastNoAvailabilityReportAt ||
            now - new Date(state.lastNoAvailabilityReportAt).getTime() >= DAY_MS
          );

        if (shouldSendDailyNoAvailability) {
          await sendTelegram(
            `INFO ℹ️ No availability in the last 24 hours\n\n` +
            `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}`
          );
          state.lastNoAvailabilityReportAt = new Date(now).toISOString();
          console.log("24h no-availability message sent.");
        } else {
          console.log("No daily no-availability message needed.");
        }

        writeState(state);
        return;
      }

      console.log("No alert: page was neither clearly available nor clearly unavailable.");
      return;
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed:`, error.message);

      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  await sendTelegram(
    `WARNING ⚠️ Cite Internationale bot failed after 3 attempts.\n\n` +
    `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
    `Error: ${lastError?.message || "Unknown error"}`
  );

  throw lastError;
}

main();
