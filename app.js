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
  explanationText: document.getElementById("explanationText"),
  errorTitle: document.getElementById("errorTitle"),
  errorMessage: document.getElementById("errorMessage"),
  testBtn: document.getElementById("testBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  serviceEndpoint:
    document.getElementById("serviceEndpoint") ?? document.getElementById("localEndpoint"),
  modelNameSelect:
    document.getElementById("modelNameSelect") ?? document.getElementById("modelName"),
  apiKey: document.getElementById("apiKey"),
  refreshModelsBtn: document.getElementById("refreshModelsBtn"),
  modelStatusText: document.getElementById("modelStatusText"),
  modeBadge: document.getElementById("modeBadge"),
  providerText: document.getElementById("providerText"),
  settingsHelperText: document.getElementById("settingsHelperText"),
  providerTabs: [...document.querySelectorAll(".tab")],
};

const SETTINGS_STORAGE_KEY = "dictionary-lib.settings";
const defaultSettings = {
  provider: "local",
  serviceEndpoint: DEFAULT_SERVICE_ENDPOINT,
  modelName: DEFAULT_MODEL_NAME,
  apiKey: "",
};

const state = {
  provider: defaultSettings.provider,
  runtime: {
    isTauri: false,
  },
  modelLoadRequestId: 0,
};

function readSavedSettings() {
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

function writeSavedSettings() {
  const payload = {
    provider: state.provider,
    serviceEndpoint: elements.serviceEndpoint.value.trim(),
    localEndpoint: elements.serviceEndpoint.value.trim(),
    modelName: elements.modelNameSelect.value.trim(),
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
      ? "本地模式会调用你填写的 OpenAI 兼容服务地址，系统会自动补全 /v1，并拉取真实可用模型。快捷键为 Ctrl / ⌘ + K。"
      : "API Key 模式会把同一服务地址作为云端模型入口，系统会自动补全 /v1，并拉取真实可用模型。快捷键为 Ctrl / ⌘ + K。";
}

function updateSettingsPanel(open) {
  elements.settingsPanel.classList.toggle("hidden", !open);
  elements.settingsPanel.setAttribute("aria-hidden", String(!open));
}

function getModeConfig() {
  const serviceEndpoint = elements.serviceEndpoint.value.trim();
  const modelName = elements.modelNameSelect.value.trim() || DEFAULT_MODEL_NAME;
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

function updateModelStatus(message, tone = "") {
  if (!elements.modelStatusText) {
    return;
  }

  elements.modelStatusText.textContent = message;
  elements.modelStatusText.dataset.tone = tone;
}

function renderModelOptions(models, selectedModel) {
  const select = elements.modelNameSelect;
  const normalizedSelected = selectedModel.trim();
  const uniqueModels = [...new Set(models.map((item) => item.trim()).filter(Boolean))];

  select.replaceChildren();

  if (uniqueModels.length === 0) {
    const placeholder = document.createElement("option");
    placeholder.value = normalizedSelected || DEFAULT_MODEL_NAME;
    placeholder.textContent = "暂无可用模型";
    placeholder.selected = true;
    select.append(placeholder);
    select.disabled = true;
    return;
  }

  const values = [...uniqueModels];

  if (normalizedSelected && !values.includes(normalizedSelected)) {
    values.unshift(normalizedSelected);
  }

  values.forEach((model) => {
    const option = document.createElement("option");
    option.value = model;
    option.textContent =
      model === normalizedSelected && !uniqueModels.includes(normalizedSelected)
        ? `${model}（当前已保存）`
        : model;
    select.append(option);
  });

  select.disabled = false;
  select.value = normalizedSelected || values[0];
}

function buildOfflineResult(query) {
  const language = detectLanguage(query);
  const entry = findDemoEntry(query, language);

  if (entry) {
    return {
      translation: entry.translation,
      explanationZh: entry.explanationZh,
      badge: "命中示例词条",
      tone: "success",
    };
  }

  if (language === "en") {
    return {
      translation: `${query}（中文释义）`,
      explanationZh: "离线演示模式下，英文输入会优先给出中文释义，便于快速查词。",
      badge: "离线演示",
      tone: "",
    };
  }

  return {
    translation: `${query} (English)`,
    explanationZh: "离线演示模式下，中文输入会优先给出英文释义，便于快速查词。",
    badge: "离线演示",
    tone: "",
  };
}

async function loadAvailableModels({ force = false } = {}) {
  if (!state.runtime.isTauri) {
    const savedModel = readSavedSettings().modelName || DEFAULT_MODEL_NAME;
    renderModelOptions([savedModel], savedModel);
    updateModelStatus("浏览器预览仅保留当前模型值；切换到桌面模式后可拉取真实模型列表。", "");
    return;
  }

  const requestId = ++state.modelLoadRequestId;
  const selectedModel = elements.modelNameSelect.value.trim() || readSavedSettings().modelName || DEFAULT_MODEL_NAME;

  if (!force && elements.modelStatusText?.dataset.tone === "loading") {
    return;
  }

  updateModelStatus("正在拉取真实可用模型列表...", "loading");
  if (elements.refreshModelsBtn) {
    elements.refreshModelsBtn.disabled = true;
  }

  try {
    const config = getModeConfig();
    const models = await invoke("list_models", {
      request: {
        query: "",
        provider: config.provider,
        serviceEndpoint: config.serviceEndpoint,
        modelName: config.modelName,
        apiKey: config.apiKey,
      },
    });

    if (requestId !== state.modelLoadRequestId) {
      return;
    }

    renderModelOptions(models, selectedModel);

    if (models.includes(selectedModel)) {
      updateModelStatus(`已加载 ${models.length} 个可用模型。`, "success");
    } else {
      updateModelStatus(`已加载 ${models.length} 个可用模型；当前保存的模型不在列表中。`, "warning");
    }

    syncSavedSettings();
  } catch (error) {
    if (requestId !== state.modelLoadRequestId) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    updateModelStatus(`加载模型列表失败：${message}`, "error");

    if (!elements.modelNameSelect.options.length) {
      renderModelOptions([selectedModel], selectedModel);
    }
  } finally {
    if (requestId === state.modelLoadRequestId && elements.refreshModelsBtn) {
      elements.refreshModelsBtn.disabled = false;
    }
  }
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

function applySavedSettings() {
  const settings = readSavedSettings();

  elements.serviceEndpoint.value = settings.serviceEndpoint;
  elements.modelNameSelect.value = settings.modelName;
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
    syncSavedSettings();
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
    elements.explanationText.textContent = result.explanationZh ?? "";

    setVisible("success");
    renderBadge(result.badge ?? "AI 已返回", result.tone ?? "success");
  } catch (error) {
    showError("查询失败", error instanceof Error ? error.message : String(error));
  }
}

async function testConnection() {
  const config = getModeConfig();

  if (config.missing.length > 0) {
    showError("连通性测试失败", `请先补全：${config.missing.join("、")}。`);
    return;
  }

  if (!state.runtime.isTauri) {
    setVisible("success");
    elements.translationText.textContent = "浏览器预览模式";
    elements.explanationText.textContent = "当前仅启用离线演示结果；切换到 Tauri 桌面模式后即可测试真实 AI 服务。";
    renderBadge("浏览器预览", "");
    return;
  }

  setVisible("loading");
  renderBadge("测试连接");

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
    elements.explanationText.textContent = `已连通 ${config.serviceEndpoint}，系统会自动补全 /v1。`;
    renderBadge("AI 已连接", "success");
    updateModelStatus("连通性正常，模型列表可用。", "success");
  } catch (error) {
    showError("连通性测试失败", error instanceof Error ? error.message : String(error));
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch(elements.input.value);
});

elements.providerTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setProvider(tab.dataset.provider);
    void loadAvailableModels({ force: true });
  });
});

elements.testBtn.addEventListener("click", testConnection);
elements.refreshModelsBtn?.addEventListener("click", () => {
  void loadAvailableModels({ force: true });
});
elements.settingsBtn.addEventListener("click", () => {
  updateSettingsPanel(true);
  void loadAvailableModels();
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

[elements.serviceEndpoint, elements.modelNameSelect, elements.apiKey].forEach((field) => {
  field.addEventListener("input", syncSavedSettings);
});

[elements.serviceEndpoint, elements.apiKey].forEach((field) => {
  field.addEventListener("change", () => {
    if (state.runtime.isTauri && !elements.settingsPanel.classList.contains("hidden")) {
      void loadAvailableModels({ force: true });
    }
  });
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
  state.runtime.isTauri = Boolean(window.__TAURI__);
  updateRuntimeBadge();
}

async function bootstrap() {
  applySavedSettings();
  setVisible("empty");
  updateSettingsPanel(false);
  updateRuntimeBadge();
  updateSettingsHelperText();
  await setupDesktopRuntime();
  void loadAvailableModels();

  window.setTimeout(() => {
    elements.input.focus();
  }, 50);
}

bootstrap();
