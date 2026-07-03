chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "convert-currency",
    title: "Convert currency",
    contexts: ["selection"]
  });
});

function parseCurrency(text) {
  const t = text.toLowerCase();

  const map = {
    usd: ["$", "usd", "dollar", "dollars", "доллар", "доллара", "долларов"],
    eur: ["€", "eur", "euro", "euros", "евро"],
    gbp: ["£", "gbp", "pound", "pounds", "фунт", "фунта", "фунтов"],
    jpy: ["¥", "jpy", "yen", "иена", "иены", "иен"],
    rub: ["₽", "rub", "руб", "рубль", "рубля", "рублей"]
  };

  let currency = null;

  for (const [key, aliases] of Object.entries(map)) {
    if (aliases.some(a => t.includes(a))) {
      currency = key;
      break;
    }
  }

  const numberMatch = t.replace(",", ".").match(/[\d]+(\.[\d]+)?/);
  const value = numberMatch ? parseFloat(numberMatch[0]) : null;

  return { currency, value };
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "convert-currency") return;

  const parsed = parseCurrency(info.selectionText || "");

  // если в выделении вообще нет числа — конвертировать нечего
  if (parsed.value === null) return;

  // currency может быть null — тогда content.js подставит валюту по умолчанию
  // и даст выбрать её вручную (случай "выделена только сумма")
  chrome.tabs.sendMessage(tab.id, {
    type: "show-conversion",
    value: parsed.value,
    currency: parsed.currency
  });
});

// ---------- Источники курсов ----------

// ЦБ РФ: официальный XML, всегда котирует валюты относительно рубля.
// Внутри Service Worker (MV3) нет DOMParser, поэтому парсим вручную регуляркой —
// нас интересуют только CharCode / Nominal / Value, они всегда в ASCII,
// так что даже неверная декодировка кириллицы (windows-1251 vs utf-8) не мешает.
async function getCbrRate(from, to) {
  if (from === to) return 1;

  const res = await fetch("https://www.cbr.ru/scripts/XML_daily.asp");
  if (!res.ok) throw new Error("cbr http " + res.status);
  const xml = await res.text();

  const valueVsRub = (code) => {
    if (code === "RUB") return 1;
    const block = xml.split("<Valute ").find(b => b.includes(`<CharCode>${code}</CharCode>`));
    if (!block) return null;
    const nominalMatch = block.match(/<Nominal>(\d+)<\/Nominal>/);
    const valueMatch = block.match(/<Value>([\d.,]+)<\/Value>/);
    if (!nominalMatch || !valueMatch) return null;
    const nominal = parseFloat(nominalMatch[1]);
    const value = parseFloat(valueMatch[1].replace(",", "."));
    return value / nominal; // курс за 1 единицу валюты в рублях
  };

  const rubPerFrom = valueVsRub(from);
  const rubPerTo = valueVsRub(to);
  if (!rubPerFrom || !rubPerTo) return null;

  return rubPerFrom / rubPerTo;
}

// open.er-api.com — свободный бесплатный API, отдаёт таблицу курсов
// для указанной базовой валюты.
async function getOpenErApiRate(from, to) {
  if (from === to) return 1;

  const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
  if (!res.ok) throw new Error("open-er-api http " + res.status);
  const data = await res.json();

  if (!data || !data.rates || !data.rates[to]) return null;
  return data.rates[to];
}

// @fawazahmed0/currency-api — открытый датасет, раздаётся через jsDelivr CDN,
// без ключей и лимитов, обновляется раз в сутки.
async function getFawazahmed0Rate(from, to) {
  if (from === to) return 1;

  const base = from.toLowerCase();
  const target = to.toLowerCase();

  const res = await fetch(
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.json`
  );
  if (!res.ok) throw new Error("fawazahmed0 http " + res.status);
  const data = await res.json();

  if (!data || !data[base] || !data[base][target]) return null;
  return data[base][target];
}

const RATE_PROVIDERS = {
  cbr: getCbrRate,
  "open-er-api": getOpenErApiRate,
  fawazahmed0: getFawazahmed0Rate
};

// content.js спрашивает курс через сообщение, т.к. только у background.js
// (service worker) есть host_permissions на нужные домены.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "get-rate") return;

  const provider = RATE_PROVIDERS[msg.source];
  if (!provider) {
    sendResponse({ rate: null, error: "unknown source" });
    return;
  }

  provider(msg.from, msg.to)
    .then(rate => sendResponse({ rate }))
    .catch(e => {
      console.error("Ошибка получения курса:", e);
      sendResponse({ rate: null, error: String(e) });
    });

  return true; // держим канал открытым для асинхронного ответа
});