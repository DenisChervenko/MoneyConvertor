// ---------- Настройки ----------

const CURRENCIES = [
  { code: "RUB", label: "₽ RUB" },
  { code: "USD", label: "$ USD" },
  { code: "EUR", label: "€ EUR" },
  { code: "GBP", label: "£ GBP" },
  { code: "JPY", label: "¥ JPY" }
];

const RATE_SOURCES = [
  { id: "cbr", label: "ЦБ РФ" },
  { id: "open-er-api", label: "open.er-api.com" },
  { id: "fawazahmed0", label: "currency-api" }
];

const DEFAULT_SOURCE = "cbr";
const PINNED_SOURCE_KEY = "pinnedRateSource";

// ---------- Состояние ----------

let activeBox = null;
let activeBtn = null; // Хранит активную кнопку-иконку
let outsideClickHandler = null;
let requestToken = 0;
let state = null; // { amount, from, to, source, rate }
let pinnedSourceId = DEFAULT_SOURCE;
let els = {};

// ---------- Умное отслеживание выделения текста ----------

document.addEventListener("pointerup", () => {
  // Небольшая задержка, чтобы выделение успело сформироваться в DOM
  setTimeout(checkSelection, 10);
});

function checkSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    removeSelectionBtn();
    return;
  }

  const text = selection.toString().trim();
  if (!text) {
    removeSelectionBtn();
    return;
  }

  // Быстрая проверка: есть ли вообще числа в выделении
  const parsed = localParseCurrency(text);
  if (parsed.value === null) {
    removeSelectionBtn();
    return;
  }

  // Если окно конвертера уже открыто, кнопку рисовать не нужно
  if (activeBox) return;

  // Если кнопка уже есть, просто пересчитаем её координаты (на случай изменения выделения)
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  if (activeBtn) {
    positionElement(activeBtn, rect, 8, true);
    // Обновляем данные на кнопке, чтобы при клике открылось актуальное значение
    activeBtn._parsedData = parsed;
    activeBtn._rect = rect;
    return;
  }

  buildSelectionBtn(rect, parsed);
}

function localParseCurrency(text) {
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

function buildSelectionBtn(rect, parsed) {
  removeSelectionBtn();

  const btn = document.createElement("div");
  btn._parsedData = parsed;
  btn._rect = rect;

  // Стильный SVG в качестве иконки (круглая кнопка конвертации валют)
  btn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" fill="#1e222b"/>
      <path d="M16 12L13 9M16 12L13 15M16 12H8" stroke="#7db2ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8 12L11 9M8 12L11 15" stroke="#7db2ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5"/>
    </svg>
  `;

  Object.assign(btn.style, {
    position: "fixed",
    zIndex: "2147483646",
    cursor: "pointer",
    background: "#1e222b",
    border: "2px solid #3a4050",
    borderRadius: "50%",
    width: "30px",
    height: "30px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    transition: "transform 0.1s ease, background 0.1s ease",
    userSelect: "none"
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "scale(1.1)";
    btn.style.background = "#2a2f3a";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "scale(1)";
    btn.style.background = "#1e222b";
  });

  // Главное событие — клик по кнопке вызывает основное окно
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    
    const data = btn._parsedData;
    const savedRect = btn._rect;
    removeSelectionBtn();
    
    triggerConversion(data.value, data.currency, savedRect);
  });

  document.body.appendChild(btn);
  activeBtn = btn;
  positionElement(btn, rect, 8, true);
}

function removeSelectionBtn() {
  if (activeBtn) {
    activeBtn.remove();
    activeBtn = null;
  }
}

// ---------- Вход: сообщение от background.js ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "show-conversion") return;

  removeSelectionBtn();
  removeActiveBox();

  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  triggerConversion(msg.value, msg.currency, rect);
});

// Единая точка инициализации конверсии
function triggerConversion(value, currency, rect) {
  removeActiveBox();

  chrome.storage.local.get([PINNED_SOURCE_KEY], (res) => {
    pinnedSourceId =
      res && RATE_SOURCES.some((s) => s.id === res[PINNED_SOURCE_KEY])
        ? res[PINNED_SOURCE_KEY]
        : DEFAULT_SOURCE;

    const from = currency ? currency.toUpperCase() : "USD";

    state = {
      amount: typeof value === "number" ? value : 0,
      from,
      to: from === "RUB" ? "USD" : "RUB",
      source: pinnedSourceId,
      rate: null
    };

    buildBox(rect);
    refreshRate();
  });
}

// ---------- Построение окошка ----------

function buildBox(rect) {
  const box = document.createElement("div");

  Object.assign(box.style, {
    position: "fixed",
    left: "-9999px",
    top: "-9999px",
    background: "#1e222b",
    color: "#fff",
    padding: "14px",
    borderRadius: "12px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
    fontFamily: "-apple-system, Segoe UI, Roboto, Arial, sans-serif",
    fontSize: "13px",
    zIndex: "2147483647",
    opacity: "0",
    transform: "translateY(-6px)",
    transition: "opacity .15s ease, transform .15s ease",
    minWidth: "270px",
    boxSizing: "border-box"
  });

  // строка 1: сумма → валюта источника → валюта результата
  const row1 = document.createElement("div");
  Object.assign(row1.style, {
    display: "flex",
    gap: "6px",
    alignItems: "center",
    marginBottom: "10px"
  });

  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.step = "any";
  amountInput.value = String(state.amount);
  styleControl(amountInput, { width: "80px" });

  const fromSelect = buildCurrencySelect(state.from);
  const arrow = document.createElement("span");
  arrow.textContent = "→";
  arrow.style.opacity = "0.6";
  const toSelect = buildCurrencySelect(state.to);

  row1.append(amountInput, fromSelect, arrow, toSelect);

  // строка 2: результат
  const resultEl = document.createElement("div");
  Object.assign(resultEl.style, {
    fontSize: "20px",
    fontWeight: "700",
    color: "#7db2ff",
    margin: "4px 0 12px",
    minHeight: "26px"
  });
  resultEl.textContent = "…";

  // строка 3: источник курса + закрепить
  const row3 = document.createElement("div");
  Object.assign(row3.style, {
    display: "flex",
    gap: "6px",
    alignItems: "center"
  });

  const sourceLabel = document.createElement("span");
  sourceLabel.textContent = "Курс:";
  sourceLabel.style.opacity = "0.7";

  const sourceSelect = document.createElement("select");
  styleControl(sourceSelect, { flex: "1" });
  RATE_SOURCES.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === state.source) opt.selected = true;
    sourceSelect.appendChild(opt);
  });

  const pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.title = "Запомнить этот источник курса по умолчанию";
  styleControl(pinBtn, { cursor: "pointer", padding: "5px 8px" });

  row3.append(sourceLabel, sourceSelect, pinBtn);

  box.append(row1, resultEl, row3);
  document.body.appendChild(box);

  els = { box, amountInput, fromSelect, toSelect, resultEl, sourceSelect, pinBtn };
  activeBox = box;

  updatePinButton();
  positionElement(box, rect, 10, false);

  requestAnimationFrame(() => {
    box.style.opacity = "1";
    box.style.transform = "translateY(0)";
  });

  // --- обработчики ---

  amountInput.addEventListener("input", () => {
    const v = parseFloat(amountInput.value);
    state.amount = isNaN(v) ? 0 : v;
    renderResult();
  });

  fromSelect.addEventListener("change", () => {
    state.from = fromSelect.value;
    refreshRate();
  });

  toSelect.addEventListener("change", () => {
    state.to = toSelect.value;
    refreshRate();
  });

  sourceSelect.addEventListener("change", () => {
    state.source = sourceSelect.value;
    updatePinButton();
    refreshRate();
  });

  pinBtn.addEventListener("click", () => {
    pinnedSourceId = state.source;
    chrome.storage.local.set({ [PINNED_SOURCE_KEY]: pinnedSourceId });
    updatePinButton();
  });

  // закрытие по клику вне окошка
  outsideClickHandler = (e) => {
    if (!box.contains(e.target)) {
      removeActiveBox();
      // Дополнительно проверяем выделение, чтобы кнопка создалась/удалилась корректно
      setTimeout(checkSelection, 10);
    }
  };
  document.addEventListener("click", outsideClickHandler, true);
}

function styleControl(el, extra = {}) {
  Object.assign(
    el.style,
    {
      background: "#2a2f3a",
      color: "#fff",
      border: "1px solid #3a4050",
      borderRadius: "6px",
      padding: "5px 7px",
      fontSize: "13px",
      fontFamily: "inherit"
    },
    extra
  );
}

function buildCurrencySelect(selected) {
  const select = document.createElement("select");
  styleControl(select);
  CURRENCIES.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.code;
    opt.textContent = c.label;
    if (c.code === selected) opt.selected = true;
    select.appendChild(opt);
  });
  return select;
}

function updatePinButton() {
  if (!els.pinBtn) return;
  const isPinned = pinnedSourceId === state.source;
  els.pinBtn.textContent = isPinned ? "📌 Закреплено" : "📌 Закрепить";
  els.pinBtn.style.opacity = isPinned ? "1" : "0.7";
}

// Универсальная функция позиционирования для кнопки и основного окна
function positionElement(el, rect, margin = 10, isButton = false) {
  const elRect = el.getBoundingClientRect();

  let left;
  if (isButton) {
    // Кнопку ставим чуть правее центра или конца выделения, чтобы не перекрывать текст
    left = rect.right + 2;
  } else {
    // Окно центрируем по выделению
    left = rect.left + rect.width / 2 - elRect.width / 2;
  }
  
  left = Math.max(margin, Math.min(left, window.innerWidth - elRect.width - margin));

  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;

  let top;
  if (isButton) {
    // Кнопка обычно красиво смотрится чуть выше выделения
    top = rect.top - elRect.height - 4;
    if (top < margin) top = rect.bottom + 4;
  } else {
    if (spaceBelow >= elRect.height + margin || spaceBelow >= spaceAbove) {
      top = rect.bottom + margin;
    } else {
      top = rect.top - elRect.height - margin;
    }
  }
  top = Math.max(margin, top);

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function removeActiveBox() {
  requestToken++;
  if (activeBox) {
    activeBox.remove();
    activeBox = null;
  }
  if (outsideClickHandler) {
    document.removeEventListener("click", outsideClickHandler, true);
    outsideClickHandler = null;
  }
  els = {};
  state = null;
}

// ---------- Получение курса и отрисовка результата ----------

function refreshRate() {
  if (!state) return;

  if (state.from === state.to) {
    state.rate = 1;
    renderResult();
    return;
  }

  const token = ++requestToken;
  renderResult(true);

  chrome.runtime.sendMessage(
    { type: "get-rate", source: state.source, from: state.from, to: state.to },
    (response) => {
      if (token !== requestToken || !state) return;

      if (chrome.runtime.lastError || !response || !response.rate) {
        state.rate = null;
        renderResult(false, true);
        return;
      }

      state.rate = response.rate;
      renderResult();
    }
  );
}

function renderResult(loading = false, error = false) {
  if (!els.resultEl) return;

  if (loading) {
    els.resultEl.textContent = "Считаем…";
    return;
  }
  if (error || state.rate == null) {
    els.resultEl.textContent = "Курс недоступен";
    return;
  }

  const total = state.amount * state.rate;
  const currencyInfo = CURRENCIES.find((c) => c.code === state.to);
  const symbol = currencyInfo ? currencyInfo.label.split(" ")[0] : state.to;

  els.resultEl.textContent = `≈ ${formatNumber(total)} ${symbol}`;
}

function formatNumber(n) {
  return n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}