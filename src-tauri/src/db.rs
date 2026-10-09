use std::{
  fs,
  path::PathBuf,
  sync::Mutex,
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const DEFAULT_PROVIDER: &str = "local";
const DEFAULT_SERVICE_ENDPOINT: &str = "http://localhost:11434/v1";
const DEFAULT_MODEL_NAME: &str = "qwen2.5:7b-instruct";

const META_LEGACY_IMPORTED: &str = "legacy_imported";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSettings {
  pub provider: String,
  pub service_endpoint: String,
  pub local_endpoint: String,
  pub model_name: String,
  pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashcardRecord {
  pub id: String,
  pub query: String,
  pub source_lang: String,
  pub translation: String,
  pub explanation_zh: String,
  pub review_count: i64,
  pub created_at: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashcardWriteRequest {
  pub query: String,
  pub source_lang: String,
  pub translation: String,
  pub explanation_zh: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyState {
  pub settings: PersistedSettings,
  pub flashcards: Vec<FlashcardRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceSnapshot {
  pub settings: PersistedSettings,
  pub flashcards: Vec<FlashcardRecord>,
}

pub struct DbState {
  connection: Mutex<Connection>,
}

impl DbState {
  pub fn open(app: &AppHandle) -> Result<Self, String> {
    let db_path = database_path(app)?;
    if let Some(parent) = db_path.parent() {
      fs::create_dir_all(parent)
        .map_err(|error| format!("创建数据库目录失败：{error}"))?;
    }

    let connection = Connection::open(db_path)
      .map_err(|error| format!("打开 SQLite 数据库失败：{error}"))?;
    let state = Self {
      connection: Mutex::new(connection),
    };
    state.init_schema()?;
    Ok(state)
  }

  #[cfg(test)]
  pub fn open_in_memory() -> Result<Self, String> {
    let connection = Connection::open_in_memory()
      .map_err(|error| format!("打开内存数据库失败：{error}"))?;
    let state = Self {
      connection: Mutex::new(connection),
    };
    state.init_schema()?;
    Ok(state)
  }

  fn with_connection<T>(
    &self,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
  ) -> Result<T, String> {
    let mut connection = self
      .connection
      .lock()
      .map_err(|_| "SQLite 连接已被锁定。".to_string())?;
    f(&mut connection)
  }

  fn init_schema(&self) -> Result<(), String> {
    self.with_connection(|connection| {
      connection.execute_batch(
        r#"
          PRAGMA foreign_keys = ON;

          CREATE TABLE IF NOT EXISTS app_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            provider TEXT NOT NULL,
            service_endpoint TEXT NOT NULL,
            model_name TEXT NOT NULL,
            api_key TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS flashcards (
            id TEXT PRIMARY KEY,
            query_key TEXT NOT NULL,
            query TEXT NOT NULL,
            source_lang TEXT NOT NULL CHECK (source_lang IN ('zh', 'en')),
            translation TEXT NOT NULL,
            explanation_zh TEXT NOT NULL,
            review_count INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(query_key, source_lang)
          );

          CREATE INDEX IF NOT EXISTS idx_flashcards_updated_at
            ON flashcards(updated_at DESC);

          CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        "#,
      )
      .map_err(|error| format!("初始化 SQLite 结构失败：{error}"))?;

      connection.execute(
        r#"
          INSERT OR IGNORE INTO app_settings (id, provider, service_endpoint, model_name, api_key)
          VALUES (1, ?1, ?2, ?3, '')
        "#,
        params![DEFAULT_PROVIDER, DEFAULT_SERVICE_ENDPOINT, DEFAULT_MODEL_NAME],
      )
      .map_err(|error| format!("初始化默认设置失败：{error}"))?;

      Ok(())
    })
  }

  fn read_settings(connection: &Connection) -> Result<PersistedSettings, String> {
    let row = connection
      .query_row(
        r#"
          SELECT provider, service_endpoint, model_name, api_key
          FROM app_settings
          WHERE id = 1
        "#,
        [],
        |row| {
          Ok(PersistedSettings {
            provider: row.get(0)?,
            service_endpoint: row.get(1)?,
            local_endpoint: row.get(1)?,
            model_name: row.get(2)?,
            api_key: row.get(3)?,
          })
        },
      )
      .optional()
      .map_err(|error| format!("读取设置失败：{error}"))?;

    row.ok_or_else(|| "SQLite 设置缺失。".to_string())
  }

  fn save_settings_row(
    connection: &Connection,
    settings: &PersistedSettings,
  ) -> Result<PersistedSettings, String> {
    let provider = normalize_provider(&settings.provider)?;
    let service_endpoint = resolve_service_endpoint(settings);
    let model_name = normalize_model_name(&settings.model_name);
    let api_key = settings.api_key.trim().to_string();

    connection
      .execute(
        r#"
          INSERT INTO app_settings (id, provider, service_endpoint, model_name, api_key)
          VALUES (1, ?1, ?2, ?3, ?4)
          ON CONFLICT(id) DO UPDATE SET
            provider = excluded.provider,
            service_endpoint = excluded.service_endpoint,
            model_name = excluded.model_name,
            api_key = excluded.api_key
        "#,
        params![provider, service_endpoint, model_name, api_key],
      )
      .map_err(|error| format!("保存设置失败：{error}"))?;

    Ok(PersistedSettings {
      provider,
      service_endpoint: service_endpoint.clone(),
      local_endpoint: service_endpoint,
      model_name,
      api_key,
    })
  }

  fn is_legacy_imported(connection: &Connection) -> Result<bool, String> {
    let value = connection
      .query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        [META_LEGACY_IMPORTED],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .map_err(|error| format!("读取迁移状态失败：{error}"))?;

    Ok(matches!(value.as_deref(), Some("true")))
  }

  fn set_legacy_imported(connection: &Connection) -> Result<(), String> {
    connection
      .execute(
        r#"
          INSERT INTO app_meta (key, value)
          VALUES (?1, 'true')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        [META_LEGACY_IMPORTED],
      )
      .map_err(|error| format!("写入迁移状态失败：{error}"))?;
    Ok(())
  }

  fn list_flashcards(connection: &Connection) -> Result<Vec<FlashcardRecord>, String> {
    let mut statement = connection
      .prepare(
        r#"
          SELECT id, query, source_lang, translation, explanation_zh, review_count, created_at, updated_at
          FROM flashcards
          ORDER BY updated_at DESC, created_at DESC
        "#,
      )
      .map_err(|error| format!("准备闪卡查询失败：{error}"))?;

    let rows = statement
      .query_map([], |row| {
        Ok(FlashcardRecord {
          id: row.get(0)?,
          query: row.get(1)?,
          source_lang: row.get(2)?,
          translation: row.get(3)?,
          explanation_zh: row.get(4)?,
          review_count: row.get(5)?,
          created_at: row.get(6)?,
          updated_at: row.get(7)?,
        })
      })
      .map_err(|error| format!("读取闪卡失败：{error}"))?;

    let mut flashcards = Vec::new();
    for row in rows {
      flashcards.push(row.map_err(|error| format!("解析闪卡失败：{error}"))?);
    }

    Ok(flashcards)
  }

  fn insert_legacy_flashcard(
    connection: &Connection,
    flashcard: &FlashcardRecord,
  ) -> Result<(), String> {
    let source_lang = normalize_source_lang(&flashcard.source_lang)?;
    let query_key = normalize_query_key(&flashcard.query);
    let id = if flashcard.id.trim().is_empty() {
      flashcard_key(&query_key, &source_lang)
    } else {
      flashcard.id.trim().to_string()
    };
    let now = if flashcard.updated_at.trim().is_empty() {
      now_iso()
    } else {
      flashcard.updated_at.trim().to_string()
    };
    let created_at = if flashcard.created_at.trim().is_empty() {
      now.clone()
    } else {
      flashcard.created_at.trim().to_string()
    };
    let review_count = flashcard.review_count.max(1);

    connection
      .execute(
        r#"
          INSERT OR REPLACE INTO flashcards (
            id, query_key, query, source_lang, translation, explanation_zh,
            review_count, created_at, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
          id,
          query_key,
          flashcard.query.trim(),
          source_lang,
          flashcard.translation.trim(),
          flashcard.explanation_zh.trim(),
          review_count,
          created_at,
          now,
        ],
      )
      .map_err(|error| format!("导入旧闪卡失败：{error}"))?;

    Ok(())
  }

  pub fn initialize(
    &self,
    legacy: Option<LegacyState>,
  ) -> Result<PersistenceSnapshot, String> {
    self.with_connection(|connection| {
      if let Some(legacy) = legacy {
        let has_legacy_content = !legacy.flashcards.is_empty()
          || !legacy.settings.provider.trim().is_empty()
          || !legacy.settings.service_endpoint.trim().is_empty()
          || !legacy.settings.local_endpoint.trim().is_empty()
          || !legacy.settings.model_name.trim().is_empty()
          || !legacy.settings.api_key.trim().is_empty();

        if has_legacy_content && !Self::is_legacy_imported(connection)? {
          let tx = connection
            .transaction()
            .map_err(|error| format!("开始迁移失败：{error}"))?;

          Self::save_settings_row(&tx, &legacy.settings)?;

          for flashcard in &legacy.flashcards {
            Self::insert_legacy_flashcard(&tx, flashcard)?;
          }

          Self::set_legacy_imported(&tx)?;
          tx.commit().map_err(|error| format!("提交迁移失败：{error}"))?;
        }
      }

      let settings = Self::read_settings(connection)?;
      let flashcards = Self::list_flashcards(connection)?;
      Ok(PersistenceSnapshot { settings, flashcards })
    })
  }

  pub fn save_settings(&self, settings: PersistedSettings) -> Result<PersistedSettings, String> {
    self.with_connection(|connection| Self::save_settings_row(connection, &settings))
  }

  pub fn upsert_flashcard(
    &self,
    request: FlashcardWriteRequest,
  ) -> Result<FlashcardRecord, String> {
    self.with_connection(|connection| {
      let source_lang = normalize_source_lang(&request.source_lang)?;
      let query = request.query.trim();
      let query_key = normalize_query_key(query);
      let translation = request.translation.trim();
      let explanation_zh = request.explanation_zh.trim();

      if query.is_empty() {
        return Err("闪卡内容为空。".to_string());
      }

      if translation.is_empty() {
        return Err("闪卡翻译不能为空。".to_string());
      }

      let now = now_iso();
      let id = flashcard_key(&query_key, &source_lang);

      connection
        .execute(
          r#"
            INSERT INTO flashcards (
              id, query_key, query, source_lang, translation, explanation_zh,
              review_count, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
            ON CONFLICT(query_key, source_lang) DO UPDATE SET
              translation = excluded.translation,
              explanation_zh = excluded.explanation_zh,
              review_count = flashcards.review_count + 1,
              updated_at = excluded.updated_at
          "#,
          params![id, query_key, query, source_lang, translation, explanation_zh, now],
        )
        .map_err(|error| format!("保存闪卡失败：{error}"))?;

      connection
        .query_row(
          r#"
            SELECT id, query, source_lang, translation, explanation_zh, review_count, created_at, updated_at
            FROM flashcards
            WHERE query_key = ?1 AND source_lang = ?2
          "#,
          params![query_key, source_lang],
          |row| {
            Ok(FlashcardRecord {
              id: row.get(0)?,
              query: row.get(1)?,
              source_lang: row.get(2)?,
              translation: row.get(3)?,
              explanation_zh: row.get(4)?,
              review_count: row.get(5)?,
              created_at: row.get(6)?,
              updated_at: row.get(7)?,
            })
          },
        )
        .map_err(|error| format!("读取保存后的闪卡失败：{error}"))
    })
  }
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
  let mut path = app
    .path_resolver()
    .app_data_dir()
    .ok_or_else(|| "无法定位应用数据目录。".to_string())?;
  path.push("dictionary-lib.sqlite3");
  Ok(path)
}

fn resolve_service_endpoint(settings: &PersistedSettings) -> String {
  let endpoint = if !settings.service_endpoint.trim().is_empty() {
    settings.service_endpoint.trim()
  } else {
    settings.local_endpoint.trim()
  };

  if endpoint.is_empty() {
    DEFAULT_SERVICE_ENDPOINT.to_string()
  } else {
    endpoint.to_string()
  }
}

fn normalize_provider(provider: &str) -> Result<String, String> {
  match provider.trim() {
    "local" => Ok("local".to_string()),
    "api" => Ok("api".to_string()),
    other => Err(format!("不支持的 AI 来源配置：{other}")),
  }
}

fn normalize_source_lang(source_lang: &str) -> Result<String, String> {
  match source_lang.trim() {
    "zh" => Ok("zh".to_string()),
    "en" => Ok("en".to_string()),
    other => Err(format!("不支持的源语言：{other}")),
  }
}

fn normalize_model_name(model_name: &str) -> String {
  let trimmed = model_name.trim();
  if trimmed.is_empty() {
    DEFAULT_MODEL_NAME.to_string()
  } else {
    trimmed.to_string()
  }
}

fn flashcard_key(query: &str, source_lang: &str) -> String {
  format!("{source_lang}:{}", query.trim().to_lowercase())
}

fn normalize_query_key(query: &str) -> String {
  query
    .trim()
    .to_lowercase()
    .chars()
    .filter(|character| {
      !matches!(
        *character,
        ' ' | '·' | ',' | '.' | ';' | ':' | '\'' | '"' | '“' | '”' | '(' | ')' | '（'
          | '）' | '【' | '】' | '[' | ']' | '{' | '}' | '!' | '?' | '！' | '？' | '/'
          | '\\' | '-'
      )
    })
    .collect()
}

fn now_iso() -> String {
  Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn settings_round_trip_uses_local_endpoint_alias() {
    let db = DbState::open_in_memory().unwrap();

    let saved = db
      .save_settings(PersistedSettings {
        provider: "api".to_string(),
        service_endpoint: "http://example.com".to_string(),
        local_endpoint: String::new(),
        model_name: "gpt-4o-mini".to_string(),
        api_key: "secret".to_string(),
      })
      .unwrap();

    assert_eq!(saved.service_endpoint, "http://example.com");
    assert_eq!(saved.local_endpoint, "http://example.com");

    let snapshot = db.initialize(None).unwrap();
    assert_eq!(snapshot.settings.provider, "api");
    assert_eq!(snapshot.settings.service_endpoint, "http://example.com");
    assert_eq!(snapshot.settings.local_endpoint, "http://example.com");
  }

  #[test]
  fn flashcard_upsert_increments_review_count_and_preserves_identity() {
    let db = DbState::open_in_memory().unwrap();

    let first = db
      .upsert_flashcard(FlashcardWriteRequest {
        query: "prototype".to_string(),
        source_lang: "en".to_string(),
        translation: "原型".to_string(),
        explanation_zh: "说明".to_string(),
      })
      .unwrap();
    assert_eq!(first.review_count, 1);

    let second = db
      .upsert_flashcard(FlashcardWriteRequest {
        query: "prototype".to_string(),
        source_lang: "en".to_string(),
        translation: "原型；样机".to_string(),
        explanation_zh: "更新说明".to_string(),
      })
      .unwrap();
    assert_eq!(second.review_count, 2);
    assert_eq!(first.id, second.id);
    assert_eq!(second.translation, "原型；样机");
  }

  #[test]
  fn legacy_import_runs_once() {
    let db = DbState::open_in_memory().unwrap();
    let snapshot = db
      .initialize(Some(LegacyState {
        settings: PersistedSettings {
          provider: "local".to_string(),
          service_endpoint: "http://localhost:11434/v1".to_string(),
          local_endpoint: String::new(),
          model_name: "qwen2.5:7b-instruct".to_string(),
          api_key: String::new(),
        },
        flashcards: vec![FlashcardRecord {
          id: "legacy-1".to_string(),
          query: "iteration".to_string(),
          source_lang: "en".to_string(),
          translation: "迭代".to_string(),
          explanation_zh: "说明".to_string(),
          review_count: 3,
          created_at: "2026-10-09T00:00:00.000Z".to_string(),
          updated_at: "2026-10-09T00:00:00.000Z".to_string(),
        }],
      }))
      .unwrap();

    assert_eq!(snapshot.flashcards.len(), 1);
    assert_eq!(snapshot.flashcards[0].review_count, 3);

    let second_snapshot = db.initialize(None).unwrap();
    assert_eq!(second_snapshot.flashcards.len(), 1);
  }
}
