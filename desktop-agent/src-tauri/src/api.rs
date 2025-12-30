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
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use crate::kubo::KuboManager;

pub type SharedKubo = Arc<RwLock<KuboManager>>;

static START_TIME: once_cell::sync::Lazy<Instant> = once_cell::sync::Lazy::new(Instant::now);

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
    hive_username: String,
    auto_pin: bool,
    max_storage_gb: u32,
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

async fn get_status(State(kubo): State<SharedKubo>) -> impl IntoResponse {
    let manager = kubo.read().await;
    
    let stats = manager.get_repo_stats().await.unwrap_or_default();
    
    Json(StatusResponse {
        running: manager.is_running(),
        version: env!("CARGO_PKG_VERSION"),
        peer_id: manager.get_peer_id(),
        hive_username: None,
        ipfs_repo_size: stats.repo_size,
        num_pinned_files: stats.num_pins,
        total_earned: "0.000 HBD".to_string(),
        uptime: START_TIME.elapsed().as_secs(),
    })
}

async fn get_config() -> impl IntoResponse {
    Json(ConfigResponse {
        hive_username: String::new(),
        auto_pin: true,
        max_storage_gb: 50,
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

impl Default for crate::kubo::RepoStats {
    fn default() -> Self {
        Self {
            repo_size: 0,
            num_pins: 0,
        }
    }
}

pub async fn start_api_server(kubo: SharedKubo) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/status", get(get_status))
        .route("/api/config", get(get_config))
        .route("/api/pin", post(pin_content))
        .route("/api/unpin", post(unpin_content))
        .route("/api/pins", get(get_pins))
        .layer(cors)
        .with_state(kubo);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:5111").await?;
    tracing::info!("[API] Server listening on http://127.0.0.1:5111");

    axum::serve(listener, app).await?;

    Ok(())
}
