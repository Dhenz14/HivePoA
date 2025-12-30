/**
 * Kubo Manager - Rust Port
 * Repurposed from server/services/ipfs-manager.ts and SPK Network's trole patterns
 * 
 * Handles: auto-init, CORS config, daemon lifecycle, graceful shutdown
 */

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static DAEMON_READY: AtomicBool = AtomicBool::new(false);

pub struct KuboManager {
    daemon: Option<Child>,
    repo_path: PathBuf,
    api_port: u16,
    gateway_port: u16,
    swarm_port: u16,
    peer_id: Option<String>,
}

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
        }
    }

    fn log(&self, msg: &str) {
        tracing::info!("[Kubo] {}", msg);
    }

    fn error(&self, msg: &str) {
        tracing::error!("[Kubo] {}", msg);
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

        self.run_ipfs_cmd(&["init", "--profile=server"])?;
        self.log("Repository initialized");

        self.run_ipfs_cmd(&[
            "config", "--json",
            "API.HTTPHeaders.Access-Control-Allow-Origin",
            r#"["*"]"#
        ])?;
        self.run_ipfs_cmd(&[
            "config", "--json",
            "API.HTTPHeaders.Access-Control-Allow-Methods",
            r#"["PUT", "POST", "GET"]"#
        ])?;
        self.run_ipfs_cmd(&[
            "config", "--json",
            "API.HTTPHeaders.Access-Control-Allow-Headers",
            r#"["Authorization", "X-Requested-With", "Range", "Content-Range"]"#
        ])?;
        self.log("CORS configured");

        self.run_ipfs_cmd(&["config", "Datastore.StorageMax", "50GB"])?;
        self.run_ipfs_cmd(&["config", "--json", "Datastore.StorageGCWatermark", "90"])?;
        self.log("Storage limits set (50GB)");

        self.run_ipfs_cmd(&[
            "config", "Addresses.API",
            &format!("/ip4/127.0.0.1/tcp/{}", self.api_port)
        ])?;
        self.run_ipfs_cmd(&[
            "config", "Addresses.Gateway",
            &format!("/ip4/127.0.0.1/tcp/{}", self.gateway_port)
        ])?;
        self.log("Ports configured");

        self.read_peer_id()?;

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
            .args(["daemon", "--enable-gc"])
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
                        if line.contains("Daemon is ready") || line.contains("API server listening") {
                            DAEMON_READY.store(true, Ordering::SeqCst);
                        }
                        tracing::debug!("[Kubo stdout] {}", line);
                    }
                }
            });
        }

        for _ in 0..30 {
            if DAEMON_READY.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
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

    pub async fn get_repo_stats(&self) -> Result<RepoStats, String> {
        let output = self.run_ipfs_cmd(&["repo", "stat", "--size-only"])?;
        
        let size: u64 = output
            .lines()
            .find(|l| l.starts_with("RepoSize"))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let pin_output = self.run_ipfs_cmd(&["pin", "ls", "-t", "recursive"])?;
        let pin_count = pin_output.lines().count();

        Ok(RepoStats {
            repo_size: size,
            num_pins: pin_count,
        })
    }

    pub async fn pin(&self, cid: &str) -> Result<(), String> {
        self.run_ipfs_cmd(&["pin", "add", cid])?;
        self.log(&format!("Pinned: {}", cid));
        Ok(())
    }

    pub async fn unpin(&self, cid: &str) -> Result<(), String> {
        self.run_ipfs_cmd(&["pin", "rm", cid])?;
        self.log(&format!("Unpinned: {}", cid));
        Ok(())
    }

    pub async fn get_pins(&self) -> Result<Vec<PinInfo>, String> {
        let output = self.run_ipfs_cmd(&["pin", "ls", "-t", "recursive"])?;
        
        let pins: Vec<PinInfo> = output
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 1 {
                    Some(PinInfo {
                        cid: parts[0].to_string(),
                        name: String::new(),
                        size: 0,
                    })
                } else {
                    None
                }
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
