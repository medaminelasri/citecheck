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
      text: message,
      disable_web_page_preview: true
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
        await input.type(value, { delay: 40 });
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
    page.locator("text=Suivant")
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

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function pageLooksAvailable(bodyText) {
  const requiredMarkers = [
    "Réserver",
    "Nom *",
    "Prénom *",
    "Date de naissance *",
    "Email *",
    "ENVOYER MA DEMANDE"
  ];

  return requiredMarkers.every(marker => bodyText.includes(marker));
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

    await page.waitForTimeout(800);
    await clickSuivant(page);

    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    const bodyTextRaw = await page.locator("body").innerText();
    const bodyText = normalizeText(bodyTextRaw);

    const hasFullMessage = bodyText.includes(FULL_MESSAGE);
    const hasReservationForm = pageLooksAvailable(bodyText);
    const hasDateOk = currentUrl.includes("date_ok=1");

    return {
      currentUrl,
      hasFullMessage,
      hasReservationForm,
      hasDateOk,
      preview: bodyText.slice(0, 1500)
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await checkOnce();

      if (result.hasFullMessage) {
        console.log("No alert: unavailable message still present.");
        return;
      }

      if (result.hasReservationForm && result.hasDateOk) {
        await sendTelegram(
          `ALERT ✅ Reservation form detected\n\n` +
          `The page looks AVAILABLE for these dates:\n` +
          `${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n\n` +
          `URL:\n${result.currentUrl}\n\n` +
          `Detected markers:\n` +
          `- Réserver\n` +
          `- Nom *\n` +
          `- Prénom *\n` +
          `- Date de naissance *\n` +
          `- Email *\n` +
          `- ENVOYER MA DEMANDE`
        );

        console.log("Alert sent: reservation form detected.");
        return;
      }

      console.log("No alert: page changed, but real reservation form was not detected.");
      console.log(result.preview);
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
