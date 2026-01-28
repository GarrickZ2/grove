//! Git 命令结果缓存层
//!
//! 用于缓存 git 命令的执行结果，避免每次 UI 渲染时重复执行 git 命令

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 缓存条目
struct CacheEntry<T> {
    value: T,
    expires_at: Instant,
}

/// 字符串缓存 (用于 branch, last_commit 等)
static STRING_CACHE: Lazy<Mutex<HashMap<String, CacheEntry<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Option<u32> 缓存 (用于 commits_ahead 等)
static OPTION_U32_CACHE: Lazy<Mutex<HashMap<String, CacheEntry<Option<u32>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// (u32, u32) 缓存 (用于 file changes 等)
#[allow(clippy::type_complexity)]
static TUPLE_U32_CACHE: Lazy<Mutex<HashMap<String, CacheEntry<(u32, u32)>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 获取缓存的字符串值或计算新值
pub fn get_string_or_compute<F>(key: &str, ttl_secs: u64, compute: F) -> String
where
    F: FnOnce() -> String,
{
    let mut cache = STRING_CACHE.lock().unwrap();
    if let Some(entry) = cache.get(key) {
        if Instant::now() < entry.expires_at {
            return entry.value.clone();
        }
    }
    let value = compute();
    cache.insert(
        key.to_string(),
        CacheEntry {
            value: value.clone(),
            expires_at: Instant::now() + Duration::from_secs(ttl_secs),
        },
    );
    value
}

/// 获取缓存的 Option<u32> 值或计算新值
pub fn get_option_u32_or_compute<F>(key: &str, ttl_secs: u64, compute: F) -> Option<u32>
where
    F: FnOnce() -> Option<u32>,
{
    let mut cache = OPTION_U32_CACHE.lock().unwrap();
    if let Some(entry) = cache.get(key) {
        if Instant::now() < entry.expires_at {
            return entry.value;
        }
    }
    let value = compute();
    cache.insert(
        key.to_string(),
        CacheEntry {
            value,
            expires_at: Instant::now() + Duration::from_secs(ttl_secs),
        },
    );
    value
}

/// 获取缓存的 (u32, u32) 值或计算新值
pub fn get_tuple_u32_or_compute<F>(key: &str, ttl_secs: u64, compute: F) -> (u32, u32)
where
    F: FnOnce() -> (u32, u32),
{
    let mut cache = TUPLE_U32_CACHE.lock().unwrap();
    if let Some(entry) = cache.get(key) {
        if Instant::now() < entry.expires_at {
            return entry.value;
        }
    }
    let value = compute();
    cache.insert(
        key.to_string(),
        CacheEntry {
            value,
            expires_at: Instant::now() + Duration::from_secs(ttl_secs),
        },
    );
    value
}

/// 使指定前缀的缓存失效
pub fn invalidate_prefix(prefix: &str) {
    {
        let mut cache = STRING_CACHE.lock().unwrap();
        cache.retain(|k, _| !k.starts_with(prefix));
    }
    {
        let mut cache = OPTION_U32_CACHE.lock().unwrap();
        cache.retain(|k, _| !k.starts_with(prefix));
    }
    {
        let mut cache = TUPLE_U32_CACHE.lock().unwrap();
        cache.retain(|k, _| !k.starts_with(prefix));
    }
}

/// 清除所有缓存
pub fn clear_all() {
    STRING_CACHE.lock().unwrap().clear();
    OPTION_U32_CACHE.lock().unwrap().clear();
    TUPLE_U32_CACHE.lock().unwrap().clear();
}
