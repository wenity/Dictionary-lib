use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{GlobalShortcutManager, Manager, WindowEvent};

const DEFAULT_MODEL_NAME: &str = "qwen2.5:7b-instruct";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateRequest {
  query: String,
  provider: String,
  service_endpoint: String,
  model_name: String,
  api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslateResponse {
  translation: String,
  explanation_zh: String,
}

fn show_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_window("main") {
    window.show().expect("failed to show main window");
    window.unminimize().expect("failed to restore main window");
    window.set_focus().expect("failed to focus main window");
  }
}

fn detect_language(text: &str) -> &str {
  let chinese_count = text.chars().filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c)).count();
  let latin_count = text.chars().filter(|c| c.is_ascii_alphabetic()).count();

  if chinese_count == 0 && latin_count == 0 {
    "en"
  } else if chinese_count >= latin_count {
    "zh"
  } else {
    "en"
  }
}

fn build_prompt(query: &str, source_lang: &str) -> String {
  let direction = if source_lang == "zh" {
    "中文 -> 英文"
  } else {
    "英文 -> 中文"
  };

  format!(
    "You are a concise bilingual dictionary assistant.\n\
Input direction: {direction}.\n\
Return JSON only with exactly these keys: translation, explanationZh.\n\
translation must be the target-language output.\n\
explanationZh must be short Chinese, at most 2 sentences.\n\
If the input is ambiguous, choose the most common meaning.\n\
Input: {query}"
  )
}

fn normalize_base_endpoint(endpoint: &str) -> String {
  let trimmed = endpoint.trim().trim_end_matches('/');

  if trimmed.ends_with("/v1") {
    trimmed.to_string()
  } else {
    format!("{trimmed}/v1")
  }
}

fn build_models_url(endpoint: &str) -> String {
  format!("{}/models", normalize_base_endpoint(endpoint))
}

fn build_chat_completions_url(endpoint: &str) -> String {
  format!("{}/chat/completions", normalize_base_endpoint(endpoint))
}

fn strip_code_fence(text: &str) -> &str {
  let trimmed = text.trim();

  if !trimmed.starts_with("```") {
    return trimmed;
  }

  let without_open = trimmed
    .strip_prefix("```json")
    .or_else(|| trimmed.strip_prefix("```JSON"))
    .or_else(|| trimmed.strip_prefix("```"))
    .unwrap_or(trimmed);

  let without_open = without_open.trim_start_matches(['\r', '\n']);

  if let Some(end) = without_open.rfind("```") {
    &without_open[..end]
  } else {
    without_open
  }
}

fn extract_text_from_value(value: &Value) -> Option<String> {
  if let Some(text) = value.as_str() {
    return Some(text.trim().to_string());
  }

  if let Some(parts) = value.as_array() {
    let mut collected = String::new();

    for part in parts {
      if let Some(text) = part.get("text").and_then(Value::as_str) {
        collected.push_str(text);
      } else if let Some(text) = part.get("content").and_then(Value::as_str) {
        collected.push_str(text);
      }
    }

    let collected = collected.trim();
    if !collected.is_empty() {
      return Some(collected.to_string());
    }
  }

  None
}

fn extract_assistant_text(body: &Value) -> Option<String> {
  let candidates = [
    body.get("choices")
      .and_then(Value::as_array)
      .and_then(|choices| choices.first())
      .and_then(|choice| choice.get("message"))
      .and_then(|message| message.get("content")),
    body.get("output_text"),
    body.get("text"),
    body.get("response"),
    body.get("content"),
  ];

  for candidate in candidates.into_iter().flatten() {
    if let Some(text) = extract_text_from_value(candidate) {
      return Some(text);
    }
  }

  None
}

fn parse_translation_response(content: &str) -> Result<TranslateResponse, String> {
  let cleaned = strip_code_fence(content);

  if let Ok(value) = serde_json::from_str::<Value>(cleaned) {
    if let Some(translation) = value.get("translation").and_then(Value::as_str) {
      let explanation_zh = value
        .get("explanationZh")
        .or_else(|| value.get("explanation_zh"))
        .or_else(|| value.get("explanation"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

      return Ok(TranslateResponse {
        translation: translation.trim().to_string(),
        explanation_zh,
      });
    }
  }

  let lines: Vec<&str> = cleaned
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .collect();

  let Some(first_line) = lines.first() else {
    return Err("AI 返回内容为空。".to_string());
  };

  let translation = first_line
    .strip_prefix("translation:")
    .or_else(|| first_line.strip_prefix("Translation:"))
    .unwrap_or(first_line)
    .trim()
    .to_string();

  let explanation_zh = if lines.len() > 1 {
    lines[1..].join(" ")
  } else {
    String::new()
  };

  Ok(TranslateResponse {
    translation,
    explanation_zh,
  })
}

fn summarize_error_body(body: &str) -> String {
  let trimmed = body.trim();
  if trimmed.len() <= 180 {
    return trimmed.to_string();
  }

  format!("{}...", &trimmed[..180])
}

fn build_client() -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    .timeout(Duration::from_secs(30))
    .build()
    .map_err(|error| format!("初始化 AI 请求失败：{error}"))
}

fn build_headers(provider: &str, api_key: &str) -> Result<HeaderMap, String> {
  let mut headers = HeaderMap::new();
  headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

  if provider == "api" {
    let token = format!("Bearer {api_key}");
    headers.insert(
      AUTHORIZATION,
      HeaderValue::from_str(&token).map_err(|error| format!("API Key 格式无效：{error}"))?,
    );
  }

  Ok(headers)
}

async fn send_get_request(endpoint: &str, provider: &str, api_key: &str) -> Result<String, String> {
  let client = build_client()?;
  let headers = build_headers(provider, api_key)?;
  let response = client
    .get(build_models_url(endpoint))
    .headers(headers)
    .send()
    .await
    .map_err(|error| format!("请求 AI 服务失败：{error}"))?;

  let status = response.status();
  let body_text = response
    .text()
    .await
    .map_err(|error| format!("读取 AI 响应失败：{error}"))?;

  if !status.is_success() {
    return Err(format!(
      "AI 服务返回 {}：{}",
      status,
      summarize_error_body(&body_text)
    ));
  }

  Ok(body_text)
}

#[tauri::command]
async fn test_connection(request: TranslateRequest) -> Result<String, String> {
  let service_endpoint = request.service_endpoint.trim();
  if service_endpoint.is_empty() {
    return Err("请先补全模型服务地址。".to_string());
  }

  let api_key = request.api_key.trim();
  if request.provider == "api" && api_key.is_empty() {
    return Err("请先填写 API Key。".to_string());
  }

  if request.provider != "local" && request.provider != "api" {
    return Err("不支持的 AI 来源配置。".to_string());
  }

  let _ = send_get_request(service_endpoint, &request.provider, api_key).await?;
  Ok("连接正常".to_string())
}

#[tauri::command]
async fn translate_text(request: TranslateRequest) -> Result<TranslateResponse, String> {
  let service_endpoint = request.service_endpoint.trim();
  if service_endpoint.is_empty() {
    return Err("请先补全模型服务地址。".to_string());
  }

  let model_name = if request.model_name.trim().is_empty() {
    DEFAULT_MODEL_NAME.to_string()
  } else {
    request.model_name.trim().to_string()
  };

  let api_key = request.api_key.trim();
  if request.provider == "api" && api_key.is_empty() {
    return Err("请先填写 API Key。".to_string());
  }

  if request.provider != "local" && request.provider != "api" {
    return Err("不支持的 AI 来源配置。".to_string());
  }

  let source_lang = detect_language(&request.query);
  let prompt = build_prompt(&request.query, source_lang);
  let client = build_client()?;
  let headers = build_headers(&request.provider, api_key)?;
  let payload = serde_json::json!({
    "model": model_name,
    "messages": [
      {
        "role": "system",
        "content": prompt,
      },
      {
        "role": "user",
        "content": request.query,
      }
    ],
    "temperature": 0.2,
    "max_tokens": 160,
    "stream": false
  });

  let response = client
    .post(build_chat_completions_url(service_endpoint))
    .headers(headers)
    .json(&payload)
    .send()
    .await
    .map_err(|error| format!("请求 AI 服务失败：{error}"))?;

  let status = response.status();
  let body_text = response
    .text()
    .await
    .map_err(|error| format!("读取 AI 响应失败：{error}"))?;

  if !status.is_success() {
    return Err(format!(
      "AI 服务返回 {}：{}",
      status,
      summarize_error_body(&body_text)
    ));
  }

  let body: Value =
    serde_json::from_str(&body_text).map_err(|error| format!("AI 响应不是有效 JSON：{error}"))?;
  let content = extract_assistant_text(&body).ok_or_else(|| "AI 返回内容为空。".to_string())?;

  parse_translation_response(&content)
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![test_connection, translate_text])
    .on_window_event(|event| {
      if let WindowEvent::CloseRequested { api, .. } = event.event() {
        api.prevent_close();
        event.window().hide().expect("failed to hide window");
      }
    })
    .setup(|app| {
      let app_handle = app.handle();
      let mut shortcut_manager = app.global_shortcut_manager();

      shortcut_manager
        .register("CmdOrCtrl+K", move || show_main_window(&app_handle))
        .expect("failed to register global shortcut");

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
