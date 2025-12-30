#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod kubo;
mod api;
mod autostart;
mod notifications;

use std::sync::Arc;
use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem,
};
use tokio::sync::RwLock;

pub struct AppState {
    pub kubo: Arc<RwLock<kubo::KuboManager>>,
}

fn main() {
    tracing_subscriber::fmt::init();

    // Check if started with --minimized flag (auto-start on boot)
    let start_minimized = std::env::args().any(|arg| arg == "--minimized");

    let quit = CustomMenuItem::new("quit".to_string(), "Quit SPK Desktop");
    let show = CustomMenuItem::new("show".to_string(), "Show Dashboard");
    let status = CustomMenuItem::new("status".to_string(), "Status: Starting...").disabled();

    let tray_menu = SystemTrayMenu::new()
        .add_item(status)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(show)
        .add_item(quit);

    let system_tray = SystemTray::new().with_menu(tray_menu);

    let kubo_manager = Arc::new(RwLock::new(kubo::KuboManager::new()));

    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "quit" => {
                    std::process::exit(0);
                }
                "show" => {
                    if let Some(window) = app.get_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            },
            _ => {}
        })
        .manage(AppState {
            kubo: kubo_manager.clone(),
        })
        .setup(move |app| {
            let kubo = kubo_manager.clone();
            let kubo_for_api = kubo_manager.clone();
            let handle = app.handle();

            // If started with --minimized, hide the window immediately
            if start_minimized {
                if let Some(window) = app.get_window("main") {
                    let _ = window.hide();
                    tracing::info!("[Startup] Started minimized to tray");
                }
            }

            // OPTIMIZATION: Start API server FIRST (instant detection)
            // Then initialize daemon in parallel
            tauri::async_runtime::spawn(async move {
                // Start API immediately - web app can detect us even before daemon is ready
                if let Err(e) = api::start_api_server(kubo_for_api).await {
                    tracing::error!("Failed to start API server: {}", e);
                }
            });

            tauri::async_runtime::spawn(async move {
                let start = std::time::Instant::now();
                
                {
                    let mut manager = kubo.write().await;

                    if let Err(e) = manager.initialize().await {
                        tracing::error!("Failed to initialize Kubo: {}", e);
                        return;
                    }

                    if let Err(e) = manager.start_daemon().await {
                        tracing::error!("Failed to start Kubo daemon: {}", e);
                        return;
                    }
                }

                let elapsed = start.elapsed();
                tracing::info!("[Startup] Daemon ready in {:?}", elapsed);

                // Update tray status
                let manager = kubo.read().await;
                if let Some(tray) = handle.tray_handle_by_id("main") {
                    let peer_id = manager.get_peer_id().unwrap_or_default();
                    let short_id = if peer_id.len() > 12 {
                        format!("{}...{}", &peer_id[..6], &peer_id[peer_id.len()-6..])
                    } else {
                        peer_id
                    };
                    let _ = tray.get_item("status").set_title(&format!("Online: {}", short_id));
                }
            });

            Ok(())
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                event.window().hide().unwrap();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
