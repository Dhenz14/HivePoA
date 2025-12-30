/**
 * Auto-start on boot functionality
 * Platform-specific implementations for Windows, macOS, and Linux
 */

use std::env;
use std::fs;
use std::path::PathBuf;

/// Get the path to the current executable
fn get_executable_path() -> Result<PathBuf, String> {
    env::current_exe().map_err(|e| format!("Failed to get executable path: {}", e))
}

/// Enable auto-start on boot
pub fn enable_autostart() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return enable_autostart_windows();

    #[cfg(target_os = "macos")]
    return enable_autostart_macos();

    #[cfg(target_os = "linux")]
    return enable_autostart_linux();

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("Auto-start not supported on this platform".to_string())
}

/// Disable auto-start on boot
pub fn disable_autostart() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return disable_autostart_windows();

    #[cfg(target_os = "macos")]
    return disable_autostart_macos();

    #[cfg(target_os = "linux")]
    return disable_autostart_linux();

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("Auto-start not supported on this platform".to_string())
}

/// Check if auto-start is enabled
pub fn is_autostart_enabled() -> bool {
    #[cfg(target_os = "windows")]
    return is_autostart_enabled_windows();

    #[cfg(target_os = "macos")]
    return is_autostart_enabled_macos();

    #[cfg(target_os = "linux")]
    return is_autostart_enabled_linux();

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    false
}

// ============================================================================
// Windows Implementation
// ============================================================================

#[cfg(target_os = "windows")]
fn enable_autostart_windows() -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let exe_path = get_executable_path()?;
    let exe_str = exe_path.to_string_lossy();
    
    // Add --minimized flag to start hidden
    let command = format!("\"{}\" --minimized", exe_str);

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = hkcu
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            KEY_SET_VALUE,
        )
        .map_err(|e| format!("Failed to open Run registry key: {}", e))?;

    run_key
        .set_value("SPKDesktop", &command)
        .map_err(|e| format!("Failed to set registry value: {}", e))?;

    tracing::info!("[Autostart] Enabled Windows auto-start");
    Ok(())
}

#[cfg(target_os = "windows")]
fn disable_autostart_windows() -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = hkcu
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            KEY_SET_VALUE,
        )
        .map_err(|e| format!("Failed to open Run registry key: {}", e))?;

    match run_key.delete_value("SPKDesktop") {
        Ok(_) => {
            tracing::info!("[Autostart] Disabled Windows auto-start");
            Ok(())
        }
        Err(e) => {
            // If the value doesn't exist, that's fine
            if e.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(format!("Failed to delete registry value: {}", e))
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn is_autostart_enabled_windows() -> bool {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(run_key) = hkcu.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        KEY_READ,
    ) {
        run_key.get_value::<String, _>("SPKDesktop").is_ok()
    } else {
        false
    }
}

// ============================================================================
// macOS Implementation
// ============================================================================

#[cfg(target_os = "macos")]
fn get_launch_agent_path() -> PathBuf {
    let home = dirs::home_dir().expect("Could not find home directory");
    home.join("Library")
        .join("LaunchAgents")
        .join("network.spk.desktop.plist")
}

#[cfg(target_os = "macos")]
fn enable_autostart_macos() -> Result<(), String> {
    let exe_path = get_executable_path()?;
    let plist_path = get_launch_agent_path();

    // Ensure LaunchAgents directory exists
    if let Some(parent) = plist_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create LaunchAgents directory: {}", e))?;
    }

    // Create LaunchAgent plist with LSUIElement to hide from dock
    // and --minimized flag to start hidden
    let plist_content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>network.spk.desktop</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
        <string>--minimized</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>"#,
        exe_path.to_string_lossy()
    );

    fs::write(&plist_path, plist_content)
        .map_err(|e| format!("Failed to write LaunchAgent plist: {}", e))?;

    tracing::info!("[Autostart] Enabled macOS auto-start at {:?}", plist_path);
    Ok(())
}

#[cfg(target_os = "macos")]
fn disable_autostart_macos() -> Result<(), String> {
    let plist_path = get_launch_agent_path();

    if plist_path.exists() {
        fs::remove_file(&plist_path)
            .map_err(|e| format!("Failed to remove LaunchAgent plist: {}", e))?;
        tracing::info!("[Autostart] Disabled macOS auto-start");
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn is_autostart_enabled_macos() -> bool {
    get_launch_agent_path().exists()
}

// ============================================================================
// Linux Implementation
// ============================================================================

#[cfg(target_os = "linux")]
fn get_autostart_desktop_path() -> PathBuf {
    let home = dirs::home_dir().expect("Could not find home directory");
    home.join(".config")
        .join("autostart")
        .join("spk-desktop.desktop")
}

#[cfg(target_os = "linux")]
fn enable_autostart_linux() -> Result<(), String> {
    let exe_path = get_executable_path()?;
    let desktop_path = get_autostart_desktop_path();

    // Ensure autostart directory exists
    if let Some(parent) = desktop_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create autostart directory: {}", e))?;
    }

    // Create .desktop file with StartupWMClass and --minimized flag
    let desktop_content = format!(
        r#"[Desktop Entry]
Type=Application
Name=SPK Desktop
Comment=SPK Network Desktop Agent
Exec="{}" --minimized
Icon=spk-desktop
Terminal=false
Categories=Network;
StartupNotify=false
X-GNOME-Autostart-enabled=true
"#,
        exe_path.to_string_lossy()
    );

    fs::write(&desktop_path, desktop_content)
        .map_err(|e| format!("Failed to write desktop file: {}", e))?;

    tracing::info!("[Autostart] Enabled Linux auto-start at {:?}", desktop_path);
    Ok(())
}

#[cfg(target_os = "linux")]
fn disable_autostart_linux() -> Result<(), String> {
    let desktop_path = get_autostart_desktop_path();

    if desktop_path.exists() {
        fs::remove_file(&desktop_path)
            .map_err(|e| format!("Failed to remove desktop file: {}", e))?;
        tracing::info!("[Autostart] Disabled Linux auto-start");
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn is_autostart_enabled_linux() -> bool {
    get_autostart_desktop_path().exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_executable_path() {
        assert!(get_executable_path().is_ok());
    }
}
