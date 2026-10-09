import { invoke } from "@tauri-apps/api/tauri";

const DEFAULT_SERVICE_ENDPOINT = "http://localhost:11434/v1";
const DEFAULT_MODEL_NAME = "qwen2.5:7b-instruct";

const demoEntries = [
  {
    sourceLang: "en",
    aliases: ["prototype"],
    translation: "原型；样机",
    explanationZh: "常见语义是“可快速验证想法的初版”。适合产品、设计和开发阶段讨论。",
  },
  {
    sourceLang: "zh",
    aliases: ["原型"],
    translation: "prototype",
    explanationZh: "常见语义是“可快速验证想法的初版”。适合产品、设计和开发阶段讨论。",
  },
  {
    sourceLang: "en",
    aliases: ["iteration"],
    translation: "迭代",
    explanationZh: "在产品和开发场景里常指“循环改进、逐步优化”的过程。",
  },
  {
    sourceLang: "zh",
    aliases: ["迭代"],
    translation: "iteration",
    explanationZh: "在产品和开发场景里常指“循环改进、逐步优化”的过程。",
  },
  {
    sourceLang: "en",
    aliases: ["trade-off", "tradeoff"],
    translation: "权衡；取舍",
    explanationZh: "通常用于表达为了得到某项收益而必须接受另一项代价。",
  },
  {
    sourceLang: "zh",
    aliases: ["权衡"],
    translation: "trade-off",
    explanationZh: "通常用于表达为了得到某项收益而必须接受另一项代价。",
  },
  {
    sourceLang: "en",
    aliases: ["lightweight"],
    translation: "轻量化",
    explanationZh: "常用来形容体积小、启动快、操作简单的产品方案。",
  },
  {
    sourceLang: "zh",
    aliases: ["轻量化"],
    translation: "lightweight",
    explanationZh: "常用来形容体积小、启动快、操作简单的产品方案。",
  },
];

const elements = {
  form: document.getElementById("searchForm"),
  input: document.getElementById("queryInput"),
  resultState: document.getElementById("resultState"),
  resultView: document.getElementById("resultView"),
  loadingState: document.getElementById("loadingState"),
  errorState: document.getElementById("errorState"),
  translationText: document.getElementById("translationText"),
  errorTitle: document.getElementById("errorTitle"),
  errorMessage: document.getElementById("errorMessage"),
  testBtn: document.getElementById("testBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  serviceEndpoint:
    document.getElementById("serviceEndpoint") ?? document.getElementById("localEndpoint"),
  modelName: document.getElementById("modelName"),
  apiKey: document.getElementById("apiKey"),
  modeBadge: document.getElementById("modeBadge"),
  providerText: document.getElementById("providerText"),
  settingsHelperText: document.getElementById("settingsHelperText"),
  providerTabs: [...document.querySelectorAll(".tab")],
  homePage: document.getElementById("homePage"),
  flashcardsPage: document.getElementById("flashcardsPage"),
  flashcardsBtn: document.getElementById("flashcardsBtn"),
  backHomeBtn: document.getElementById("backHomeBtn"),
  flashcardCountBadge: document.getElementById("flashcardCountBadge"),
  flashcardsHelperText: document.getElementById("flashcardsHelperText"),
  flashcardEmptyState: document.getElementById("flashcardEmptyState"),
  flashcardCard: document.getElementById("flashcardCard"),
  flashcardSourceBadge: document.getElementById("flashcardSourceBadge"),
  flashcardProgressText: document.getElementById("flashcardProgressText"),
  flashcardFaceLabel: document.getElementById("flashcardFaceLabel"),
  flashcardFrontText: document.getElementById("flashcardFrontText"),
  flashcardBackText: document.getElementById("flashcardBackText"),
  flashcardTranslationText: document.getElementById("flashcardTranslationText"),
  flashcardReviewCountText: document.getElementById("flashcardReviewCountText"),
  flashcardUpdatedText: document.getElementById("flashcardUpdatedText"),
  flashcardList: document.getElementById("flashcardList"),
  prevFlashcardBtn: document.getElementById("prevFlashcardBtn"),
  flipFlashcardBtn: document.getElementById("flipFlashcardBtn"),
  nextFlashcardBtn: document.getElementById("nextFlashcardBtn"),
};

const SETTINGS_STORAGE_KEY = "dictionary-lib.settings";
const FLASHCARDS_STORAGE_KEY = "dictionary-lib.flashcards";
const defaultSettings = {
  provider: "local",
  serviceEndpoint: DEFAULT_SERVICE_ENDPOINT,
  modelName: DEFAULT_MODEL_NAME,
  apiKey: "",
};

const state = {
  provider: defaultSettings.provider,
  view: "home",
  runtime: {
    isTauri: false,
  },
  flashcards: {
    cards: [],
    currentCardId: null,
    isFlipped: false,
  },
};

function readBrowserSettings() {
  const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

  if (!stored) {
    return { ...defaultSettings };
  }

  try {
    const parsed = JSON.parse(stored);

    const serviceEndpoint =
      typeof parsed.serviceEndpoint === "string" && parsed.serviceEndpoint.trim()
        ? parsed.serviceEndpoint.trim()
        : typeof parsed.localEndpoint === "string" && parsed.localEndpoint.trim()
          ? parsed.localEndpoint.trim()
          : defaultSettings.serviceEndpoint;

    return {
      provider: parsed.provider === "api" ? "api" : "local",
      serviceEndpoint,
      modelName:
        typeof parsed.modelName === "string" && parsed.modelName.trim()
          ? parsed.modelName.trim()
          : defaultSettings.modelName,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
    };
  } catch (error) {
    console.warn("读取已保存设置失败，使用默认配置。", error);
    return { ...defaultSettings };
  }
}

function writeBrowserSettings(settings) {
  const payload = {
    provider: settings.provider,
    serviceEndpoint: settings.serviceEndpoint.trim(),
    localEndpoint: settings.localEndpoint?.trim() || settings.serviceEndpoint.trim(),
    modelName: settings.modelName.trim(),
    apiKey: settings.apiKey.trim(),
  };

  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
}

function updateRuntimeBadge() {
  if (!elements.modeBadge) {
    return;
  }

  elements.modeBadge.textContent = state.runtime.isTauri ? "Tauri 桌面模式" : "浏览器预览";
  elements.modeBadge.style.borderColor = state.runtime.isTauri
    ? "rgba(52, 211, 153, 0.35)"
    : "rgba(148, 163, 184, 0.18)";
}

function readBrowserFlashcards() {
  const stored = window.localStorage.getItem(FLASHCARDS_STORAGE_KEY);

  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((card) => card && typeof card === "object")
      .map((card) => ({
        id: typeof card.id === "string" && card.id ? card.id : crypto.randomUUID(),
        query: typeof card.query === "string" ? card.query : "",
        sourceLang: card.sourceLang === "zh" ? "zh" : "en",
        translation: typeof card.translation === "string" ? card.translation : "",
        explanationZh: typeof card.explanationZh === "string" ? card.explanationZh : "",
        reviewCount: Number.isFinite(Number(card.reviewCount)) ? Number(card.reviewCount) : 1,
        createdAt: typeof card.createdAt === "string" ? card.createdAt : new Date().toISOString(),
        updatedAt: typeof card.updatedAt === "string" ? card.updatedAt : new Date().toISOString(),
      }))
      .filter((card) => card.query && card.translation);
  } catch (error) {
    console.warn("读取闪卡数据失败，使用空资料库。", error);
    return [];
  }
}

function writeBrowserFlashcards(cards) {
  window.localStorage.setItem(FLASHCARDS_STORAGE_KEY, JSON.stringify(cards));
}

async function loadPersistedState() {
  if (!state.runtime.isTauri) {
    return {
      settings: readBrowserSettings(),
      flashcards: readBrowserFlashcards(),
    };
  }

  return invoke("initialize_persistence", {
    legacy: {
      settings: readBrowserSettings(),
      flashcards: readBrowserFlashcards(),
    },
  });
}

async function persistSettings(settings) {
  if (!state.runtime.isTauri) {
    writeBrowserSettings(settings);
    return settings;
  }

  return invoke("save_settings", { settings });
}

async function persistFlashcard(card) {
  if (!state.runtime.isTauri) {
    const nextCards = getFlashcardsStateCards();
    const existingIndex = nextCards.findIndex((item) => item.id === card.id);

    if (existingIndex >= 0) {
      nextCards[existingIndex] = card;
    } else {
      nextCards.unshift(card);
    }

    state.flashcards.cards = nextCards;
    writeBrowserFlashcards(nextCards);
    return card;
  }

  return invoke("upsert_flashcard", { card });
}

function mergeFlashcardRecord(card) {
  const cards = getFlashcardsStateCards();
  const existingIndex = cards.findIndex((item) => item.id === card.id);

  if (existingIndex >= 0) {
    cards[existingIndex] = card;
  } else {
    cards.unshift(card);
  }

  state.flashcards.cards = cards;
  renderFlashcardsButtonLabel();
}

function normalizeCardKey(query, sourceLang) {
  return `${sourceLang}:${normalize(query)}`;
}

function sortFlashcards(cards) {
  return [...cards].sort((left, right) => {
    const leftTime = new Date(left.updatedAt).getTime();
    const rightTime = new Date(right.updatedAt).getTime();
    return rightTime - leftTime;
  });
}

function formatFlashcardTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function getFlashcardsStateCards() {
  return sortFlashcards(state.flashcards.cards);
}

function getCurrentFlashcardIndex(cards = getFlashcardsStateCards()) {
  if (cards.length === 0) {
    return -1;
  }

  const currentIndex = cards.findIndex((card) => card.id === state.flashcards.currentCardId);
  return currentIndex >= 0 ? currentIndex : 0;
}

function getCurrentFlashcard(cards = getFlashcardsStateCards()) {
  const index = getCurrentFlashcardIndex(cards);
  return index >= 0 ? cards[index] : null;
}

function persistFlashcards(cards) {
  state.flashcards.cards = cards;
  writeBrowserFlashcards(cards);
}

function selectFlashcardByIndex(index) {
  const cards = getFlashcardsStateCards();

  if (cards.length === 0) {
    state.flashcards.currentCardId = null;
    state.flashcards.isFlipped = false;
    renderFlashcardsPage();
    return;
  }

  const resolvedIndex = (index + cards.length) % cards.length;
  state.flashcards.currentCardId = cards[resolvedIndex].id;
  state.flashcards.isFlipped = false;
  renderFlashcardsPage();
}

async function rememberFlashcard({ query, sourceLang, translation, explanationZh }) {
  const existingCards = getFlashcardsStateCards();
  const now = new Date().toISOString();
  const normalizedSourceLang = sourceLang === "zh" ? "zh" : "en";
  const existingIndex = existingCards.findIndex(
    (card) => normalizeCardKey(card.query, card.sourceLang) === normalizeCardKey(query, normalizedSourceLang),
  );
  const nextCard = {
    id: existingIndex >= 0 ? existingCards[existingIndex].id : `${normalizedSourceLang}:${normalize(query)}`,
    query,
    sourceLang: normalizedSourceLang,
    translation,
    explanationZh: explanationZh ?? "",
    reviewCount: existingIndex >= 0 ? existingCards[existingIndex].reviewCount + 1 : 1,
    createdAt: existingIndex >= 0 ? existingCards[existingIndex].createdAt : now,
    updatedAt: now,
  };

  if (state.runtime.isTauri) {
    const savedCard = await persistFlashcard({
      query,
      sourceLang: normalizedSourceLang,
      translation,
      explanationZh: explanationZh ?? "",
    });
    mergeFlashcardRecord(savedCard);
    state.flashcards.currentCardId = savedCard.id;
  } else {
    const nextCards = existingIndex >= 0
      ? existingCards.map((card, index) => (index === existingIndex ? nextCard : card))
      : [nextCard, ...existingCards];

    state.flashcards.cards = nextCards;
    writeBrowserFlashcards(nextCards);
    state.flashcards.currentCardId = nextCard.id;
  }

  state.flashcards.isFlipped = false;
  renderFlashcardsPage();
}

function setView(view) {
  state.view = view;
  elements.homePage.classList.toggle("hidden", view !== "home");
  elements.flashcardsPage.classList.toggle("hidden", view !== "flashcards");
  elements.flashcardsPage.setAttribute("aria-hidden", String(view !== "flashcards"));
  if (view === "flashcards") {
    renderFlashcardsPage();
  }
}

function renderFlashcardsButtonLabel() {
  if (!elements.flashcardsBtn || !elements.flashcardCountBadge) {
    return;
  }

  const count = getFlashcardsStateCards().length;
  elements.flashcardsBtn.textContent = count > 0 ? `闪卡（${count}）` : "闪卡";
  elements.flashcardCountBadge.textContent = `${count} 张卡片`;
}

function renderFlashcardsPage() {
  const cards = getFlashcardsStateCards();
  renderFlashcardsButtonLabel();

  if (!cards.length) {
    elements.flashcardEmptyState.classList.remove("hidden");
    elements.flashcardCard.classList.add("hidden");
    elements.flashcardList.innerHTML = "";
    elements.flashcardsHelperText.textContent = "先去查几个词，系统会把结果自动收进闪卡资料库。";
    return;
  }

  const currentCard = getCurrentFlashcard(cards) ?? cards[0];
  state.flashcards.currentCardId = currentCard.id;

  elements.flashcardEmptyState.classList.add("hidden");
  elements.flashcardCard.classList.remove("hidden");
  elements.flashcardsHelperText.textContent = "点卡片正面翻看释义，日常查词结果会自动沉淀到这里。";

  elements.flashcardSourceBadge.textContent = currentCard.sourceLang === "zh" ? "中文 → 英文" : "英文 → 中文";
  elements.flashcardProgressText.textContent = `${cards.findIndex((card) => card.id === currentCard.id) + 1} / ${cards.length}`;
  elements.flashcardFaceLabel.textContent = state.flashcards.isFlipped ? "背面" : "正面";
  elements.flashcardFrontText.textContent = currentCard.query;
  elements.flashcardBackText.textContent = currentCard.translation;
  elements.flashcardBackText.classList.toggle("hidden", !state.flashcards.isFlipped);
  elements.flashcardFrontText.classList.toggle("hidden", state.flashcards.isFlipped);
  elements.flashcardTranslationText.textContent = currentCard.translation;
  elements.flashcardReviewCountText.textContent = String(currentCard.reviewCount);
  elements.flashcardUpdatedText.textContent = formatFlashcardTime(currentCard.updatedAt);

  elements.flashcardList.innerHTML = cards
    .map((card, index) => {
      const active = card.id === currentCard.id ? "active" : "";
      return `
        <button type="button" class="flashcard-list-item ${active}" data-card-id="${card.id}">
          <strong>${escapeHtml(card.query)}</strong>
          <span>${escapeHtml(card.translation)}</span>
          <span>${index + 1} · ${card.sourceLang === "zh" ? "中文" : "英文"} · ${card.reviewCount} 次复习</span>
        </button>
      `;
    })
    .join("");

  elements.flashcardList.querySelectorAll(".flashcard-list-item").forEach((button) => {
    button.addEventListener("click", () => {
      const nextIndex = cards.findIndex((card) => card.id === button.dataset.cardId);
      if (nextIndex >= 0) {
        state.flashcards.currentCardId = cards[nextIndex].id;
        state.flashcards.isFlipped = false;
        renderFlashcardsPage();
      }
    });
  });
}

function detectLanguage(text) {
  const chineseCount = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const latinCount = text.match(/[A-Za-z]/g)?.length ?? 0;

  if (chineseCount === 0 && latinCount === 0) {
    return "en";
  }

  return chineseCount >= latinCount ? "zh" : "en";
}

function normalize(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s·,.;:'"“”"()（）【】\[\]{}!?！？/\\-]/g, "");
}

function findDemoEntry(query, sourceLang) {
  const normalized = normalize(query);

  return demoEntries.find(
    (entry) =>
      entry.sourceLang === sourceLang &&
      entry.aliases.some((alias) => normalize(alias) === normalized),
  );
}

function setVisible(activeKey) {
  const map = {
    empty: elements.resultState,
    loading: elements.loadingState,
    success: elements.resultView,
    error: elements.errorState,
  };

  Object.values(map).forEach((node) => node.classList.add("hidden"));
  map[activeKey].classList.remove("hidden");
}

function renderBadge(text, tone = "") {
  if (!elements.modeBadge) {
    return;
  }

  elements.modeBadge.textContent = text;
  elements.modeBadge.style.borderColor =
    tone === "error"
      ? "rgba(248, 113, 113, 0.35)"
      : tone === "success"
        ? "rgba(52, 211, 153, 0.32)"
        : "rgba(148, 163, 184, 0.18)";
}

function renderProviderLabel() {
  if (elements.providerText) {
    elements.providerText.textContent =
      state.provider === "local" ? "本地大模型" : "第三方 API Key";
  }
}

function updateSettingsHelperText() {
  if (!elements.settingsHelperText) {
    return;
  }

  elements.settingsHelperText.textContent =
    state.provider === "local"
      ? "本地模式会调用你填写的 OpenAI 兼容服务地址，系统会自动补全 /v1；模型名称请手动填写。连通性测试不验证模型生成能力。快捷键为 Ctrl / ⌘ + K。"
      : "API Key 模式会把同一服务地址作为云端模型入口，系统会自动补全 /v1；模型名称请手动填写。连通性测试不验证模型生成能力。快捷键为 Ctrl / ⌘ + K。";
}

function updateSettingsPanel(open) {
  elements.settingsPanel.classList.toggle("hidden", !open);
  elements.settingsPanel.setAttribute("aria-hidden", String(!open));
}

function getModeConfig() {
  const serviceEndpoint = elements.serviceEndpoint.value.trim();
  const modelName = elements.modelName.value.trim() || DEFAULT_MODEL_NAME;
  const apiKey = elements.apiKey.value.trim();
  const missing = [];

  if (!serviceEndpoint) {
    missing.push("模型服务地址");
  }

  if (state.provider === "api" && !apiKey) {
    missing.push("API Key");
  }

  return {
    provider: state.provider,
    serviceEndpoint,
    modelName,
    apiKey,
    missing,
  };
}

function buildOfflineResult(query) {
  const language = detectLanguage(query);
  const entry = findDemoEntry(query, language);

  if (entry) {
    return {
      translation: entry.translation,
      sourceLang: language,
      explanationZh: entry.explanationZh,
      badge: "命中示例词条",
      tone: "success",
    };
  }

  if (language === "en") {
    return {
      translation: `${query}（中文释义）`,
      sourceLang: language,
      explanationZh: "",
      badge: "离线演示",
      tone: "",
    };
  }

  return {
    translation: `${query} (English)`,
    sourceLang: language,
    explanationZh: "",
    badge: "离线演示",
    tone: "",
  };
}

async function requestDesktopTranslation(query) {
  const config = getModeConfig();

  return invoke("translate_text", {
    request: {
      query,
      provider: config.provider,
      serviceEndpoint: config.serviceEndpoint,
      modelName: config.modelName,
      apiKey: config.apiKey,
    },
  });
}

function applyPersistedState(snapshot) {
  const settings = snapshot.settings ?? readBrowserSettings();

  elements.serviceEndpoint.value = settings.serviceEndpoint?.trim() || DEFAULT_SERVICE_ENDPOINT;
  elements.modelName.value = settings.modelName?.trim() || DEFAULT_MODEL_NAME;
  elements.apiKey.value = settings.apiKey?.trim() || "";
  setProvider(settings.provider ?? "local", { persist: false });
  state.flashcards.cards = snapshot.flashcards ?? [];
  renderFlashcardsButtonLabel();
  renderFlashcardsPage();
}

async function syncSavedSettings() {
  return persistSettings({
    provider: state.provider,
    serviceEndpoint: elements.serviceEndpoint.value.trim(),
    localEndpoint: elements.serviceEndpoint.value.trim(),
    modelName: elements.modelName.value.trim(),
    apiKey: elements.apiKey.value.trim(),
  });
}

function showError(title, message) {
  setVisible("error");
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  renderBadge("配置不足", "error");
}

function setProvider(provider, { persist = true } = {}) {
  state.provider = provider;

  elements.providerTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });

  if (elements.apiKey) {
    elements.apiKey.closest("label").style.opacity = provider === "local" ? "0.55" : "1";
  }

  renderProviderLabel();
  updateSettingsHelperText();

  if (persist) {
    void syncSavedSettings().catch((error) => {
      console.error("保存设置失败：", error);
    });
  }
}

async function runSearch(rawQuery) {
  const query = rawQuery.trim();

  if (!query) {
    setVisible("empty");
    renderBadge(state.runtime.isTauri ? "Tauri 桌面模式" : "浏览器预览");
    elements.input.focus();
    return;
  }

  const config = getModeConfig();

  if (config.missing.length > 0) {
    showError("配置需要补全", `请先补全：${config.missing.join("、")}。`);
    return;
  }

  setVisible("loading");
  renderBadge(state.runtime.isTauri ? "AI 处理中" : "离线演示");

  try {
    const result = state.runtime.isTauri
      ? await requestDesktopTranslation(query)
      : buildOfflineResult(query);

    elements.translationText.textContent = result.translation;
    await rememberFlashcard({
      query,
      sourceLang: result.sourceLang ?? detectLanguage(query),
      translation: result.translation,
      explanationZh: result.explanationZh ?? "",
    });

    setVisible("success");
    renderBadge(result.badge ?? "AI 已返回", result.tone ?? "success");
  } catch (error) {
    showError("查询失败", error instanceof Error ? error.message : String(error));
  }
}

async function testConnection() {
  const config = getModeConfig();

  if (config.missing.length > 0) {
    const message = `请先补全：${config.missing.join("、")}。`;
    elements.settingsHelperText.textContent = `连通性测试失败：${message}`;
    showError("连通性测试失败", message);
    return;
  }

  if (!state.runtime.isTauri) {
    setVisible("success");
    elements.translationText.textContent = "浏览器预览模式";
    elements.settingsHelperText.textContent = "当前仅启用离线演示结果；切换到 Tauri 桌面模式后即可测试真实 AI 服务。";
    renderBadge("浏览器预览", "");
    return;
  }

  setVisible("loading");
  renderBadge("测试连接");
  elements.settingsHelperText.textContent = "正在测试服务连通性，不验证模型生成能力。";

  try {
    await invoke("test_connection", {
      request: {
        query: "connection test",
        provider: config.provider,
        serviceEndpoint: config.serviceEndpoint,
        modelName: config.modelName,
        apiKey: config.apiKey,
      },
    });
    setVisible("success");
    elements.translationText.textContent = "连接正常";
    elements.settingsHelperText.textContent = `连接正常：已连通 ${config.serviceEndpoint}，系统会自动补全 /v1。本次仅测试服务连通性，不验证模型生成能力。`;
    renderBadge("AI 已连接", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.settingsHelperText.textContent = `连通性测试失败：${message}`;
    showError("连通性测试失败", message);
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch(elements.input.value);
});

elements.providerTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setProvider(tab.dataset.provider);
  });
});

elements.testBtn.addEventListener("click", testConnection);
elements.settingsBtn.addEventListener("click", () => {
  updateSettingsPanel(true);
});

elements.flashcardsBtn.addEventListener("click", () => {
  setView("flashcards");
});

elements.backHomeBtn.addEventListener("click", () => {
  setView("home");
  window.setTimeout(() => {
    elements.input.focus();
  }, 50);
});

elements.closeSettingsBtn.addEventListener("click", () => {
  updateSettingsPanel(false);
});

elements.prevFlashcardBtn.addEventListener("click", () => {
  const cards = getFlashcardsStateCards();
  const index = getCurrentFlashcardIndex(cards);
  if (index >= 0) {
    selectFlashcardByIndex(index - 1);
  }
});

elements.flipFlashcardBtn.addEventListener("click", () => {
  state.flashcards.isFlipped = !state.flashcards.isFlipped;
  renderFlashcardsPage();
});

elements.flashcardCard.addEventListener("click", () => {
  state.flashcards.isFlipped = !state.flashcards.isFlipped;
  renderFlashcardsPage();
});

elements.nextFlashcardBtn.addEventListener("click", () => {
  const cards = getFlashcardsStateCards();
  const index = getCurrentFlashcardIndex(cards);
  if (index >= 0) {
    selectFlashcardByIndex(index + 1);
  }
});

elements.input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.input.focus();
    elements.input.select();
  }
});

[elements.serviceEndpoint, elements.modelName, elements.apiKey].forEach((field) => {
  field.addEventListener("input", () => {
    void syncSavedSettings().catch((error) => {
      console.error("保存设置失败：", error);
    });
  });
});

document.addEventListener("keydown", (event) => {
  if (state.view === "flashcards" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      state.flashcards.isFlipped = !state.flashcards.isFlipped;
      renderFlashcardsPage();
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const cards = getFlashcardsStateCards();
      const index = getCurrentFlashcardIndex(cards);
      if (index >= 0) {
        selectFlashcardByIndex(index - 1);
      }
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      const cards = getFlashcardsStateCards();
      const index = getCurrentFlashcardIndex(cards);
      if (index >= 0) {
        selectFlashcardByIndex(index + 1);
      }
      return;
    }
  }

  if (event.key === "Escape") {
    updateSettingsPanel(false);
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.input.focus();
    elements.input.select();
  }
});

function setupDesktopRuntime() {
  state.runtime.isTauri = Boolean(window.__TAURI__);
  updateRuntimeBadge();
}

async function bootstrap() {
  setupDesktopRuntime();
  const snapshot = await loadPersistedState();
  applyPersistedState(snapshot);
  setVisible("empty");
  updateSettingsPanel(false);
  updateSettingsHelperText();
  renderFlashcardsButtonLabel();
  setView("home");

  window.setTimeout(() => {
    elements.input.focus();
  }, 50);
}

bootstrap();
