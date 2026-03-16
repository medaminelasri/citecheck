import { chromium } from "playwright";

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

async function sendTelegram(message) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram error: ${response.status} ${body}`);
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
      const count = await locator.count();
      if (count > 0) {
        const input = locator.first();
        await input.click({ force: true });
        await input.fill("");
        await input.fill(value);
        return;
      }
    } catch {
      // try next locator
    }
  }

  throw new Error(`Could not find field for: ${labelText}`);
}

async function clickSuivant(page) {
  const buttonLocators = [
    page.getByRole("button", { name: /suivant/i }),
    page.locator(`xpath=//button[contains(normalize-space(.), "Suivant")]`),
    page.locator(`xpath=//input[@type="submit" and contains(@value, "Suivant")]`),
    page.locator(`text=Suivant`)
  ];

  for (const locator of buttonLocators) {
    try {
      const count = await locator.count();
      if (count > 0) {
        await locator.first().click({ force: true });
        return;
      }
    } catch {
      // try next locator
    }
  }

  throw new Error('Could not find the "Suivant" button');
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await fillDateField(page, "Date de début du séjour", CHECKIN_DATE);
    await fillDateField(page, "Date de fin du séjour", CHECKOUT_DATE);

    await clickSuivant(page);

    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const bodyText = await page.locator("body").innerText();
    const hasFullMessage = bodyText.includes(FULL_MESSAGE);

    if (!hasFullMessage) {
      const preview = bodyText.replace(/\s+/g, " ").trim().slice(0, 1500);

      await sendTelegram(
        `ALERT ✅ Result changed\n\n` +
        `The usual message was NOT found:\n` +
        `"${FULL_MESSAGE}"\n\n` +
        `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
        `Page: ${URL}\n\n` +
        `Preview:\n${preview}`
      );

      console.log("Alert sent: result changed.");
    } else {
      console.log("No alert: usual full message still present.");
    }
  } catch (error) {
    console.error("Check failed:", error);
    throw error;
  } finally {
    await browser.close();
  }
}

main();
