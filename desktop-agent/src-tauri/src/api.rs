/**
 * HTTP API Server - Port 5111
 * Repurposed from client/src/lib/desktop-agent.ts detection protocol
 * 
 * Allows web app to detect and communicate with desktop agent
 */

use axum::{
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use crate::kubo::KuboManager;
use crate::autostart;
use crate::notifications;

pub type SharedKubo = Arc<RwLock<KuboManager>>;

static START_TIME: once_cell::sync::Lazy<Instant> = once_cell::sync::Lazy::new(Instant::now);

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentConfig {
    pub hive_username: Option<String>,
    pub hive_posting_key_hash: Option<String>,
    pub auto_pin: bool,
    pub max_storage_gb: u32,
    pub auto_start: bool,
    pub total_earned_hbd: f64,
    pub challenge_count: u64,
    pub last_challenge_at: Option<u64>,
    pub notify_on_challenge: bool,
    pub notify_on_milestone: bool,
    pub notify_daily_summary: bool,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            hive_username: None,
            hive_posting_key_hash: None,
            auto_pin: true,
            max_storage_gb: 50,
            auto_start: false,
            total_earned_hbd: 0.0,
            challenge_count: 0,
            last_challenge_at: None,
            notify_on_challenge: true,
            notify_on_milestone: true,
            notify_daily_summary: true,
        }
    }
}

fn get_config_path() -> PathBuf {
    let home = dirs::home_dir().expect("Could not find home directory");
    home.join(".spk-ipfs").join("agent-config.json")
}

fn load_config() -> AgentConfig {
    let config_path = get_config_path();
    
    if !config_path.exists() {
        let default_config = AgentConfig::default();
        let _ = save_config(&default_config);
        return default_config;
    }
    
    match fs::read_to_string(&config_path) {
        Ok(content) => {
            serde_json::from_str(&content).unwrap_or_else(|e| {
                tracing::warn!("[Config] Failed to parse config: {}, using defaults", e);
                AgentConfig::default()
            })
        }
        Err(e) => {
            tracing::warn!("[Config] Failed to read config: {}, using defaults", e);
            AgentConfig::default()
        }
    }
}

fn save_config(config: &AgentConfig) -> Result<(), String> {
    let config_path = get_config_path();
    
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    
    tracing::info!("[Config] Saved to {:?}", config_path);
    Ok(())
}

#[derive(Serialize)]
struct StatusResponse {
    running: bool,
    version: &'static str,
    peer_id: Option<String>,
    hive_username: Option<String>,
    ipfs_repo_size: u64,
    num_pinned_files: usize,
    total_earned: String,
    uptime: u64,
}

#[derive(Serialize)]
struct ConfigResponse {
    hive_username: Option<String>,
    auto_pin: bool,
    max_storage_gb: u32,
    auto_start: bool,
    notify_on_challenge: bool,
    notify_on_milestone: bool,
    notify_daily_summary: bool,
}

#[derive(Deserialize)]
struct UpdateConfigRequest {
    hive_username: Option<String>,
    hive_posting_key_hash: Option<String>,
    auto_pin: Option<bool>,
    max_storage_gb: Option<u32>,
    auto_start: Option<bool>,
    notify_on_challenge: Option<bool>,
    notify_on_milestone: Option<bool>,
    notify_daily_summary: Option<bool>,
}

#[derive(Deserialize)]
struct AddEarningsRequest {
    amount_hbd: f64,
    challenge_timestamp: Option<u64>,
}

#[derive(Serialize)]
struct EarningsResponse {
    total_earned_hbd: f64,
    total_earned_formatted: String,
    challenge_count: u64,
    last_challenge_at: Option<u64>,
    avg_per_challenge: f64,
}

#[derive(Deserialize)]
struct PinRequest {
    cid: String,
    #[allow(dead_code)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct UnpinRequest {
    cid: String,
}

#[derive(Serialize)]
struct PinInfo {
    cid: String,
    name: String,
    size: u64,
}

#[derive(Deserialize)]
struct ChallengeRequest {
    cid: String,
    salt: String,
    block_indices: Vec<u64>,
}

#[derive(Serialize)]
struct ChallengeResponse {
    success: bool,
    proof: String,
    latency_ms: u64,
}

async fn get_status(State(kubo): State<SharedKubo>) -> impl IntoResponse {
    let manager = kubo.read().await;
    let config = load_config();
    
    let stats = manager.get_repo_stats().await.unwrap_or_default();
    
    Json(StatusResponse {
        running: manager.is_running(),
        version: env!("CARGO_PKG_VERSION"),
        peer_id: manager.get_peer_id(),
        hive_username: config.hive_username,
        ipfs_repo_size: stats.repo_size,
        num_pinned_files: stats.num_pins,
        total_earned: format!("{:.3} HBD", config.total_earned_hbd),
        uptime: START_TIME.elapsed().as_secs(),
    })
}

async fn get_config_handler() -> impl IntoResponse {
    let config = load_config();
    
    Json(ConfigResponse {
        hive_username: config.hive_username,
        auto_pin: config.auto_pin,
        max_storage_gb: config.max_storage_gb,
        auto_start: config.auto_start,
        notify_on_challenge: config.notify_on_challenge,
        notify_on_milestone: config.notify_on_milestone,
        notify_daily_summary: config.notify_daily_summary,
    })
}

async fn update_config(Json(req): Json<UpdateConfigRequest>) -> impl IntoResponse {
    let mut config = load_config();
    
    if let Some(username) = req.hive_username {
        config.hive_username = if username.is_empty() { None } else { Some(username) };
    }
    if let Some(key_hash) = req.hive_posting_key_hash {
        config.hive_posting_key_hash = if key_hash.is_empty() { None } else { Some(key_hash) };
    }
    if let Some(auto_pin) = req.auto_pin {
        config.auto_pin = auto_pin;
    }
    if let Some(max_storage_gb) = req.max_storage_gb {
        config.max_storage_gb = max_storage_gb;
    }
    if let Some(auto_start) = req.auto_start {
        config.auto_start = auto_start;
    }
    if let Some(notify_on_challenge) = req.notify_on_challenge {
        config.notify_on_challenge = notify_on_challenge;
    }
    if let Some(notify_on_milestone) = req.notify_on_milestone {
        config.notify_on_milestone = notify_on_milestone;
    }
    if let Some(notify_daily_summary) = req.notify_daily_summary {
        config.notify_daily_summary = notify_daily_summary;
    }
    
    match save_config(&config) {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({
            "success": true,
            "config": {
                "hive_username": config.hive_username,
                "auto_pin": config.auto_pin,
                "max_storage_gb": config.max_storage_gb,
                "auto_start": config.auto_start,
                "notify_on_challenge": config.notify_on_challenge,
                "notify_on_milestone": config.notify_on_milestone,
                "notify_daily_summary": config.notify_daily_summary
            }
        }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "success": false,
            "error": e
        }))),
    }
}

async fn add_earnings(Json(req): Json<AddEarningsRequest>) -> impl IntoResponse {
    let mut config = load_config();
    
    if req.amount_hbd < 0.0 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": "Amount cannot be negative"
        })));
    }
    
    let old_total = config.total_earned_hbd;
    config.total_earned_hbd += req.amount_hbd;
    config.challenge_count += 1;
    config.last_challenge_at = req.challenge_timestamp.or(Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    ));
    
    match save_config(&config) {
        Ok(_) => {
            tracing::info!("[Earnings] Added {:.3} HBD, total: {:.3} HBD", 
                req.amount_hbd, config.total_earned_hbd);
            
            if config.notify_on_challenge {
                notifications::send_challenge_notification(req.amount_hbd);
            }
            
            if config.notify_on_milestone {
                if let Some(milestone) = notifications::check_milestone_crossed(old_total, config.total_earned_hbd) {
                    notifications::send_milestone_notification(config.total_earned_hbd, milestone);
                }
            }
            
            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "total_earned_hbd": config.total_earned_hbd,
                "challenge_count": config.challenge_count
            })))
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "success": false,
            "error": e
        }))),
    }
}

async fn get_earnings() -> impl IntoResponse {
    let config = load_config();
    
    let avg_per_challenge = if config.challenge_count > 0 {
        config.total_earned_hbd / config.challenge_count as f64
    } else {
        0.0
    };
    
    Json(EarningsResponse {
        total_earned_hbd: config.total_earned_hbd,
        total_earned_formatted: format!("{:.3} HBD", config.total_earned_hbd),
        challenge_count: config.challenge_count,
        last_challenge_at: config.last_challenge_at,
        avg_per_challenge,
    })
}

async fn pin_content(State(kubo): State<SharedKubo>, Json(req): Json<PinRequest>) -> impl IntoResponse {
    let manager = kubo.read().await;
    
    match manager.pin(&req.cid).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({"success": true}))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"success": false, "error": e}))),
    }
}

async fn unpin_content(State(kubo): State<SharedKubo>, Json(req): Json<UnpinRequest>) -> impl IntoResponse {
    let manager = kubo.read().await;
    
    match manager.unpin(&req.cid).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({"success": true}))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"success": false, "error": e}))),
    }
}

async fn get_pins(State(kubo): State<SharedKubo>) -> impl IntoResponse {
    let manager = kubo.read().await;
    
    match manager.get_pins().await {
        Ok(pins) => {
            let pins: Vec<PinInfo> = pins.iter().map(|p| PinInfo {
                cid: p.cid.clone(),
                name: p.name.clone(),
                size: p.size,
            }).collect();
            Json(pins)
        }
        Err(_) => Json(vec![]),
    }
}

#[derive(Serialize)]
struct AutostartStatusResponse {
    enabled: bool,
}

async fn get_autostart_status() -> impl IntoResponse {
    let enabled = autostart::is_autostart_enabled();
    Json(AutostartStatusResponse { enabled })
}

async fn enable_autostart() -> impl IntoResponse {
    match autostart::enable_autostart() {
        Ok(_) => {
            let mut config = load_config();
            config.auto_start = true;
            let _ = save_config(&config);
            
            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "enabled": true
            })))
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "success": false,
            "error": e
        }))),
    }
}

async fn disable_autostart() -> impl IntoResponse {
    match autostart::disable_autostart() {
        Ok(_) => {
            let mut config = load_config();
            config.auto_start = false;
            let _ = save_config(&config);
            
            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "enabled": false
            })))
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "success": false,
            "error": e
        }))),
    }
}

async fn handle_challenge(
    State(kubo): State<SharedKubo>,
    Json(req): Json<ChallengeRequest>,
) -> impl IntoResponse {
    let start_time = Instant::now();
    let manager = kubo.read().await;
    
    if !manager.is_running() {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
            "success": false,
            "error": "IPFS daemon not running",
            "proof": "",
            "latency_ms": start_time.elapsed().as_millis() as u64
        })));
    }

    let mut hasher = Sha256::new();
    hasher.update(req.salt.as_bytes());

    for block_index in &req.block_indices {
        match manager.get_block(&req.cid, *block_index) {
            Ok(block_data) => {
                hasher.update(&block_data);
            }
            Err(e) => {
                tracing::warn!("[Challenge] Failed to get block {}/{}: {}", req.cid, block_index, e);
                return (StatusCode::NOT_FOUND, Json(serde_json::json!({
                    "success": false,
                    "error": format!("Failed to fetch block {}: {}", block_index, e),
                    "proof": "",
                    "latency_ms": start_time.elapsed().as_millis() as u64
                })));
            }
        }
    }

    let result = hasher.finalize();
    let proof = hex::encode(result);
    let latency_ms = start_time.elapsed().as_millis() as u64;

    tracing::info!(
        "[Challenge] Responded to challenge for CID {} with {} blocks in {}ms",
        req.cid,
        req.block_indices.len(),
        latency_ms
    );

    (StatusCode::OK, Json(serde_json::json!({
        "success": true,
        "proof": proof,
        "latency_ms": latency_ms
    })))
}

impl Default for crate::kubo::RepoStats {
    fn default() -> Self {
        Self {
            repo_size: 0,
            num_pins: 0,
        }
    }
}

pub async fn start_api_server(kubo: SharedKubo) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = load_config();
    
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/status", get(get_status))
        .route("/api/config", get(get_config_handler))
        .route("/api/config", post(update_config))
        .route("/api/pin", post(pin_content))
        .route("/api/unpin", post(unpin_content))
        .route("/api/pins", get(get_pins))
        .route("/api/earnings", get(get_earnings))
        .route("/api/earnings/add", post(add_earnings))
        .route("/api/challenge", post(handle_challenge))
        .route("/api/autostart/status", get(get_autostart_status))
        .route("/api/autostart/enable", post(enable_autostart))
        .route("/api/autostart/disable", post(disable_autostart))
        .layer(cors)
        .with_state(kubo);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:5111").await?;
    tracing::info!("[API] Server listening on http://127.0.0.1:5111");

    axum::serve(listener, app).await?;

    Ok(())
}
