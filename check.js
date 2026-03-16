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

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
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

async function main() {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    locale: "fr-FR",
    timezoneId: "Europe/Paris"
  });

  const page = await context.newPage();

  try {
    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(1500);

    await fillDateField(page, "Date de début du séjour", CHECKIN_DATE);
    await fillDateField(page, "Date de fin du séjour", CHECKOUT_DATE);

    await page.waitForTimeout(1000);
    await clickSuivant(page);

    await page.waitForTimeout(8000);

    const finalUrl = page.url();
    const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));

    const hasFullMessage = bodyText.includes(FULL_MESSAGE);
    const hasDateOk = finalUrl.includes("date_ok=1");

    const markers = {
      reserver: bodyText.includes("Réserver"),
      nom: bodyText.includes("Nom *"),
      prenom: bodyText.includes("Prénom *"),
      naissance: bodyText.includes("Date de naissance *"),
      email: bodyText.includes("Email *"),
      envoyer: bodyText.includes("ENVOYER MA DEMANDE")
    };

    const confirmedAvailable =
      hasDateOk &&
      markers.reserver &&
      markers.nom &&
      markers.prenom &&
      markers.naissance &&
      markers.email &&
      markers.envoyer;

    console.log("Final URL:", finalUrl);
    console.log("hasFullMessage:", hasFullMessage);
    console.log("hasDateOk:", hasDateOk);
    console.log("markers:", markers);
    console.log("Preview:", bodyText.slice(0, 1200));

    if (hasFullMessage) {
      console.log("No alert: unavailable message detected.");
      return;
    }

    if (confirmedAvailable) {
      await sendTelegram(
        `ALERT ✅ Reservation form detected\n\n` +
        `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
        `URL: ${finalUrl}`
      );
      console.log("Availability alert sent.");
      return;
    }

    await sendTelegram(
      `DEBUG ⚠️ Page changed but not confirmed\n\n` +
      `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
      `URL: ${finalUrl}\n` +
      `date_ok=1: ${hasDateOk}\n` +
      `Réserver: ${markers.reserver}\n` +
      `Nom *: ${markers.nom}\n` +
      `Prénom *: ${markers.prenom}\n` +
      `Date de naissance *: ${markers.naissance}\n` +
      `Email *: ${markers.email}\n` +
      `ENVOYER MA DEMANDE: ${markers.envoyer}\n\n` +
      `Preview:\n${bodyText.slice(0, 1000)}`
    );

    console.log("Debug message sent.");
  } catch (error) {
    console.error("Check failed:", error);
    await sendTelegram(
      `WARNING ⚠️ Bot error\n\n` +
      `Dates: ${CHECKIN_DATE} -> ${CHECKOUT_DATE}\n` +
      `Error: ${error.message}`
    );
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
