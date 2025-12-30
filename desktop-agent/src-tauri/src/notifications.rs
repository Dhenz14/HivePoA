use tauri::api::notification::Notification;

const APP_IDENTIFIER: &str = "com.spknetwork.desktop";

pub const MILESTONE_THRESHOLDS: [f64; 5] = [0.01, 0.1, 1.0, 10.0, 100.0];

pub fn send_challenge_notification(amount_hbd: f64) {
    let _ = Notification::new(APP_IDENTIFIER)
        .title("PoA Challenge Passed!")
        .body(&format!("+{:.4} HBD earned", amount_hbd))
        .show();
}

pub fn send_milestone_notification(total_earned: f64, milestone: f64) {
    let _ = Notification::new(APP_IDENTIFIER)
        .title("🎉 Milestone Reached!")
        .body(&format!("Total earned: {:.2} HBD", milestone.max(total_earned)))
        .show();
}

pub fn send_daily_summary_notification(daily_earnings: f64, challenge_count: u64) {
    let _ = Notification::new(APP_IDENTIFIER)
        .title("Daily Earnings Summary")
        .body(&format!(
            "Daily earnings: {:.4} HBD from {} challenges",
            daily_earnings, challenge_count
        ))
        .show();
}

pub fn check_milestone_crossed(old_total: f64, new_total: f64) -> Option<f64> {
    for threshold in MILESTONE_THRESHOLDS {
        if old_total < threshold && new_total >= threshold {
            return Some(threshold);
        }
    }
    None
}
