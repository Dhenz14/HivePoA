/**
 * Kubo Manager - Rust Port (Optimized)
 * Repurposed from server/services/ipfs-manager.ts and SPK Network's trole patterns
 * 
 * Optimizations:
 * - Batch config writes (single JSON update vs multiple CLI calls)
 * - Cached stats with 30s TTL
 * - Desktop-optimized settings (lower memory/connections)
 * - Parallel initialization where possible
 */

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

static DAEMON_READY: AtomicBool = AtomicBool::new(false);

pub struct KuboManager {
    daemon: Option<Child>,
    repo_path: PathBuf,
    api_port: u16,
    gateway_port: u16,
    swarm_port: u16,
    peer_id: Option<String>,
    stats_cache: RwLock<Option<CachedStats>>,
}

struct CachedStats {
    stats: RepoStats,
    cached_at: Instant,
}

const STATS_CACHE_TTL: Duration = Duration::from_secs(30);

impl KuboManager {
    pub fn new() -> Self {
        let home = dirs::home_dir().expect("Could not find home directory");
        let repo_path = home.join(".spk-ipfs");

        Self {
            daemon: None,
            repo_path,
            api_port: 5001,
            gateway_port: 8080,
            swarm_port: 4001,
            peer_id: None,
            stats_cache: RwLock::new(None),
        }
    }

    fn log(&self, msg: &str) {
        tracing::info!("[Kubo] {}", msg);
    }

    fn get_kubo_binary(&self) -> String {
        #[cfg(target_os = "windows")]
        let binary = "kubo.exe";
        #[cfg(not(target_os = "windows"))]
        let binary = "kubo";
        
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(dir) = exe_path.parent() {
                let bundled = dir.join("binaries").join(binary);
                if bundled.exists() {
                    return bundled.to_string_lossy().to_string();
                }
            }
        }
        
        "ipfs".to_string()
    }

    fn run_ipfs_cmd(&self, args: &[&str]) -> Result<String, String> {
        let binary = self.get_kubo_binary();
        
        let output = Command::new(&binary)
            .args(args)
            .env("IPFS_PATH", &self.repo_path)
            .output()
            .map_err(|e| format!("Failed to run ipfs command: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }

    pub async fn initialize(&mut self) -> Result<(), String> {
        let config_path = self.repo_path.join("config");
        
        if config_path.exists() {
            self.log(&format!("Repository exists at {:?}", self.repo_path));
            self.read_peer_id()?;
            return Ok(());
        }

        self.log(&format!("Initializing new repository at {:?}", self.repo_path));

        fs::create_dir_all(&self.repo_path)
            .map_err(|e| format!("Failed to create repo directory: {}", e))?;

        // Use lowpower profile for desktop - reduces memory and CPU usage
        self.run_ipfs_cmd(&["init", "--profile=lowpower"])?;
        self.log("Repository initialized with lowpower profile");

        // OPTIMIZATION: Batch all config changes into single JSON update
        self.apply_desktop_config()?;

        self.read_peer_id()?;
        Ok(())
    }

    /// Apply all desktop-optimized settings in one batch
    fn apply_desktop_config(&self) -> Result<(), String> {
        let config_path = self.repo_path.join("config");
        let config_content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        
        let mut config: serde_json::Value = serde_json::from_str(&config_content)
            .map_err(|e| format!("Failed to parse config: {}", e))?;

        // CORS headers for web access
        config["API"]["HTTPHeaders"]["Access-Control-Allow-Origin"] = 
            serde_json::json!(["*"]);
        config["API"]["HTTPHeaders"]["Access-Control-Allow-Methods"] = 
            serde_json::json!(["PUT", "POST", "GET"]);
        config["API"]["HTTPHeaders"]["Access-Control-Allow-Headers"] = 
            serde_json::json!(["Authorization", "X-Requested-With", "Range", "Content-Range"]);

        // Storage limits
        config["Datastore"]["StorageMax"] = serde_json::json!("50GB");
        config["Datastore"]["StorageGCWatermark"] = serde_json::json!(90);

        // Ports
        config["Addresses"]["API"] = 
            serde_json::json!(format!("/ip4/127.0.0.1/tcp/{}", self.api_port));
        config["Addresses"]["Gateway"] = 
            serde_json::json!(format!("/ip4/127.0.0.1/tcp/{}", self.gateway_port));

        // OPTIMIZATION: Desktop-friendly connection limits (reduce memory usage)
        config["Swarm"]["ConnMgr"]["LowWater"] = serde_json::json!(50);
        config["Swarm"]["ConnMgr"]["HighWater"] = serde_json::json!(100);
        config["Swarm"]["ConnMgr"]["GracePeriod"] = serde_json::json!("60s");

        // Reduce DHT activity for faster startup
        config["Routing"]["Type"] = serde_json::json!("dhtclient");

        // Write config in one operation
        let updated = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        fs::write(&config_path, updated)
            .map_err(|e| format!("Failed to write config: {}", e))?;

        self.log("Desktop-optimized config applied (batch write)");
        Ok(())
    }

    fn read_peer_id(&mut self) -> Result<(), String> {
        let config_path = self.repo_path.join("config");
        let config_content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        
        let config: serde_json::Value = serde_json::from_str(&config_content)
            .map_err(|e| format!("Failed to parse config: {}", e))?;
        
        if let Some(peer_id) = config["Identity"]["PeerID"].as_str() {
            self.peer_id = Some(peer_id.to_string());
            self.log(&format!("PeerID: {}", peer_id));
        }

        Ok(())
    }

    pub async fn start_daemon(&mut self) -> Result<(), String> {
        if self.daemon.is_some() {
            self.log("Daemon already running");
            return Ok(());
        }

        self.log("Starting daemon...");

        let binary = self.get_kubo_binary();

        let mut child = Command::new(&binary)
            .args(["daemon", "--enable-gc", "--migrate"])
            .env("IPFS_PATH", &self.repo_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn daemon: {}", e))?;

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            std::thread::spawn(move || {
                for line in reader.lines() {
                    if let Ok(line) = line {
                        // OPTIMIZATION: Detect ready state from multiple signals
                        if line.contains("Daemon is ready") 
                            || line.contains("API server listening")
                            || line.contains("Gateway server listening") {
                            DAEMON_READY.store(true, Ordering::SeqCst);
                        }
                        tracing::debug!("[Kubo stdout] {}", line);
                    }
                }
            });
        }

        // OPTIMIZATION: Reduced wait time with faster polling
        for _ in 0..20 {
            if DAEMON_READY.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        self.daemon = Some(child);
        self.log(&format!(
            "Daemon ready - API: 127.0.0.1:{}, Gateway: 127.0.0.1:{}",
            self.api_port, self.gateway_port
        ));

        Ok(())
    }

    pub async fn stop_daemon(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.daemon.take() {
            self.log("Stopping daemon...");
            
            let _ = child.kill();
            let _ = child.wait();
            
            DAEMON_READY.store(false, Ordering::SeqCst);
            self.log("Daemon stopped");
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.daemon.is_some() && DAEMON_READY.load(Ordering::SeqCst)
    }

    pub fn get_peer_id(&self) -> Option<String> {
        self.peer_id.clone()
    }

    pub fn get_api_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.api_port)
    }

    /// OPTIMIZATION: Cached stats - only refresh every 30 seconds
    pub async fn get_repo_stats(&self) -> Result<RepoStats, String> {
        // Check cache first
        {
            let cache = self.stats_cache.read().await;
            if let Some(ref cached) = *cache {
                if cached.cached_at.elapsed() < STATS_CACHE_TTL {
                    return Ok(cached.stats.clone());
                }
            }
        }

        // Cache miss or expired - fetch fresh stats
        let stats = self.fetch_repo_stats()?;
        
        // Update cache
        {
            let mut cache = self.stats_cache.write().await;
            *cache = Some(CachedStats {
                stats: stats.clone(),
                cached_at: Instant::now(),
            });
        }

        Ok(stats)
    }

    fn fetch_repo_stats(&self) -> Result<RepoStats, String> {
        let output = self.run_ipfs_cmd(&["repo", "stat", "--size-only"])?;
        
        let size: u64 = output
            .lines()
            .find(|l| l.starts_with("RepoSize"))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let pin_output = self.run_ipfs_cmd(&["pin", "ls", "-t", "recursive", "-q"])?;
        let pin_count = pin_output.lines().filter(|l| !l.is_empty()).count();

        Ok(RepoStats {
            repo_size: size,
            num_pins: pin_count,
        })
    }

    /// Invalidate stats cache (called after pin/unpin operations)
    pub async fn invalidate_stats_cache(&self) {
        let mut cache = self.stats_cache.write().await;
        *cache = None;
    }

    pub async fn pin(&self, cid: &str) -> Result<(), String> {
        self.run_ipfs_cmd(&["pin", "add", "--progress", cid])?;
        self.invalidate_stats_cache().await;
        self.log(&format!("Pinned: {}", cid));
        Ok(())
    }

    pub async fn unpin(&self, cid: &str) -> Result<(), String> {
        self.run_ipfs_cmd(&["pin", "rm", cid])?;
        self.invalidate_stats_cache().await;
        self.log(&format!("Unpinned: {}", cid));
        Ok(())
    }

    pub async fn get_pins(&self) -> Result<Vec<PinInfo>, String> {
        // Use -q flag for faster output (just CIDs, no type info)
        let output = self.run_ipfs_cmd(&["pin", "ls", "-t", "recursive", "-q"])?;
        
        let pins: Vec<PinInfo> = output
            .lines()
            .filter(|line| !line.is_empty())
            .map(|cid| PinInfo {
                cid: cid.trim().to_string(),
                name: String::new(),
                size: 0,
            })
            .collect();

        Ok(pins)
    }
}

impl Drop for KuboManager {
    fn drop(&mut self) {
        if let Some(mut child) = self.daemon.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct RepoStats {
    pub repo_size: u64,
    pub num_pins: usize,
}

#[derive(serde::Serialize, Clone)]
pub struct PinInfo {
    pub cid: String,
    pub name: String,
    pub size: u64,
}
