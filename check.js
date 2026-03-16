import { chromium } from "playwright";
import fs from "fs/promises";

const URL = "https://www.cite-internationale-toulouse.fr/12849-demande-de-logement.htm";
const FULL_MESSAGE = "La résidence est actuellement complète pour les longs séjours.";

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

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram error: ${res.status} ${body}`);
  }
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
        await input.type(value, { delay: 50 });
        return;
      }
    } catch {}
  }

  throw new Error(`Could not find field for: ${labelText}`);
}

async function clickSuivant(page) {
  const locators = [
    page.getByRole("button", { name: /suivant/i }),
    page.locator(`xpath=//button[contains(normalize-space(.), "Suivant")]`),
    page.locator(`xpath=//input[@type="submit" and contains(@value, "Suivant")]`),
    page.locator("text=Suivant")
  ];

  for (const locator of locators) {
    try {
      if (await locator.count()) {
        await locator.first().click({ force: true });
        return;
      }
    } catch {}
  }

  throw new Error('Could not find "Suivant" button');
}

async function runCheck() {
  const browser = await chromium.launch({
    headless: true
  });

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
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);

    await fillDateField(page, "Date de début du séjour", CHECKIN_DATE);
    await fillDateField(page, "Date de fin du séjour", CHECKOUT_DATE);

    await page.waitForTimeout(800);
    await clickSuivant(page);

    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const bodyText = await page.locator("body").innerText();
    const normalized = bodyText.replace(/\s+/g, " ").trim();
    const hasFullMessage = normalized.includes(FULL_MESSAGE);

    return {
      changed: !hasFullMessage,
      preview: normalized.slice(0, 1500)
    };
  } catch (err) {
    try {
      await page.screenshot({ path: "debug.png", fullPage: true });
      const html = await page.content();
      await fs.writeFile("debug.html", html, "utf8");
    } catch {}
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await runCheck();

      if (result.changed) {
        await sendTelegram(
          `ALERT ✅ Result changed\n\n` +
          `The usual message was NOT found:\n` +
          `"${FULL_MESSAGE}"\n\n` +
          `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
          `Page: ${URL}\n\n` +
          `Preview:\n${result.preview}`
        );
        console.log("Alert sent.");
      } else {
        console.log("No alert: usual full message still present.");
      }

      return;
    } catch (err) {
      lastError = err;
      console.error(`Attempt ${attempt} failed:`, err.message);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  await sendTelegram(
    `WARNING ⚠️ Housing bot failed after 3 attempts.\n\n` +
    `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
    `Error: ${lastError?.message || "Unknown error"}`
  );

  throw lastError;
}

main();
