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

fn build_prompt(source_lang: &str) -> String {
  let direction = if source_lang == "zh" {
    "Chinese to English"
  } else {
    "English to Chinese"
  };

  format!(
    "Translate {direction}. Return only the most common translation as plain text, no explanation or JSON."
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

fn strip_code_fence(text: &str) -> Result<&str, String> {
  let trimmed = text.trim();

  if !trimmed.starts_with("```") {
    return Ok(trimmed);
  }

  let without_open = trimmed
    .strip_prefix("```json")
    .or_else(|| trimmed.strip_prefix("```JSON"))
    .or_else(|| trimmed.strip_prefix("```"))
    .unwrap_or(trimmed);

  without_open
    .strip_suffix("```")
    .map(str::trim)
    .filter(|text| !text.contains("```"))
    .ok_or_else(|| "AI 返回格式异常：代码块不完整。".to_string())
}

fn extract_text_from_value(value: &Value) -> Option<String> {
  if let Some(text) = value.as_str() {
    return Some(text.trim().to_string());
  }

  if let Some(parts) = value.as_array() {
    let mut collected = String::new();

    for part in parts {
      if matches!(part.get("type").and_then(Value::as_str), Some("reasoning" | "thinking")) {
        continue;
      }
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
  let cleaned = strip_code_fence(content)?;
  if cleaned.is_empty() {
    return Err("AI 返回内容为空。".to_string());
  }

  if cleaned.contains("<think>") || cleaned.contains("</think>") {
    return Err("AI 返回了思考内容，而非完整翻译。".to_string());
  }

  let parsed = serde_json::from_str::<Value>(cleaned);
  let json_like = cleaned.starts_with(['{', '[', '"'])
    || cleaned.starts_with("translation:")
    || cleaned.starts_with("'translation'")
    || cleaned.contains("\"translation\"")
    || cleaned.contains("\n{")
    || cleaned.ends_with('}')
    || content.trim_start().starts_with("```json")
    || content.trim_start().starts_with("```JSON");
  let translation = if json_like || matches!(&parsed, Ok(Value::Object(_) | Value::Array(_))) {
    let value = parsed.map_err(|_| "AI 返回格式异常：翻译 JSON 不完整或无效。".to_string())?;
    value.get("translation")
      .and_then(Value::as_str)
      .ok_or_else(|| "AI 返回格式异常：缺少有效的 translation 字段。".to_string())?
      .trim()
      .to_string()
  } else {
    cleaned.to_string()
  };

  if translation.is_empty() {
    return Err("AI 返回的翻译为空。".to_string());
  }
  if translation.contains("<think>") || translation.contains("</think>") {
    return Err("AI 返回了思考内容，而非完整翻译。".to_string());
  }
  Ok(TranslateResponse { translation })
}

fn parse_chat_response(body: &Value) -> Result<TranslateResponse, String> {
  if body.pointer("/choices/0/finish_reason").and_then(Value::as_str) == Some("length") {
    return Err("AI 返回内容被截断，请调整模型配置后重试。".to_string());
  }
  let content = extract_assistant_text(body).ok_or_else(|| "AI 返回内容为空。".to_string())?;
  parse_translation_response(&content)
}

fn summarize_error_body(body: &str) -> String {
  let trimmed = body.trim();
  if trimmed.len() <= 180 {
    return trimmed.to_string();
  }

  format!("{}...", &trimmed[..180])
}

fn build_client(provider: &str) -> Result<reqwest::Client, String> {
  let builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
  // Local model services use the direct intranet route, not inherited HTTP proxies.
  let builder = if provider == "local" {
    builder.no_proxy()
  } else {
    builder
  };

  builder
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
  let client = build_client(provider)?;
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
  let prompt = build_prompt(source_lang);
  let client = build_client(&request.provider)?;
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
  parse_chat_response(&body)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn prompt_requests_only_translation_in_the_target_language() {
    let chinese_prompt = build_prompt("zh");
    let english_prompt = build_prompt("en");
    assert!(chinese_prompt.contains("Chinese to English"));
    assert!(english_prompt.contains("English to Chinese"));
    assert!(chinese_prompt.contains("plain text, no explanation or JSON"));
    assert!(!chinese_prompt.contains("explanationZh"));
  }

  #[test]
  fn plain_translation_is_preserved_and_response_has_only_translation() {
    for content in [" Desktop tool ", "你好", "第一行\n第二行", "2026"] {
      let response = parse_translation_response(content).unwrap();
      assert_eq!(response.translation, content.trim());
      assert_eq!(
        serde_json::to_value(response).unwrap(),
        serde_json::json!({ "translation": content.trim() })
      );
    }
  }

  #[test]
  fn legacy_json_extracts_only_translation() {
    for content in [
      r#"{"translation":" Desktop tool ","explanationZh":"中文说明"}"#,
      r#"{"translation":" Desktop tool "}"#,
      "```json\n{\"translation\":\" Desktop tool \"}\n```",
      "```JSON\r\n{\"translation\":\" Desktop tool \"}\r\n```",
      "```\n{\"translation\":\" Desktop tool \"}\n```",
    ] {
      let response = parse_translation_response(content).unwrap();
      assert_eq!(
        serde_json::to_value(response).unwrap(),
        serde_json::json!({ "translation": "Desktop tool" })
      );
    }
  }

  #[test]
  fn malformed_json_never_falls_back_to_raw_translation() {
    for content in [
      r#"{translation:Desktop tool, explanationZh:中文说明}"#,
      r#"{"translation":"Desktop tool","explanationZh":"中文说明""#,
      r#"{"translation":"Desktop"#,
      "{\n\"translation\": \"Desktop tool\",\n}",
      "```json\n{\"translation\":\"Desktop tool\"}",
      "```json\nDesktop tool\n```",
      "```json\n{\"translation\":\"Desktop tool\"}\n``` trailing",
      "Here is the translation:\n{\"translation\":\"Desktop tool\"",
      "translation: Desktop tool",
      r#""translation": "Desktop tool""#,
      r#"{"translation":"Desktop tool"} extra"#,
    ] {
      assert!(parse_translation_response(content).is_err(), "accepted malformed JSON: {content}");
    }
  }

  #[test]
  fn invalid_or_empty_translation_is_rejected() {
    for content in [
      "", " \n ", "```json\n\n```", "{}",
      r#"{"explanationZh":"只有说明"}"#,
      r#"{"translation":""}"#,
      r#"{"translation":" \n "}"#,
      r#"{"translation":null}"#,
      r#"{"translation":42}"#,
      r#"[{"translation":"Desktop tool"}]"#,
    ] {
      assert!(parse_translation_response(content).is_err(), "accepted invalid translation: {content}");
    }
  }

  #[test]
  fn thinking_is_not_translation() {
    for content in [
      "<think>reasoning</think>Desktop tool",
      "<think>unfinished reasoning",
      "reasoning</think>Desktop tool",
      r#"{"translation":"<think>reasoning</think>Desktop tool"}"#,
    ] {
      assert!(parse_translation_response(content).is_err());
    }
    let reasoning_only = serde_json::json!({
      "choices": [{ "message": { "content": "", "reasoning": "Desktop tool" }, "finish_reason": "stop" }]
    });
    assert!(parse_chat_response(&reasoning_only).is_err());
    let parts = serde_json::json!({
      "choices": [{ "message": { "content": [
        { "type": "reasoning", "text": "internal reasoning" },
        { "type": "text", "text": "Desktop tool" }
      ] }, "finish_reason": "stop" }]
    });
    assert_eq!(parse_chat_response(&parts).unwrap().translation, "Desktop tool");
  }

  #[test]
  fn truncated_completion_is_rejected_even_when_content_looks_valid() {
    for content in ["Desktop tool", r#"{"translation":"Desktop tool"}"#, ""] {
      let body = serde_json::json!({
        "choices": [{ "message": { "content": content }, "finish_reason": "length" }]
      });
      assert!(parse_chat_response(&body).unwrap_err().contains("截断"));
    }
  }

  #[test]
  fn local_translation_uses_short_prompt_and_typed_response() {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
      let mut request = Vec::new();
      let mut buffer = [0; 4096];
      let payload = loop {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0, "request ended before body");
        request.extend_from_slice(&buffer[..count]);
        if let Some(header_end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
          let headers = String::from_utf8_lossy(&request[..header_end]);
          assert!(headers.starts_with("POST /v1/chat/completions "));
          let length: usize = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
          }).unwrap();
          if request.len() >= header_end + 4 + length {
            break serde_json::from_slice::<Value>(&request[header_end + 4..header_end + 4 + length]).unwrap();
          }
        }
      };
      assert_eq!(payload["messages"][0]["content"], build_prompt("zh"));
      assert_eq!(payload["messages"][1]["content"], "桌面工具");
      assert_eq!(payload["stream"], false);
      assert_eq!(payload["max_tokens"], 160);
      let body = r#"{"choices":[{"message":{"content":"Desktop tool"},"finish_reason":"stop"}]}"#;
      write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let response = tauri::async_runtime::block_on(translate_text(TranslateRequest {
      query: "桌面工具".to_string(),
      provider: "local".to_string(),
      service_endpoint: endpoint,
      model_name: "test-model".to_string(),
      api_key: String::new(),
    })).unwrap();
    assert_eq!(response.translation, "Desktop tool");
    server.join().unwrap();
  }

  #[test]
  #[ignore = "Requires DICTIONARY_TEST_ENDPOINT and a thinking model that exhausts 160 tokens"]
  fn configured_thinking_model_reports_truncation_not_translation() {
    let endpoint = std::env::var("DICTIONARY_TEST_ENDPOINT").unwrap();
    let model = std::env::var("DICTIONARY_TEST_MODEL").unwrap();
    for query in ["桌面工具", "hello"] {
      let result = tauri::async_runtime::block_on(translate_text(TranslateRequest {
        query: query.to_string(),
        provider: "local".to_string(),
        service_endpoint: endpoint.clone(),
        model_name: model.clone(),
        api_key: String::new(),
      }));
      let error = result.unwrap_err();
      println!("{query}: {error}");
      assert!(error.contains("截断"), "unexpected error: {error}");
    }
  }

  #[test]
  fn local_client_reaches_models_endpoint() {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
      let mut request = [0; 4096];
      let count = stream.read(&mut request).unwrap();
      assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET /v1/models "));
      let body = r#"{"data":[{"id":"test-model"}]}"#;
      write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let body = tauri::async_runtime::block_on(send_get_request(&endpoint, "local", "")).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["data"][0]["id"], "test-model");
    server.join().unwrap();
  }

  #[test]
  #[ignore = "Requires DICTIONARY_TEST_ENDPOINT pointing to an accessible model service"]
  fn configured_local_service_connection() {
    let endpoint = std::env::var("DICTIONARY_TEST_ENDPOINT").unwrap();
    let result = tauri::async_runtime::block_on(test_connection(TranslateRequest {
      query: String::new(),
      provider: "local".to_string(),
      service_endpoint: endpoint,
      model_name: String::new(),
      api_key: String::new(),
    }));
    assert_eq!(result.unwrap(), "连接正常");
  }
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
