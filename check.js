import { chromium } from "playwright";

const URL = "https://www.cite-internationale-toulouse.fr/12849-demande-de-logement.htm";
const UNAVAILABLE_TEXT = "La résidence est actuellement complète pour les longs séjours.";

const CHECKIN_DATE = process.env.CHECKIN_DATE;
const CHECKOUT_DATE = process.env.CHECKOUT_DATE;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FORCE_TEST_ALERT = String(process.env.FORCE_TEST_ALERT || "").toLowerCase() === "true";

if (!CHECKIN_DATE || !CHECKOUT_DATE) {
  throw new Error("Missing CHECKIN_DATE or CHECKOUT_DATE");
}
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
}

async function sendTelegram(message) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram error: ${res.status} ${body}`);
  }
}

async function fillDateByLabel(page, labelText, value) {
  const strategies = [
    page.getByLabel(new RegExp(labelText, "i")),
    page.locator(`xpath=//label[contains(normalize-space(.), "${labelText}")]/following::input[1]`),
    page.locator(`input[placeholder*="${labelText}"]`)
  ];

  for (const locator of strategies) {
    try {
      if (await locator.count()) {
        const input = locator.first();
        await input.click({ force: true });
        await input.fill(value);
        return;
      }
    } catch {}
  }

  throw new Error(`Could not find input for label: ${labelText}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    await fillDateByLabel(page, "Date de début du séjour", CHECKIN_DATE);
    await fillDateByLabel(page, "Date de fin du séjour", CHECKOUT_DATE);

    const nextButton = page.getByRole("button", { name: /suivant/i });
    if (await nextButton.count()) {
      await nextButton.first().click();
    } else {
      const fallback = page.locator(`xpath=//button[contains(., "Suivant")] | //input[@type="submit" and contains(@value, "Suivant")]`);
      await fallback.first().click();
    }

    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const bodyText = await page.locator("body").innerText();

    const isUnavailable = bodyText.includes(UNAVAILABLE_TEXT);

    if (FORCE_TEST_ALERT) {
      await sendTelegram(
        `TEST ALERT ✅\n\n` +
        `The script ran correctly.\n` +
        `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
        `Current result: ${isUnavailable ? "still unavailable" : "availability may have changed"}\n` +
        `Page: ${URL}`
      );
      console.log("Test alert sent.");
      return;
    }

    if (!isUnavailable) {
      const shortText = bodyText.slice(0, 1200);
      await sendTelegram(
        `ALERT ✅ Housing result changed\n\n` +
        `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
        `Page: ${URL}\n\n` +
        `Preview:\n${shortText}`
      );
      console.log("Availability alert sent.");
    } else {
      console.log("Still unavailable.");
    }
  } catch (error) {
    console.error("Check failed:", error);
    throw error;
  } finally {
    await browser.close();
  }
}

main();
