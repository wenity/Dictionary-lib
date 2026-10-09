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
    aliases: ["trade-off"],
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
  explanationText: document.getElementById("explanationText"),
  errorTitle: document.getElementById("errorTitle"),
  errorMessage: document.getElementById("errorMessage"),
  testBtn: document.getElementById("testBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  localEndpoint: document.getElementById("localEndpoint"),
  modelName: document.getElementById("modelName"),
  apiKey: document.getElementById("apiKey"),
  modeBadge: document.getElementById("modeBadge"),
  providerText: document.getElementById("providerText"),
  providerTabs: [...document.querySelectorAll(".tab")],
};

const SETTINGS_STORAGE_KEY = "dictionary-lib.settings";
const defaultSettings = {
  provider: "local",
  localEndpoint: "http://localhost:11434/v1",
  modelName: "qwen2.5:7b-instruct",
  apiKey: "",
};

const state = {
  provider: defaultSettings.provider,
  loadingTimer: null,
  lastQuery: "",
  runtime: {
    isTauri: false,
  },
};

function readSavedSettings() {
  const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

  if (!stored) {
    return { ...defaultSettings };
  }

  try {
    const parsed = JSON.parse(stored);

    return {
      provider: parsed.provider === "api" ? "api" : "local",
      localEndpoint:
        typeof parsed.localEndpoint === "string" && parsed.localEndpoint.trim()
          ? parsed.localEndpoint.trim()
          : defaultSettings.localEndpoint,
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

function writeSavedSettings() {
  const payload = {
    provider: state.provider,
    localEndpoint: elements.localEndpoint.value.trim(),
    modelName: elements.modelName.value.trim(),
    apiKey: elements.apiKey.value.trim(),
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

function detectLanguage(text) {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}

function normalize(text) {
  return text.trim().toLowerCase();
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

function updateSettingsPanel(open) {
  elements.settingsPanel.classList.toggle("hidden", !open);
  elements.settingsPanel.setAttribute("aria-hidden", String(!open));
}

function getModeConfig() {
  return state.provider === "local"
    ? {
        label: "本地大模型",
        required: elements.localEndpoint.value.trim(),
        detail: elements.modelName.value.trim(),
        missingMessage: "请先补全本地服务地址，才能模拟本地模型查询。",
      }
    : {
        label: "第三方 API Key",
        required: elements.apiKey.value.trim(),
        detail: "已启用外部服务商模式",
        missingMessage: "请先填写 API Key，才能模拟云端模型查询。",
      };
}

function buildMockResult(query) {
  const language = detectLanguage(query);
  const entry = findDemoEntry(query, language);

  if (entry) {
    return {
      language,
      translation: entry.translation,
      explanation: entry.explanationZh,
      quality: "已命中示例词条",
    };
  }

  if (language === "en") {
    return {
      language,
      translation: `${query}（中文释义）`,
      explanation: "简短说明：英文输入将自动输出中文释义，便于快速查词。",
      quality: "AI 模拟生成",
    };
  }

  return {
    language,
    translation: `${query} (English)`,
    explanation: "简短说明：中文输入将自动输出英文释义，便于快速查词。",
    quality: "AI 模拟生成",
  };
}

function applySavedSettings() {
  const settings = readSavedSettings();

  elements.localEndpoint.value = settings.localEndpoint;
  elements.modelName.value = settings.modelName;
  elements.apiKey.value = settings.apiKey;
  setProvider(settings.provider, { persist: false });
}

function syncSavedSettings() {
  writeSavedSettings();
}

function showError(title, message) {
  setVisible("error");
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  renderBadge("配置不足", "error");
}

function runSearch(rawQuery) {
  const query = rawQuery.trim();

  if (state.loadingTimer) {
    clearTimeout(state.loadingTimer);
    state.loadingTimer = null;
  }

  if (!query) {
    setVisible("empty");
    elements.input.focus();
    return;
  }

  const config = getModeConfig();

  if (!config.required) {
    showError("配置需要补全", config.missingMessage);
    return;
  }

  state.lastQuery = query;
  setVisible("loading");

  state.loadingTimer = window.setTimeout(() => {
    const result = buildMockResult(query);

    elements.translationText.textContent = result.translation;
    elements.explanationText.textContent = result.explanation;

    setVisible("success");
    state.loadingTimer = null;
  }, 760);
}

function setProvider(provider, { persist = true } = {}) {
  state.provider = provider;
  elements.providerTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });

  if (provider === "local") {
    elements.apiKey.closest("label").style.opacity = "0.55";
    elements.localEndpoint.closest("label").style.opacity = "1";
  } else {
    elements.apiKey.closest("label").style.opacity = "1";
    elements.localEndpoint.closest("label").style.opacity = "0.55";
  }
  renderProviderLabel();

  if (persist) {
    syncSavedSettings();
  }
}

function testConnection() {
  const config = getModeConfig();

  if (!config.required) {
    showError("连通性测试失败", config.missingMessage);
    return;
  }

  setVisible("loading");

  window.setTimeout(() => {
    elements.translationText.textContent = "连接正常";
    elements.explanationText.textContent = state.provider === "local"
      ? `已连接 ${elements.localEndpoint.value.trim()}，当前模型：${elements.modelName.value.trim()}。`
      : "API Key 已通过前端校验，后续可接入真实服务。";

    setVisible("success");
  }, 620);
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch(elements.input.value);
});

elements.providerTabs.forEach((tab) => {
  tab.addEventListener("click", () => setProvider(tab.dataset.provider));
});

elements.testBtn.addEventListener("click", testConnection);
elements.settingsBtn.addEventListener("click", () => {
  updateSettingsPanel(true);
});

elements.closeSettingsBtn.addEventListener("click", () => {
  updateSettingsPanel(false);
});

elements.input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.input.focus();
    elements.input.select();
  }
});

[elements.localEndpoint, elements.modelName, elements.apiKey].forEach((field) => {
  field.addEventListener("input", syncSavedSettings);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    updateSettingsPanel(false);
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.input.focus();
    elements.input.select();
  }
});

async function setupDesktopRuntime() {
  if (!window.__TAURI__) {
    state.runtime.isTauri = false;
    updateRuntimeBadge();
    return;
  }

  const [{ appWindow }, { isRegistered, register }] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/globalShortcut"),
  ]);

  state.runtime.isTauri = true;

  if (!(await isRegistered("CmdOrCtrl+K"))) {
    await register("CmdOrCtrl+K", async () => {
      if (!(await appWindow.isVisible())) {
        await appWindow.show();
      }

      if (await appWindow.isMinimized()) {
        await appWindow.unminimize();
      }

      await appWindow.setFocus();
      elements.input.focus();
      elements.input.select();
    });
  }

  updateRuntimeBadge();
}

async function bootstrap() {
  applySavedSettings();
  setVisible("empty");
  updateSettingsPanel(false);
  updateRuntimeBadge();
  await setupDesktopRuntime();

  window.setTimeout(() => {
    elements.input.focus();
  }, 50);
}

bootstrap();
