//! DeviceTally menu-bar / tray app (Milestone 12, docs/dev/PLAN-desktop.md).
//! Shows token counts from your own DeviceTally server; never prompts. The owner session token is kept in
//! a file only the user can read (see session_path), and "Add this device" runs the bundled Go agent.

mod activity;
mod lock;
mod menubar;
mod net;
mod netx;
#[cfg(target_os = "macos")]
mod notify;
mod storage;
#[cfg(target_os = "macos")]
mod symbols;
mod stats;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_positioner::{Position, WindowExt};

const TRAY_ID: &str = "main";

#[derive(Default, Serialize, Deserialize, Clone)]
struct Config {
    server: String,
    #[serde(default)]
    menubar: menubar::MenuBar,
    /// A Dock icon too (macOS); off by default: opened from the menu bar.
    #[serde(default)]
    show_in_dock: bool,
    /// The version that last reset the menu bar to a readable look (see MenuBar::make_visible).
    #[serde(default)]
    menubar_reset: String,
}

/// Bumped when the menu bar should be reset to a readable look once, at the first start of a version.
const MENUBAR_RESET: &str = "1.6.1";

struct AppState {
    config: Mutex<Config>,
    http: reqwest::Client,
    // The session token, loaded from session.json at startup and kept in memory.
    token: Mutex<Option<Option<String>>>,
    // This machine's agent (server + device key), if it is connected. Without an admin login the app
    // shows only this device, using the device key, so one machine never sees another's usage.
    agent: Mutex<Option<(String, String)>>,
    // Menu bar: system counters, today's tokens (refreshed every 5 min) and the last drawn image.
    sampler: Mutex<stats::Sampler>,
    // Latest reading, reused by the Settings preview so it never takes its own samples.
    last_stats: Mutex<stats::Stats>,
    tokens_today: Mutex<Option<String>>,
    // Claude Code status dot: when the popover was last opened (clears "done"), and the last dot
    // (a change to done or waiting can play a sound).
    activity_seen: Mutex<i64>,
    // Each session's last state, to alert once per change (None until the first look).
    seen_sessions: Mutex<Option<activity::Seen>>,
    // Disk alert level already announced (0, 80 or 90), so each is announced once.
    disk_alerted: Mutex<u8>,
    /// Admin: device problems already notified (None until the first check, which only notes them).
    device_alerted: Mutex<Option<std::collections::HashSet<String>>>,
    // While an agent is working on mains power the ring turns (FRAME_MS); system counters are
    // still read at most every 2 s.
    animating: std::sync::atomic::AtomicBool,
    // Agent status from the last full redraw: the ring's frames in between reuse it.
    agent_now: Mutex<(menubar::Agent, u8)>,
    // CPU temperature and when it was read: reading every sensor costs, and it changes slowly.
    temp: Mutex<Option<(std::time::Instant, Option<f32>)>>,
    card_id: std::sync::atomic::AtomicI64,
    last_sample: Mutex<Option<std::time::Instant>>,
    // Separate menu-bar items (one per module, macOS): which exist, in order, and their last images.
    tray_items: Mutex<Vec<String>>,
    // Finished agent tasks, newest first (last 100), kept in ~/.devicetally.
    agent_log: Mutex<Vec<activity::Finished>>,
    update_error: Mutex<Option<String>>,
    // Battery: charging at the last redraw, and when it last changed (for the charger animation).
    battery_change: Mutex<(Option<bool>, Option<std::time::Instant>)>,
    battery_moving: std::sync::atomic::AtomicBool,
    // Network panel: connectivity checks, apps using the network, totals reset point, public address.
    connectivity: Mutex<net::Connectivity>,
    net_apps: Mutex<net::Apps>,
    net_base: Mutex<(u64, u64)>,
    public_ip: Mutex<Option<(std::time::Instant, Value)>>,
    net_wanted: Mutex<Option<std::time::Instant>>,
    item_icons: Mutex<std::collections::HashMap<String, (Vec<u8>, bool)>>, // image, template
    // Which panel the popover shows ("all" for the combined item).
    panel: Mutex<String>,
    // Recent readings for the panels' graphs (about 3 minutes).
    history: Mutex<std::collections::VecDeque<stats::Point>>,
}

impl AppState {
    fn token(&self, _server: &str) -> Option<String> {
        self.token.lock().unwrap().clone().flatten()
    }
    fn set_token(&self, v: Option<String>) {
        *self.token.lock().unwrap() = Some(v);
    }
}

fn config_path(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default().join("config.json")
}

fn load_config(app: &AppHandle) -> Config {
    let mut cfg: Config = std::fs::read(config_path(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    // Once per MENUBAR_RESET: items left in a fixed colour (e.g. by the removed themes) could vanish
    // against the menu bar; start from a look that's always readable.
    if cfg.menubar_reset != MENUBAR_RESET {
        cfg.menubar.make_visible();
        cfg.menubar_reset = MENUBAR_RESET.into();
        let _ = save_config(app, &cfg);
    }
    cfg
}

fn save_config(app: &AppHandle, c: &Config) -> Result<(), String> {
    let p = config_path(app);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, serde_json::to_vec_pretty(c).unwrap()).map_err(|e| e.to_string())
}

// Why not the OS keychain: without a paid Apple Developer ID the app is ad-hoc signed, so macOS
// can't remember "Always Allow" and asks for the login password again and again (seen 2026-10-03).
// The token lives in the app's config folder with owner-only permissions (0600) instead.
fn session_path(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default().join("session.json")
}

/// All saved admin logins: server -> session token. Reads the older single-login format too.
fn read_sessions(app: &AppHandle) -> serde_json::Map<String, Value> {
    let Some(v) = std::fs::read(session_path(app)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return Default::default() };
    if let Some(m) = v["sessions"].as_object() {
        return m.clone();
    }
    match (v["server"].as_str(), v["token"].as_str()) {
        (Some(s), Some(t)) => [(s.to_string(), Value::String(t.to_string()))].into_iter().collect(),
        _ => Default::default(),
    }
}

fn read_session(app: &AppHandle, server: &str) -> Option<String> {
    read_sessions(app).get(server)?.as_str().map(String::from)
}

fn write_session(app: &AppHandle, server: &str, token: Option<&str>) -> Result<(), String> {
    let mut all = read_sessions(app);
    match token {
        Some(t) => all.insert(server.to_string(), Value::String(t.to_string())),
        None => all.remove(server),
    };
    let p = session_path(app);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let body = serde_json::to_vec(&serde_json::json!({ "sessions": all })).unwrap();
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    opts.open(&p).and_then(|mut f| f.write_all(&body)).map_err(|e| e.to_string())
}

/// Saved admin servers and the current one (Settings → Servers).
#[tauri::command]
fn servers(app: AppHandle, state: State<'_, AppState>) -> Value {
    serde_json::json!({ "current": state.config.lock().unwrap().server, "saved": read_sessions(&app).keys().collect::<Vec<_>>() })
}

#[tauri::command]
async fn switch_server(app: AppHandle, state: State<'_, AppState>, server: String) -> Result<(), String> {
    let token = read_session(&app, &server).ok_or("Not signed in to that server.")?;
    let cfg = Config { server, ..state.config.lock().unwrap().clone() };
    save_config(&app, &cfg)?;
    *state.config.lock().unwrap() = cfg;
    state.set_token(Some(token));
    refresh_tray(&app).await;
    Ok(())
}

/// Menu-bar form: at most 3 significant characters, rounded (owner: "a lump sum, very small space").
/// 150_660_000 -> "151M", 1_726_320 -> "1.7M", 12_400 -> "12K", 950 -> "950".
fn fmt_short(n: f64) -> String {
    let (v, unit) = if n >= 1e9 { (n / 1e9, "B") } else if n >= 1e6 { (n / 1e6, "M") } else if n >= 1e3 { (n / 1e3, "K") } else { (n, "") };
    if unit.is_empty() || v >= 10.0 || (v * 10.0).round() / 10.0 == v.round() {
        format!("{}{unit}", v.round() as u64)
    } else {
        format!("{:.1}{unit}", v)
    }
}


/// Admin signed in: every device. Otherwise this machine's own usage via its device key.
async fn get_summary(state: &AppState, range: &str) -> Result<Value, String> {
    let server = state.config.lock().unwrap().server.clone();
    let admin = (!server.is_empty()).then(|| state.token(&server)).flatten();
    let agent = state.agent.lock().unwrap().clone();
    let req = match (admin, agent) {
        (Some(token), _) => state.http.get(format!("{server}/api/summary?range={range}")).header("cookie", format!("dt_session={token}")),
        (None, Some((agent_server, key))) => state.http.get(format!("{agent_server}/api/v1/summary?range={range}")).bearer_auth(key),
        (None, None) if local_mode(state) => {
            let days = match range { "30d" => "30", "7d" => "7", _ => "1" };
            return run_tracker(vec!["usage".into(), "summary".into(), days.into()]).await;
        }
        (None, None) => return Err("not_set_up".into()),
    };
    let admin_mode = state.token(&server).is_some();
    let res = req.send().await.map_err(|_| "offline".to_string())?;
    if res.status() == 401 {
        if admin_mode {
            state.set_token(None);
            return Err("signed_out".into());
        }
        return Err("device_revoked".into());
    }
    if !res.status().is_success() {
        let code = res.status().as_u16();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        return Err(v["error"].as_str().map(String::from).unwrap_or(format!("server_{code}")));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Menu-bar text (macOS) and tooltip (all platforms): today's tokens.
/// Refreshes today's tokens (every 5 minutes and after sign-in/connect), then redraws the menu bar.
async fn refresh_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    // As in the panel: this computer's own count when the server can't answer.
    let today = match get_summary(&state, "today").await {
        Err(e) if server_down(&e) && state.agent.lock().unwrap().is_some() => run_tracker(vec!["usage".into(), "summary".into(), "1".into()]).await.ok(),
        r => r.ok(),
    };
    let tokens = today.map(|s| fmt_short(s["tokens"].as_f64().unwrap_or(0.0)));
    *state.tokens_today.lock().unwrap() = tokens;
    draw_menubar(app);
}

/// Shows a banner and/or plays a sound for an alert, as configured. With a banner the sound plays
/// as part of it, so macOS Focus / Do Not Disturb silences both.
fn give_alert(app: &AppHandle, cfg: &menubar::Alerts, a: &activity::Alert) {
    let banner = if a.waiting { cfg.wait_banner } else { cfg.done_banner };
    let sound = cfg.sound(a.waiting);
    if banner {
        notify_user(app, &a.title, &a.body, sound);
    } else if let Some(s) = sound {
        play_sound(s);
    }
}

/// A system notification. macOS: DeviceTally's own sender (shows even while DeviceTally is in front);
/// elsewhere the notification plugin.
fn notify_user(app: &AppHandle, title: &str, body: &str, sound: Option<&str>) {
    #[cfg(target_os = "macos")]
    notify_mac(app, title, body, sound, |_| {});
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let mut n = app.notification().builder().title(title).body(body);
        if let Some(s) = sound {
            n = n.sound(s);
        }
        let _ = n.show();
    }
}

/// A notification when the disk passes 80% and 90% full (once each, until it drops back).
fn disk_check(app: &AppHandle) {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().menubar.alerts.clone();
    let s = state.sampler.lock().unwrap().sample();
    if s.disk_total == 0 {
        return;
    }
    let level = storage::alert_level(1.0 - s.disk_free as f64 / s.disk_total as f64);
    let mut done = state.disk_alerted.lock().unwrap();
    if cfg.disk_alert && level > *done {
        notify_user(app, &format!("Disk {level}% full"), &format!("{} free. Open DeviceTally → Storage to see what's using space.", stats::bytes(s.disk_free)), cfg.sound(true));
    }
    *done = level;
}

/// Admin: a notification when a computer shows a new sign of tracking being blocked or removed.
async fn device_check(app: &AppHandle) {
    let state = app.state::<AppState>();
    let server = state.config.lock().unwrap().server.clone();
    let Some(token) = (!server.is_empty()).then(|| state.token(&server)).flatten() else { return };
    let Ok(res) = state.http.get(format!("{server}/api/devices")).header("cookie", format!("dt_session={token}")).send().await else { return };
    let Ok(devices) = res.json::<Value>().await else { return };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let found = device_alerts(&devices, now);
    let new: Vec<_> = {
        let mut seen = state.device_alerted.lock().unwrap();
        let new = match seen.as_ref() {
            Some(s) => found.iter().filter(|(k, ..)| !s.contains(k)).cloned().collect(),
            None => vec![], // problems already there at start are shown in the window, not notified
        };
        *seen = Some(found.iter().map(|(k, ..)| k.clone()).collect());
        new
    };
    let sound = state.config.lock().unwrap().menubar.alerts.sound(true).map(String::from);
    for (_, title, body) in new.into_iter().take(3) {
        notify_user(app, &title, &body, sound.as_deref());
    }
}

/// (key, title, body) for each tracking problem in the admin's device list: blocks, missing hooks,
/// pause, and events from the last day (a lost internet connection isn't one).
fn device_alerts(devices: &Value, now: i64) -> Vec<(String, String, String)> {
    let mut out = vec![];
    for d in devices.as_array().into_iter().flatten().filter(|d| d["revoked_at"].is_null()) {
        let (id, name, h) = (d["id"].as_str().unwrap_or(""), d["name"].as_str().unwrap_or("A computer"), &d["health"]);
        let mut add = |key: String, body: &str| out.push((format!("{id}:{key}"), name.to_string(), body.to_string()));
        if h["server_blocked"].as_bool() == Some(true) {
            add("blocked".into(), "DeviceTally's server is blocked in its hosts file (usage still gets through).");
        } else if h["dns_routed"].as_bool() == Some(true) {
            add("dns".into(), "DNS on this computer blocks DeviceTally's server (usage still gets through).");
        }
        if h["hooks"].as_str() == Some("missing") {
            add("hooks".into(), "Claude Code tracking hooks are missing.");
        }
        if h["paused"].as_bool() == Some(true) {
            add("paused".into(), "Tracking is paused.");
        }
        for e in h["events"].as_array().into_iter().flatten() {
            let (at, text) = (e["at"].as_i64().unwrap_or(0), e["text"].as_str().unwrap_or(""));
            if now - at < 86_400_000 && !text.contains("no internet connection") {
                add(format!("ev:{at}:{}", e["kind"].as_str().unwrap_or("")), text);
            }
        }
    }
    out
}

/// Storage on this computer (read-only), for the Storage tab.
#[tauri::command]
async fn storage_scan() -> Result<Value, String> {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    tokio::task::spawn_blocking(move || {
        let full = storage::full_access(&home);
        serde_json::json!({ "full_access": full, "items": storage::scan(&home, full) })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Opens Privacy & Security → Full Disk Access, where DeviceTally can be turned on once.
#[tauri::command]
async fn open_full_disk_access(app: AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles", None::<&str>).map_err(|e| e.to_string())
}

/// Moves a cache folder to the Bin (recoverable until the Bin is emptied). Only what
/// storage::may_trash allows; the UI asks for confirmation first.
#[tauri::command]
async fn trash_path(path: String) -> Result<(), String> {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let p = PathBuf::from(&path);
    if !storage::may_trash(&home, &p) || !p.exists() {
        return Err("This folder can't be moved to the Bin from DeviceTally. Use Show in Finder.".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSFileManager, NSString, NSURL};
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
        NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None).map_err(|e| e.localizedDescription().to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux: the desktop's Trash (gio, part of GLib on GNOME, KDE, XFCE…), so it can be restored.
        let ok = std::process::Command::new("gio").args(["trash", "--"]).arg(&p).status().map(|s| s.success()).unwrap_or(false);
        if ok { Ok(()) } else { Err("Couldn't move it to the Trash here. Use Show in Finder and delete it from your file manager.".into()) }
    }
}

/// Shows a file or folder in Finder (Explorer on Windows). Only paths inside the home folder.
#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let p = PathBuf::from(&path);
    if !p.starts_with(&home) || path.contains("..") || !p.exists() {
        return Err("not_found".into());
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(windows)]
    let r = std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn();
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let r = std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(&p)).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Opens System Settings → Notifications (macOS), to allow DeviceTally's banners.
#[tauri::command]
fn open_notification_settings() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension").spawn();
}

/// Settings → Agent status: try the current alerts.
#[tauri::command]
async fn test_alert(app: AppHandle, state: State<'_, AppState>, waiting: bool) -> Result<String, String> {
    let cfg = state.config.lock().unwrap().menubar.alerts.clone();
    let a = if waiting {
        activity::Alert { waiting: true, title: "Claude Code needs you".into(), body: "devicetally · a permission or a question (test)".into() }
    } else {
        activity::Alert { waiting: false, title: "Claude Code finished".into(), body: "devicetally · took 3 min (test)".into() }
    };
    // With a notification: send it and say how it was shown (macOS's own, or DeviceTally's card).
    let banner = if waiting { cfg.wait_banner } else { cfg.done_banner };
    #[cfg(target_os = "macos")]
    if banner {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Mutex::new(Some(tx));
        notify_mac(&app, &a.title, &a.body, cfg.sound(waiting), move |r| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(r);
            }
        });
        return Ok(rx.await.unwrap_or("card").into());
    }
    give_alert(&app, &cfg, &a);
    Ok("shown".into())
}

/// Folders macOS looks in for alert sounds, the user's own first (same order as notifications use).
fn sound_dirs() -> Vec<PathBuf> {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    vec![home.join("Library/Sounds"), PathBuf::from("/Library/Sounds"), PathBuf::from("/System/Library/Sounds")]
}

/// Every alert sound on this Mac: the system's and any the user added to ~/Library/Sounds.
#[tauri::command]
async fn list_sounds() -> Result<Vec<String>, String> {
    let mut names: Vec<String> = vec![];
    for dir in sound_dirs() {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| ["aiff", "aif", "wav", "caf", "m4a", "mp3"].contains(&x.to_string_lossy().to_lowercase().as_str())) {
                if let Some(n) = p.file_stem().map(|n| n.to_string_lossy().into_owned()) {
                    if !names.contains(&n) {
                        names.push(n);
                    }
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
async fn preview_sound(name: String) -> Result<(), String> {
    if !name.is_empty() && !name.contains('/') && !name.contains("..") {
        play_sound(&name);
    }
    Ok(())
}

/// macOS: Apple's notification system when macOS allows it (a Developer ID–signed build); otherwise
/// DeviceTally's own notification card. `result` gets "system" or "card".
#[cfg(target_os = "macos")]
fn notify_mac(app: &AppHandle, title: &str, body: &str, sound: Option<&str>, result: impl Fn(&'static str) + Send + Sync + 'static) {
    let (t, b, s) = (title.to_string(), body.to_string(), sound.map(String::from));
    let app2 = app.clone();
    notify::send(title, body, sound, move |r| {
        if r.is_ok() {
            return result("system");
        }
        // macOS refuses notifications from apps without a paid signature: show our own card.
        show_card(&app2, &t, &b);
        if let Some(s) = &s {
            play_sound(s);
        }
        result("card");
    });
}

/// DeviceTally's own notification: a small card at the top right, over any app (even full screen),
/// gone after 6 s; a click opens DeviceTally.
fn show_card(app: &AppHandle, title: &str, body: &str) {
    show_card_as(app, title, body, "", 6);
}

/// A card of a kind ("" plain, "update" with Update now / Later), shown for `secs` seconds.
fn show_card_as(app: &AppHandle, title: &str, body: &str, kind: &str, secs: u64) {
    let pct = |s: &str| s.bytes().map(|c| if c.is_ascii_alphanumeric() { (c as char).to_string() } else { format!("%{c:02X}") }).collect::<String>();
    let (title, body) = (title.to_string(), body.to_string());
    let kind = kind.to_string();
    let payload = serde_json::json!({ "title": &title, "body": &body, "kind": &kind, "id": now_ms() });
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let w = match app2.get_webview_window("card") {
            Some(w) => w,
            None => {
                let Ok(w) = WebviewWindowBuilder::new(&app2, "card", WebviewUrl::App(format!("index.html?view=card&t={}&b={}&k={}", pct(&title), pct(&body), pct(&kind)).into()))
                    .title("DeviceTally")
                    .inner_size(356.0, 76.0)
                    .decorations(false)
                    .transparent(true)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focused(false)
                    .visible(false)
                    .shadow(true)
                    .build()
                else {
                    return;
                };
                #[cfg(target_os = "macos")]
                on_every_desktop(&w);
                w
            }
        };
        // Top right, just under the menu bar, like a Mac notification.
        if let Ok(Some(m)) = w.current_monitor() {
            let sf = m.scale_factor();
            let size = m.size().to_logical::<f64>(sf);
            let _ = w.set_position(tauri::LogicalPosition::new(size.width - 356.0 - 12.0, 36.0));
        }
        let _ = w.emit("dt:card", payload.clone());
        let _ = w.show();
        let id = payload["id"].as_i64().unwrap_or(0);
        let w2 = w.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            // Hide unless a newer card replaced it.
            let latest = w2.app_handle().state::<AppState>().card_id.load(std::sync::atomic::Ordering::Relaxed);
            if latest == id {
                let _ = w2.hide();
            }
        });
        app2.state::<AppState>().card_id.store(id, std::sync::atomic::Ordering::Relaxed);
    });
}

/// A card from the page: "update" (Update now / Later, stays a minute) or a plain one.
#[tauri::command]
fn show_notice(app: AppHandle, title: String, body: String, kind: String) {
    show_card_as(&app, &title, &body, &kind, if kind == "update" { 60 } else { 8 });
}

/// The update card's buttons: tells the popover (which runs the updater) what was chosen.
#[tauri::command]
fn card_update(app: AppHandle, install: bool) {
    if let Some(w) = app.get_webview_window("card") {
        let _ = w.hide();
    }
    let _ = app.emit("dt:update-choice", install);
}

/// Whether someone is using DeviceTally right now (its window or panel is open): updates wait.
#[tauri::command]
fn in_use(app: AppHandle) -> bool {
    ["main", "popover"].iter().any(|l| app.get_webview_window(l).is_some_and(|w| w.is_visible().unwrap_or(false)))
}

/// How this computer should update, as the admin set it: ("ask" | "auto", update-now time in ms).
/// The device's own setting wins over the global one. Read with this computer's device key.
#[tauri::command]
async fn update_policy(state: State<'_, AppState>) -> Result<(String, i64), String> {
    let Some((server, key)) = state.agent.lock().unwrap().clone() else { return Ok(("auto".into(), 0)) };
    let v: Value = state.http.get(format!("{server}/api/v1/config")).bearer_auth(&key).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    Ok(policy_of(&v))
}

fn policy_of(config: &Value) -> (String, i64) {
    let me = config["device_id"].as_str().unwrap_or_default();
    let rows = config["settings"].as_array().cloned().unwrap_or_default();
    let row = |scope: &str, id: &str| rows.iter().find(|r| r["scope"] == scope && r["scope_id"].as_str().unwrap_or_default() == id).map(|r| r["json"].clone());
    let (global, device) = (row("global", ""), row("device", me));
    let mode = [&device, &global].iter().find_map(|r| r.as_ref().and_then(|j| j["app_updates"].as_str().map(String::from))).unwrap_or_else(|| "auto".into());
    let now = device.as_ref().and_then(|j| j["update_now"].as_i64()).unwrap_or(0);
    // Automatic unless the admin chose "ask": joined computers keep themselves up to date.
    (if mode == "ask" { mode } else { "auto".into() }, now)
}

/// The last failed update (e.g. a Mac account that can't change Applications), sent with the
/// check-in so the admin sees it. None clears it.
#[tauri::command]
fn report_update_error(state: State<'_, AppState>, error: Option<String>) {
    *state.update_error.lock().unwrap() = error;
}

/// The card's click and close.
#[tauri::command]
fn card_action(app: AppHandle, open: bool) {
    if let Some(w) = app.get_webview_window("card") {
        let _ = w.hide();
    }
    if open {
        let _ = show_main(&app, "overview");
    }
}

/// An alert sound by name (macOS), from the user's or the system's sound folders, without blocking.
fn play_sound(name: &str) {
    #[cfg(target_os = "macos")]
    {
        let file = sound_dirs().into_iter().flat_map(|d| std::fs::read_dir(d).into_iter().flatten().flatten()).map(|e| e.path()).find(|p| p.file_stem().is_some_and(|n| n == name));
        if let Some(f) = file {
            let _ = std::process::Command::new("afplay").arg(f).spawn();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = name;
}

/// Tells the server this computer is up (its config request records "last seen"), so the admin can
/// tell an idle computer from a disconnected one even when Claude Code isn't in use.
async fn heartbeat(app: &AppHandle) {
    let state = app.state::<AppState>();
    let agent = state.agent.lock().unwrap().clone();
    let Some((server, key)) = agent else { return };
    // What the tracker last wrote (hooks, removed transcripts, other settings folders), plus whether
    // tracking is paused, whether this computer is locked, and its disk.
    let dir = agent_dir();
    let mut health: Value = std::fs::read(dir.join("health.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(serde_json::json!({}));
    let paused = std::fs::read(dir.join("state.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).is_some_and(|v| v["paused"] == true);
    let disk = state.sampler.lock().unwrap().sample();
    if let Some(h) = health.as_object_mut() {
        h.insert("paused".into(), paused.into());
        h.insert("locked".into(), lock::is_locked().into());
        h.insert("disk_free".into(), disk.disk_free.into());
        h.insert("disk_total".into(), disk.disk_total.into());
        h.insert("app".into(), env!("CARGO_PKG_VERSION").into());
        h.insert("os".into(), std::env::consts::OS.into());
        // Always sent (null when fine): the server merges reports, so a left-out key would keep an
        // old error forever.
        h.insert("update_error".into(), state.update_error.lock().unwrap().clone().map(Value::String).unwrap_or(Value::Null));
    }
    let res = state.http.post(format!("{server}/api/v1/health")).bearer_auth(&key).json(&health).send().await;
    // Servers before 0.10 have no /health; their config request still records "last seen".
    if res.map(|r| r.status().as_u16() == 404).unwrap_or(false) {
        let _ = state.http.get(format!("{server}/api/v1/config")).bearer_auth(key).send().await;
    }
}

/// Settings → Lock this computer: is it locked?
#[tauri::command]
async fn lock_status() -> Result<Value, String> {
    let locked = lock::is_locked();
    // The system copy only changes when relocking; after an app update it may be older.
    let bundled = std::env::current_exe().ok().map(|e| e.with_file_name("devicetally")).and_then(|p| std::fs::read(p).ok());
    let outdated = locked && bundled.is_some_and(|b| std::fs::read(lock::BIN).ok().is_some_and(|s| s != b));
    Ok(serde_json::json!({ "locked": locked, "outdated": outdated, "supported": cfg!(target_os = "macos") }))
}

/// Locks this computer (admin, macOS): the tracker into a system folder and DeviceTally's hooks into
/// Claude Code's system-wide settings. macOS asks for an administrator's password.
#[tauri::command]
async fn lock_computer(app: AppHandle, state: State<'_, AppState>, only_ours: bool, block_skip: bool) -> Result<(), String> {
    let server = state.config.lock().unwrap().server.clone();
    if state.token(&server).is_none() {
        return Err("Sign in as admin first.".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, only_ours, block_skip);
        return Err("Locking is available on macOS for now.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let agent = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("devicetally");
        let existing = std::fs::read_to_string(lock::MANAGED).unwrap_or_default();
        let merged = lock::with_hooks(&existing, only_ours, block_skip)?;
        let tmp = app.path().app_data_dir().map_err(|e| e.to_string())?.join("managed-settings.json");
        std::fs::create_dir_all(tmp.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, merged).map_err(|e| e.to_string())?;
        let (bin_dir, bin, managed) = (lock::sh(lock::BIN_DIR), lock::sh(lock::BIN), lock::sh(lock::MANAGED));
        let script = format!(
            "set -e; mkdir -p {bin_dir} '/Library/Application Support/ClaudeCode'; cp {src} {bin}; chown root:wheel {bin}; chmod 755 {bin}; \
             if [ -f {managed} ]; then cp {managed} {managed}.devicetally-backup; fi; cp {tmp} {managed}; chown root:wheel {managed}; chmod 644 {managed}",
            src = lock::sh(&agent.to_string_lossy()),
            tmp = lock::sh(&tmp.to_string_lossy()),
        );
        let r = lock::as_admin(&script, "DeviceTally wants to lock tracking on this Mac, so it can't be turned off without an administrator.");
        let _ = std::fs::remove_file(&tmp);
        r?;
        // The tracker drops its user-level hooks at its next sync (they'd run twice).
        let _ = std::process::Command::new(lock::BIN).arg("sync").spawn();
        heartbeat(&app).await;
        Ok(())
    }
}

/// Unlocks (admin, macOS): removes DeviceTally's hooks from the system-wide settings and the
/// system copy of the tracker; the tracker puts its user-level hooks back at the next sync.
#[tauri::command]
async fn unlock_computer(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let server = state.config.lock().unwrap().server.clone();
    if state.token(&server).is_none() {
        return Err("Sign in as admin first.".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return Err("Locking is available on macOS for now.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let existing = std::fs::read_to_string(lock::MANAGED).unwrap_or_default();
        let cleaned = if existing.trim().is_empty() { "{}".to_string() } else { lock::without_hooks(&existing)? };
        let tmp = app.path().app_data_dir().map_err(|e| e.to_string())?.join("managed-settings.json");
        std::fs::write(&tmp, cleaned).map_err(|e| e.to_string())?;
        let script = format!("set -e; if [ -f {m} ]; then cp {t} {m}; chown root:wheel {m}; chmod 644 {m}; fi; rm -f {b}", m = lock::sh(lock::MANAGED), t = lock::sh(&tmp.to_string_lossy()), b = lock::sh(lock::BIN));
        let r = lock::as_admin(&script, "DeviceTally wants to unlock tracking on this Mac.");
        let _ = std::fs::remove_file(&tmp);
        r?;
        let agent = agent_dir().join("bin").join("devicetally");
        let _ = std::process::Command::new(agent).arg("sync").spawn();
        heartbeat(&app).await;
        Ok(())
    }
}

/// The menu bar's own appearance, read from a menu-bar item (it follows the wallpaper, not only the
/// system's dark mode): 0 unknown, 1 light, 2 dark.
#[cfg(target_os = "macos")]
static BAR_LOOK: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// Whether text without its own colour should be white in a coloured menu-bar image: the menu
/// bar's look, else macOS dark mode (checked at most every 10 s).
#[cfg(target_os = "macos")]
fn dark_mode() -> bool {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    match BAR_LOOK.load(Ordering::Relaxed) {
        1 => return false,
        2 => return true,
        _ => {}
    }
    static DARK: AtomicBool = AtomicBool::new(false);
    static CHECKED: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if now.saturating_sub(CHECKED.load(Ordering::Relaxed)) >= 10 {
        CHECKED.store(now, Ordering::Relaxed);
        let out = std::process::Command::new("defaults").args(["read", "-g", "AppleInterfaceStyle"]).output();
        DARK.store(out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("Dark")), Ordering::Relaxed);
    }
    DARK.load(Ordering::Relaxed)
}

/// Draws the user's menu-bar item (every 2 s). System counters are read only if an item needs them,
/// and the icon is replaced only when it changed.
fn draw_menubar(app: &AppHandle) {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().menubar.clone();
    let needs_stats = cfg.items.iter().any(|i| matches!(i.as_str(), "net" | "cpu" | "temp" | "mem" | "disk" | "battery"));
    let sessions = activity::read(&agent_dir().join("activity"));
    let agent = activity::agent(&sessions, now_ms(), *state.activity_seen.lock().unwrap());
    *state.agent_now.lock().unwrap() = agent;
    let fresh = state.last_sample.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(1800));
    let mut values = menubar::Values {
        agent,
        tick: ((now_ms() as u64 / menubar::RING_MS) % menubar::RING_STEPS as u64) as u8,
        tokens: state.tokens_today.lock().unwrap().clone(),
        stats: if needs_stats && fresh {
            state.last_stats.lock().unwrap().clone()
        } else if needs_stats {
            *state.last_sample.lock().unwrap() = Some(std::time::Instant::now());
            let mut sampler = state.sampler.lock().unwrap();
            let mut s = sampler.sample();
            if cfg.items.iter().any(|i| i == "temp") {
                let mut t = state.temp.lock().unwrap();
                s.cpu_temp = match *t {
                    Some((at, c)) if at.elapsed() < Duration::from_secs(15) => c,
                    _ => {
                        let c = sampler.cpu_temp();
                        *t = Some((std::time::Instant::now(), c));
                        c
                    }
                };
            }
            *state.last_stats.lock().unwrap() = s.clone();
            record(&state, &s);
            s
        } else {
            Default::default()
        },
        now: chrono::Local::now().naive_local(),
        battery_anim: 0,
    };
    // Only macOS draws the turning ring (Linux and Windows show text). On battery power it moves
    // only with the 2-second redraw: a ring turning several times a second for a long task cost
    // a lot of battery.
    let on_battery = values.stats.battery.is_some() && !values.stats.charging;
    state.animating.store(cfg!(target_os = "macos") && agent.0 == menubar::Agent::Working && !on_battery && cfg.items.iter().any(|i| i == "agent"), std::sync::atomic::Ordering::Relaxed);
    // Charger plugged in or unplugged: a short animation on the battery-in-icon item.
    if values.stats.battery.is_some() {
        let mut b = state.battery_change.lock().unwrap();
        if b.0.is_some_and(|was| was != values.stats.charging) {
            b.1 = Some(std::time::Instant::now());
        }
        b.0 = Some(values.stats.charging);
        let step = b.1.map(|t| (t.elapsed().as_millis() as u64 / menubar::RING_MS) as u8 + 1).filter(|s| *s <= menubar::BATTERY_STEPS);
        values.battery_anim = step.unwrap_or(0);
        if step.is_none() {
            b.1 = None;
        }
    }
    let battery_moving = values.battery_anim > 0 && cfg.items.iter().any(|i| i == "battery");
    state.battery_moving.store(battery_moving, std::sync::atomic::Ordering::Relaxed);
    if battery_moving && cfg!(target_os = "macos") {
        state.animating.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let mut units = menubar::units(&cfg, &values);
    // Claude Code status dot, first in the item: orange working, red needs you, green done.
    // The older "status dot" setting, until it's replaced by the Agent status item.
    let dot = if cfg.status_dot && !cfg.items.iter().any(|i| i == "agent") { activity::dot(&sessions, now_ms(), *state.activity_seen.lock().unwrap()) } else { None };
    // Banners and sounds: once per session change.
    let fired = {
        let mut seen = state.seen_sessions.lock().unwrap();
        let first = seen.is_none();
        {
            let mut log = state.agent_log.lock().unwrap();
            let before = log.len();
            let a = activity::alerts(seen.get_or_insert_with(Default::default), first, &sessions, now_ms(), cfg.alerts.min_seconds as i64 * 1000, &mut log);
            if log.len() != before {
                log.truncate(100);
                let _ = std::fs::write(agent_dir().join("app-agent-history.json"), serde_json::to_vec(&*log).unwrap_or_default());
            }
            a
        }
    };
    for a in fired {
        give_alert(app, &cfg.alerts, &a);
    }
    if let Some(d) = dot {
        units.insert(0, menubar::status_unit(d.rgb()));
    }
    // Separate items (macOS): one menu-bar item per module, each opening its own panel.
    let separate = cfg!(target_os = "macos") && !cfg.combined && !cfg.items.is_empty();
    // Images are drawn here; the menu bar itself is changed only on the main thread (below).
    #[cfg(target_os = "macos")]
    let drawn: Vec<(String, Option<Drawn>)> = if separate {
        cfg.items
            .iter()
            .map(|item| {
                let one = menubar::MenuBar { items: vec![item.clone()], solo: true, ..cfg.clone() };
                let u = menubar::units(&one, &values);
                let colored = one.colored() || u.iter().any(|x| x.color.is_some());
                let fg = if colored && dark_mode() { [255, 255, 255] } else { [0, 0, 0] };
                (item.clone(), menubar::render(&one, &u, fg).map(|(rgba, w, h)| Drawn { rgba, w, h, colored, tip: format!("DeviceTally: {}", menubar::text(&u)) }))
            })
            .collect()
    } else {
        let colored = cfg.colored() || dot.is_some() || units.iter().any(|u| u.color.is_some());
        let fg = if colored && dark_mode() { [255, 255, 255] } else { [0, 0, 0] };
        let tip = if units.is_empty() { "DeviceTally".to_string() } else { format!("DeviceTally: {}", menubar::text(&units)) };
        vec![(String::new(), menubar::render_fit(&cfg, &units, fg).0.map(|(rgba, w, h)| Drawn { rgba, w, h, colored, tip }))]
    };
    #[cfg(not(target_os = "macos"))]
    let drawn: Vec<(String, Option<Drawn>)> = vec![];
    let want: Vec<String> = if separate { cfg.items.clone() } else { vec![] };
    let tip = if units.is_empty() { "DeviceTally".to_string() } else { format!("DeviceTally: {}", menubar::text(&units)) };
    // Adding or removing menu-bar items from another thread made that thread wait for the main
    // thread while holding locks the main thread needed: the app froze. Everything that touches the
    // menu bar now runs on the main thread, one update at a time.
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || apply_menubar(&app2, &want, drawn, tip));
}

/// Time between frames while the ring turns or the charger animates: about 4 a second. The ring's
/// position follows the clock, so it turns at the same speed, in bigger steps; 12 frames a second
/// kept the Mac busy for as long as an agent worked.
const FRAME_MS: u64 = 250;

/// Between full redraws while the ring turns: redraws only the Agent status item (separate items on
/// macOS). Redrawing every item 20 times a second cost ~12% CPU. False when a full redraw is needed.
fn draw_ring(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().menubar.clone();
    if !cfg!(target_os = "macos") || cfg.combined || !cfg.items.iter().any(|i| i == "agent") || state.battery_moving.load(std::sync::atomic::Ordering::Relaxed) {
        return false;
    }
    let agent = *state.agent_now.lock().unwrap();
    if agent.0 != menubar::Agent::Working {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        let values = menubar::Values { agent, tick: ((now_ms() as u64 / menubar::RING_MS) % menubar::RING_STEPS as u64) as u8, tokens: None, stats: Default::default(), now: chrono::Local::now().naive_local(), battery_anim: 0 };
        let one = menubar::MenuBar { items: vec!["agent".into()], solo: true, ..cfg.clone() };
        let u = menubar::units(&one, &values);
        let colored = one.colored() || u.iter().any(|x| x.color.is_some());
        let fg = if colored && dark_mode() { [255, 255, 255] } else { [0, 0, 0] };
        let d = menubar::render(&one, &u, fg).map(|(rgba, w, h)| Drawn { rgba, w, h, colored, tip: format!("DeviceTally: {}", menubar::text(&u)) });
        let (app2, want) = (app.clone(), cfg.items.clone());
        let _ = app.run_on_main_thread(move || apply_menubar(&app2, &want, vec![("agent".into(), d)], String::new()));
    }
    true
}

/// One menu-bar image, drawn and ready to show.
struct Drawn {
    rgba: Vec<u8>,
    w: u32,
    h: u32,
    colored: bool,
    tip: String,
}

/// Shows drawn images in the menu bar. Main thread only.
fn apply_menubar(app: &AppHandle, want: &[String], drawn: Vec<(String, Option<Drawn>)>, tip: String) {
    let state = app.state::<AppState>();
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let separate = !want.is_empty();
    sync_trays(app, want);
    let _ = tray.set_visible(!separate);
    if !cfg!(target_os = "macos") {
        // Linux trays show a title next to the icon (no tooltips, no clicks); Windows a tooltip.
        static LAST: Mutex<String> = Mutex::new(String::new());
        let mut last = LAST.lock().unwrap();
        if *last != tip {
            if cfg!(target_os = "linux") {
                let _ = tray.set_title(Some(if tip == "DeviceTally" { "" } else { tip.as_str() }));
            }
            let _ = tray.set_tooltip(Some(&tip));
            *last = tip;
        }
        return;
    }
    let mut icons = state.item_icons.lock().unwrap();
    for (item, d) in drawn {
        let t = if separate { app.tray_by_id(&format!("mb-{item}")) } else { Some(tray.clone()) };
        let Some(t) = t else { continue };
        match d {
            Some(d) => {
                if separate {
                    let _ = t.set_visible(true);
                }
                let _ = t.set_tooltip(Some(&d.tip));
                let prev = icons.get(&item);
                if prev.map(|p| &p.0) != Some(&d.rgba) {
                    // set_icon_as_template redraws the image, so it's called only when it changes.
                    let _ = t.set_icon(Some(tauri::image::Image::new_owned(d.rgba.clone(), d.w, d.h)));
                    if prev.map(|p| p.1) != Some(!d.colored) {
                        let _ = t.set_icon_as_template(!d.colored);
                        let _ = t.set_title(None::<&str>);
                    }
                    fit_height(&t, d.w, d.h, separate);
                    icons.insert(item, (d.rgba, !d.colored));
                }
            }
            // Nothing to show (e.g. no temperature sensor, no battery): hide that item.
            None if separate => {
                let _ = t.set_visible(false);
            }
            None => {
                if icons.remove(&item).is_some() {
                    if let Ok(img) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
                        let _ = t.set_icon(Some(img));
                    }
                }
            }
        }
    }
}

/// The tray library always shows images 18 pt high, so a 44 px (22 pt, full menu-bar height) image
/// was squeezed, shrinking everything in it. Show it at its real size: 2 px per point.
/// Separate items are also made exactly as wide as their image: macOS otherwise adds its own
/// padding around each one, so the Spacing setting couldn't bring them close together.
fn fit_height(t: &tauri::tray::TrayIcon, w: u32, h: u32, exact: bool) {
    #[cfg(target_os = "macos")]
    let _ = t.with_inner_tray_icon(move |inner| {
        let Some(item) = inner.ns_status_item() else { return };
        // SAFETY: called on the main thread (apply_menubar).
        let mtm = unsafe { objc2_foundation::MainThreadMarker::new_unchecked() };
        if let Some(img) = item.button(mtm).and_then(|b| b.image()) {
            img.setSize(objc2_foundation::NSSize::new(w as f64 / 2.0, h as f64 / 2.0));
        }
        item.setLength(if exact { w as f64 / 2.0 } else { objc2_app_kit::NSVariableStatusItemLength });
        if let Some(b) = item.button(mtm) {
            use objc2_app_kit::NSAppearanceCustomization;
            let dark = b.effectiveAppearance().name().to_string().contains("Dark");
            BAR_LOOK.store(if dark { 2 } else { 1 }, std::sync::atomic::Ordering::Relaxed);
        }
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (t, w, h, exact);
}

// Menu-bar commands are async so Tauri runs them off the main (window) thread.
/// Shows or hides DeviceTally's Dock icon, and remembers it.
#[tauri::command]
async fn set_dock(app: AppHandle, state: State<'_, AppState>, show: bool) -> Result<(), String> {
    let mut c = state.config.lock().unwrap().clone();
    c.show_in_dock = show;
    save_config(&app, &c)?;
    *state.config.lock().unwrap() = c;
    #[cfg(target_os = "macos")]
    {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = a.set_activation_policy(if show { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
            // Hiding the Dock icon deactivates the app; keep its window in front.
            if let Some(w) = a.get_webview_window("main") {
                let _ = w.set_focus();
            }
        });
    }
    Ok(())
}

#[tauri::command]
async fn get_dock(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.config.lock().unwrap().show_in_dock)
}

#[tauri::command]
async fn get_menubar(state: State<'_, AppState>) -> Result<menubar::MenuBar, String> {
    Ok(state.config.lock().unwrap().menubar.clone())
}

#[tauri::command]
async fn set_menubar(app: AppHandle, state: State<'_, AppState>, cfg: menubar::MenuBar) -> Result<(), String> {
    let mut c = state.config.lock().unwrap().clone();
    c.menubar = cfg;
    save_config(&app, &c)?;
    *state.config.lock().unwrap() = c;
    draw_menubar(&app);
    Ok(())
}

/// While a slider is dragged: shows the configuration in the real menu bar without saving it
/// (set_menubar saves when it's let go).
#[tauri::command]
async fn set_menubar_live(app: AppHandle, state: State<'_, AppState>, cfg: menubar::MenuBar) -> Result<(), String> {
    state.config.lock().unwrap().menubar = cfg;
    draw_menubar(&app);
    Ok(())
}

/// What a configuration would look like, for the live preview in Settings: RGBA pixels at 2x.
#[tauri::command]
async fn menubar_preview(state: State<'_, AppState>, mut cfg: menubar::MenuBar) -> Result<Value, String> {
    // One item of separate items: drawn with its own spacing, as in the menu bar.
    cfg.solo = !cfg.combined && cfg.items.len() == 1;
    // Uses the latest reading; a fresh sample per preview made the numbers jump and cost CPU.
    let mut stats = {
        let last = state.last_stats.lock().unwrap().clone();
        if last.mem_total > 0 { last } else { state.sampler.lock().unwrap().sample() }
    };
    if cfg.items.iter().any(|i| i == "temp") && stats.cpu_temp.is_none() {
        stats.cpu_temp = state.sampler.lock().unwrap().cpu_temp();
    }
    let sessions = activity::read(&agent_dir().join("activity"));
    let values = menubar::Values {
        agent: activity::agent(&sessions, now_ms(), *state.activity_seen.lock().unwrap()),
        tick: ((now_ms() as u64 / menubar::RING_MS) % menubar::RING_STEPS as u64) as u8,
        tokens: state.tokens_today.lock().unwrap().clone().or(Some("151M".into())),
        stats,
        now: chrono::Local::now().naive_local(),
        battery_anim: 0,
    };
    let units = menubar::units(&cfg, &values);
    // As it looks on a light and on a dark menu bar.
    #[cfg(target_os = "macos")]
    if let ((Some((light, w, h)), hidden), (Some((dark, _, _)), _)) = (menubar::render_fit(&cfg, &units, [0, 0, 0]), menubar::render_fit(&cfg, &units, [255, 255, 255])) {
        // Base64, not a JSON array of numbers: ~4x smaller and fast to decode, so sliders stay smooth.
        use base64::Engine;
        let b64 = |v: Vec<u8>| base64::engine::general_purpose::STANDARD.encode(v);
        return Ok(serde_json::json!({ "width": w, "height": h, "light": b64(light), "dark": b64(dark), "hidden": hidden, "text": menubar::text(&units) }));
    }
    Ok(serde_json::json!({ "width": 0, "height": 0, "text": menubar::text(&units) }))
}

/// This computer right now (popover strip), sampled on demand while it is open.
#[tauri::command]
async fn system_stats(state: State<'_, AppState>) -> Result<stats::Stats, String> {
    let mut sampler = state.sampler.lock().unwrap();
    let mut s = sampler.sample();
    s.cpu_temp = sampler.cpu_temp();
    drop(sampler);
    record(&state, &s);
    *state.last_stats.lock().unwrap() = s.clone();
    Ok(s)
}

#[derive(Serialize)]
struct AppStatus {
    server: String,
    signed_in: bool,
    this_device_connected: bool,
    agent_server: String,
    /// "Just this computer": no server; usage is counted here by the tracker.
    local: bool,
}

/// "Just this computer" mode: the tracker's local marker, and no server connection.
fn local_mode(state: &AppState) -> bool {
    state.agent.lock().unwrap().is_none() && agent_dir().join("local").exists()
}

/// Runs the bundled tracker and parses its JSON output (local usage).
async fn run_tracker(args: Vec<String>) -> Result<Value, String> {
    let bin = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name(if cfg!(windows) { "devicetally.exe" } else { "devicetally" });
    let out = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(bin);
        cmd.args(&args).stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

/// Sets up "Just this computer": the bundled tracker installs itself and the hooks, no server.
#[tauri::command]
async fn setup_local(app: AppHandle) -> Result<(), String> {
    let bin = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name(if cfg!(windows) { "devicetally.exe" } else { "devicetally" });
    let out = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(bin);
        cmd.arg("local").stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().lines().last().unwrap_or("Setup failed.").to_string());
    }
    refresh_tray(&app).await;
    Ok(())
}

/// This machine's enrolled agent: (server, device key) from its state file.
fn agent_dir() -> PathBuf {
    std::env::var("DEVICETALLY_HOME").map(PathBuf::from).unwrap_or_else(|_| {
        if cfg!(windows) {
            PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("devicetally")
        } else {
            PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".devicetally")
        }
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Claude Code's sessions on this computer, as the agent's hooks recorded them.
#[tauri::command]
async fn activity() -> Result<Vec<activity::Session>, String> {
    let mut s = activity::read(&agent_dir().join("activity"));
    s.sort_by(|a, b| b.since.cmp(&a.since));
    Ok(s)
}

/// Started by `npm run try` (a local test build, not the installed app): the app shows a TEST badge.
#[tauri::command]
fn test_build() -> bool {
    std::env::var("DEVICETALLY_OPEN_WINDOW").is_ok()
}

/// Whether the menu bar looks dark right now (for the preview in Settings).
#[tauri::command]
async fn menubar_dark() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return Ok(dark_mode());
    #[cfg(not(target_os = "macos"))]
    Ok(false)
}

/// Finished agent tasks, newest first, for the Agents panel.
#[tauri::command]
async fn agent_history(state: State<'_, AppState>) -> Result<Vec<activity::Finished>, String> {
    Ok(state.agent_log.lock().unwrap().clone())
}

fn read_agent() -> Option<(String, String)> {
    let dir = agent_dir();
    let v: Value = serde_json::from_slice(&std::fs::read(dir.join("state.json")).ok()?).ok()?;
    let (server, key) = (v["server"].as_str()?.to_string(), v["device_key"].as_str()?.to_string());
    (!server.is_empty() && !key.is_empty()).then_some((server, key))
}

#[tauri::command]
fn status(state: State<'_, AppState>) -> AppStatus {
    let server = state.config.lock().unwrap().server.clone();
    let agent = read_agent();
    *state.agent.lock().unwrap() = agent.clone();
    AppStatus {
        signed_in: !server.is_empty() && state.token(&server).is_some(),
        this_device_connected: agent.is_some(),
        local: agent.is_none() && agent_dir().join("local").exists(),
        agent_server: agent.map(|a| a.0).unwrap_or_default(),
        server,
    }
}

#[tauri::command]
async fn sign_in(app: AppHandle, state: State<'_, AppState>, server: String, email: String, password: String) -> Result<(), String> {
    let server = server.trim().trim_end_matches('/').to_string();
    let server = if server.starts_with("http") { server } else { format!("https://{server}") };
    let res = state
        .http
        .post(format!("{server}/api/auth/login"))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|_| "Could not reach that server. Check the address.".to_string())?;
    match res.status().as_u16() {
        200 => {}
        401 => return Err("Email or password is not right.".into()),
        429 => return Err("Too many wrong attempts. Wait a few minutes.".into()),
        409 => return Err("This server has no admin login yet. Tick \"First time on this server\" and enter its setup token.".into()),
        s => return Err(format!("The server answered {s}.")),
    }
    // The login sets an HttpOnly session cookie; the app keeps that token in session.json (owner-only).
    let token = res
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|c| c.strip_prefix("dt_session=").map(|rest| rest.split(';').next().unwrap_or("").to_string()))
        .filter(|t| !t.is_empty())
        .ok_or("The server did not start a session.")?;
    write_session(&app, &server, Some(&token))?;
    state.set_token(Some(token));
    let cfg = Config { server, ..state.config.lock().unwrap().clone() };
    save_config(&app, &cfg)?;
    *state.config.lock().unwrap() = cfg;
    refresh_tray(&app).await;
    Ok(())
}

#[tauri::command]
async fn sign_out(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let server = state.config.lock().unwrap().server.clone();
    if let Some(token) = state.token(&server) {
        let _ = state.http.post(format!("{server}/api/auth/logout")).header("cookie", format!("dt_session={token}")).send().await;
    }
    let _ = write_session(&app, &server, None);
    state.set_token(None);
    // Another saved server? Switch to it instead of leaving the app signed out.
    if let Some(next) = read_sessions(&app).keys().next().cloned() {
        let cfg = Config { server: next.clone(), ..state.config.lock().unwrap().clone() };
        let _ = save_config(&app, &cfg);
        *state.config.lock().unwrap() = cfg;
        state.set_token(read_session(&app, &next));
    }
    refresh_tray(&app).await;
    Ok(())
}

#[tauri::command]
async fn summary(state: State<'_, AppState>, range: String) -> Result<Value, String> {
    let range = match range.as_str() {
        "7d" | "30d" => range,
        _ => "today".to_string(),
    };
    let admin = { let server = state.config.lock().unwrap().server.clone(); !server.is_empty() && state.token(&server).is_some() };
    match get_summary(&state, &range).await {
        // As in `api`: this computer's own count when the server can't answer.
        Err(e) if !admin && server_down(&e) && state.agent.lock().unwrap().is_some() => {
            let days = match range.as_str() { "30d" => "30", "7d" => "7", _ => "1" };
            let mut v = run_tracker(vec!["usage".into(), "summary".into(), days.into()]).await.map_err(|_| e.clone())?;
            v["fallback"] = e.into();
            Ok(v)
        }
        r => r,
    }
}

/// Creates a one-time code with the owner session and runs the bundled agent's `enroll` with it.
#[tauri::command]
async fn add_this_device(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let server = state.config.lock().unwrap().server.clone();
    let token = state.token(&server).ok_or("Sign in first.")?;
    let res = state
        .http
        .post(format!("{server}/api/devices/enroll"))
        .header("cookie", format!("dt_session={token}"))
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|_| "Could not reach your server.".to_string())?;
    if !res.status().is_success() {
        return Err(format!("Could not create a code ({}).", res.status().as_u16()));
    }
    let code = res.json::<Value>().await.map_err(|e| e.to_string())?["code"].as_str().unwrap_or("").to_string();
    run_enroll(&state, server, code).await
}

/// Connects this machine with a code from the admin (Devices → Add device): no admin login needed.
#[tauri::command]
async fn connect_with_code(app: AppHandle, state: State<'_, AppState>, server: String, code: String) -> Result<String, String> {
    let server = server.trim().trim_end_matches('/').to_string();
    let server = if server.starts_with("http") { server } else { format!("https://{server}") };
    let out = run_enroll(&state, server, code.trim().to_uppercase()).await?;
    refresh_tray(&app).await;
    Ok(out)
}

/// Stops tracking on this computer: the agent removes its hooks (restoring Claude's settings) and its data.
#[tauri::command]
async fn disconnect_this_computer(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // A joined computer can't remove itself while the server still tracks it: it asks the admin
    // (Settings → Request to disconnect), and once approved its key stops working.
    let server = state.config.lock().unwrap().server.clone();
    let admin = !server.is_empty() && state.token(&server).is_some();
    if !admin {
        let agent = state.agent.lock().unwrap().clone();
        if let Some((agent_server, key)) = agent {
            if let Ok(r) = state.http.get(format!("{agent_server}/api/v1/config")).bearer_auth(key).send().await {
                if r.status().is_success() {
                    return Err("needs_admin_approval".into());
                }
            }
        }
    }
    uninstall_agent(&app, &state).await
}

async fn uninstall_agent(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let agent = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name(if cfg!(windows) { "devicetally.exe" } else { "devicetally" });
    let out = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(agent);
        cmd.arg("uninstall").stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    *state.agent.lock().unwrap() = None;
    refresh_tray(app).await;
    Ok(())
}

/// Admin, when stopping DeviceTally: deletes the server and its database from Cloudflare, then
/// removes DeviceTally's hooks and sign-in from this computer. The Cloudflare token isn't kept.
#[tauri::command]
async fn delete_server(app: AppHandle, state: State<'_, AppState>, cf_token: String) -> Result<(), String> {
    use reqwest::Method;
    let token = cf_token.trim();
    let server = state.config.lock().unwrap().server.clone();
    if state.token(&server).is_none() {
        return Err("signed_out".into());
    }
    let accounts = cf(&state.http, token, Method::GET, "/accounts", None).await?;
    let id = accounts.as_array().and_then(|a| a.first()).and_then(|a| a["id"].as_str()).ok_or("That token can't see a Cloudflare account.")?.to_string();
    let sub = cf(&state.http, token, Method::GET, &format!("/accounts/{id}/workers/subdomain"), None).await?;
    // Only delete the server this app is signed in to.
    if format!("https://{SERVER_NAME}.{}.workers.dev", sub["subdomain"].as_str().unwrap_or_default()) != server {
        return Err(format!("This Cloudflare account doesn't hold {server}. Use a token from the account where it runs."));
    }
    progress(&app, "Deleting the server");
    cf(&state.http, token, Method::DELETE, &format!("/accounts/{id}/workers/scripts/{SERVER_NAME}?force=true"), None).await?;
    progress(&app, "Deleting the database");
    let dbs = cf(&state.http, token, Method::GET, &format!("/accounts/{id}/d1/database?name={SERVER_NAME}"), None).await?;
    if let Some(db) = dbs.as_array().and_then(|a| a.iter().find(|d| d["name"] == SERVER_NAME)) {
        cf(&state.http, token, Method::DELETE, &format!("/accounts/{id}/d1/database/{}", db["uuid"].as_str().unwrap_or_default()), None).await?;
    }
    progress(&app, "Removing DeviceTally from this computer");
    let _ = uninstall_agent(&app, &state).await;
    let _ = write_session(&app, &server, None);
    state.set_token(None);
    let cfg = Config { server: String::new(), ..state.config.lock().unwrap().clone() };
    save_config(&app, &cfg)?;
    *state.config.lock().unwrap() = cfg;
    refresh_tray(&app).await;
    Ok(())
}

/// The tracker's version ("1.2.0"), from `<bin> version`.
fn tracker_version(bin: &std::path::Path) -> Option<Vec<u64>> {
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("version").stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    let v: Vec<u64> = String::from_utf8_lossy(&out.stdout).trim().split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    (v.len() == 3).then_some(v)
}

/// The hooks run the tracker installed in ~/.devicetally/bin, which only updated itself once a
/// day: after an app update it could stay old for good (an old one records no agent status).
/// At start, an installed tracker older than the one in the app is replaced by it.
fn update_tracker() {
    let name = if cfg!(windows) { "devicetally.exe" } else { "devicetally" };
    let installed = agent_dir().join("bin").join(name);
    let Ok(bundled) = std::env::current_exe().map(|e| e.with_file_name(name)) else { return };
    if !installed.exists() || !bundled.exists() {
        return;
    }
    let (Some(new), old) = (tracker_version(&bundled), tracker_version(&installed)) else { return };
    if old.is_some_and(|o| o >= new) {
        return;
    }
    // Copy beside it, then rename over it: a hook running right now keeps the old file.
    let tmp = installed.with_extension("new");
    if std::fs::copy(&bundled, &tmp).is_ok() && std::fs::rename(&tmp, &installed).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Runs the bundled agent's `enroll`, then remembers this machine's device key.
async fn run_enroll(state: &AppState, server: String, code: String) -> Result<String, String> {
    let agent = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name(if cfg!(windows) { "devicetally.exe" } else { "devicetally" });
    let out = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(agent);
        cmd.args(["enroll", &server, &code]).stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Could not start the bundled agent: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        return Err(text.trim().lines().last().unwrap_or("The agent failed.").to_string());
    }
    *state.agent.lock().unwrap() = read_agent();
    Ok(text.trim().lines().last().unwrap_or("Connected.").trim_start_matches('\r').to_string())
}

/// Every request from the main window goes through here: the admin's session or this device's key is
/// added by Rust, so the window never holds credentials. A device may only read its own overview and
/// sessions (the server also enforces this); prompt text and admin actions need the admin session.
#[tauri::command]
async fn api(state: State<'_, AppState>, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    let admin = { let server = state.config.lock().unwrap().server.clone(); !server.is_empty() && state.token(&server).is_some() };
    match api_remote(&state, method.clone(), path.clone(), body).await {
        // The server can't answer (offline, its free limit, an error): a connected computer still
        // sees its own usage, counted here by the tracker, with the reason. (The admin's view of all
        // computers exists only on the server.)
        Err(e) if !admin && method == "GET" && (path == "/overview" || path.starts_with("/overview?")) && server_down(&e) && state.agent.lock().unwrap().is_some() => {
            let days = path.split(['?', '&']).find_map(|p| p.strip_prefix("days=")).and_then(|d| d.parse::<u32>().ok()).unwrap_or(30);
            let mut v = run_tracker(vec!["usage".into(), days.clamp(1, 3660).to_string()]).await.map_err(|_| e.clone())?;
            v["fallback"] = e.into();
            Ok(v)
        }
        r => r,
    }
}

/// Errors where the server couldn't answer (as opposed to "not allowed" or "signed out").
fn server_down(e: &str) -> bool {
    e == "offline" || e == "db_limit" || e == "server_error" || (e.starts_with("server_5"))
}

async fn api_remote(state: &AppState, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with('/') || path.contains("..") {
        return Err("bad_path".into());
    }
    let server = state.config.lock().unwrap().server.clone();
    let admin = (!server.is_empty()).then(|| state.token(&server)).flatten();
    let req = if let Some(token) = admin {
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let r = state.http.request(m, format!("{server}/api{path}")).header("cookie", format!("dt_session={token}"));
        if let Some(b) = body { r.json(&b) } else { r }
    } else {
        let agent = state.agent.lock().unwrap().clone();
        let Some((agent_server, key)) = agent else {
            // Just this computer: the overview is counted here; nothing else exists without a server.
            if local_mode(&state) && method == "GET" && (path == "/overview" || path.starts_with("/overview?")) {
                let days = path.split(['?', '&']).find_map(|p| p.strip_prefix("days=")).and_then(|d| d.parse::<u32>().ok()).unwrap_or(30);
                return run_tracker(vec!["usage".into(), days.clamp(1, 3660).to_string()]).await;
            }
            return Err(if local_mode(&state) { "local".into() } else { "not_set_up".into() });
        };
        let read = method == "GET" && ["/overview", "/sessions", "/summary"].iter().any(|p| path == *p || path.starts_with(&format!("{p}?")) || path.starts_with("/sessions/"));
        let request = path == "/disconnect-request" && ["GET", "POST", "DELETE"].contains(&method.as_str());
        if !read && !request {
            return Err("admin_only".into());
        }
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let r = state.http.request(m, format!("{agent_server}/api/v1{path}")).bearer_auth(key);
        if method == "POST" { r.json(&serde_json::json!({})) } else { r }
    };
    let res = req.send().await.map_err(|_| "offline".to_string())?;
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    match status {
        200..=299 => Ok(v),
        401 => Err("signed_out".into()),
        _ => Err(v["error"].as_str().map(String::from).unwrap_or(format!("server_{status}"))),
    }
}

/// Saves an export (admin) to the Downloads folder and returns its path.
#[tauri::command]
async fn save_export(app: AppHandle, state: State<'_, AppState>, format: String) -> Result<String, String> {
    let server = state.config.lock().unwrap().server.clone();
    let token = state.token(&server).ok_or("signed_out")?;
    let format = if format == "csv" { "csv" } else { "json" };
    let res = state.http.get(format!("{server}/api/export?format={format}")).header("cookie", format!("dt_session={token}")).send().await.map_err(|_| "offline".to_string())?;
    if !res.status().is_success() {
        return Err(format!("server_{}", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let name = format!("devicetally-export-{}.{format}", chrono_day());
    let path = dir.join(name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

fn chrono_day() -> String {
    ymd(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64)
}

/// Days since 1970-01-01 -> "YYYY-MM-DD" (civil-from-days, no date crate).
fn ymd(days: i64) -> String {
    let (z, era) = { let z = days + 719_468; (z, z.div_euclid(146_097)) };
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

// ---------- "Set up DeviceTally": create the server in the user's own Cloudflare account ----------
// Same steps as `npm run setup`, through Cloudflare's API with a token the user creates (Workers Scripts
// Edit, D1 Edit, Account Settings Read). The token is used for this and not stored.

const WORKER_JS: &str = include_str!("../server/worker.js");
const MIGRATIONS: &str = include_str!("../server/migrations.json");
const SERVER_VERSION: &str = include_str!("../server/version.txt");
const SERVER_NAME: &str = "devicetally";

async fn cf(http: &reqwest::Client, token: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let mut req = http.request(method, format!("https://api.cloudflare.com/client/v4{path}")).bearer_auth(token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let v: Value = req.send().await.map_err(|_| "Could not reach Cloudflare. Check your connection.".to_string())?.json().await.map_err(|e| e.to_string())?;
    if v["success"].as_bool() == Some(true) {
        return Ok(v["result"].clone());
    }
    Err(cf_error(&v))
}

fn cf_error(v: &Value) -> String {
    let e = &v["errors"][0];
    match e["code"].as_i64() {
        Some(9109 | 10000 | 9106 | 6003 | 1000) => "Cloudflare didn't accept that token. Create it again with the button above, and copy the whole token.".into(),
        _ => format!("Cloudflare said: {}", e["message"].as_str().unwrap_or("unknown error")),
    }
}

fn progress(app: &AppHandle, msg: &str) {
    use tauri::Emitter;
    let _ = app.emit("setup-progress", msg.to_string());
}

/// Creates (or finishes creating) the server and returns its address and one-time setup token.
#[tauri::command]
async fn create_server(app: AppHandle, state: State<'_, AppState>, cf_token: String) -> Result<Value, String> {
    let report = |m: &str| progress(&app, m);
    provision(&state.http, cf_token.trim(), SERVER_NAME, false, &report).await
}

/// Updates an existing server to the version bundled in this app (admin, Settings → Server).
#[tauri::command]
async fn update_server(app: AppHandle, state: State<'_, AppState>, cf_token: String) -> Result<Value, String> {
    let report = |m: &str| progress(&app, m);
    provision(&state.http, cf_token.trim(), SERVER_NAME, true, &report).await
}

/// The version of the server code bundled in this app (it changes less often than the app).
#[tauri::command]
fn bundled_server_version() -> &'static str {
    SERVER_VERSION.trim()
}

/// `update`: false creates a server (or reports one exists); true updates the existing one in place,
/// applying only new migrations and keeping its secret.
async fn provision(http: &reqwest::Client, token: &str, name: &str, update: bool, progress: &(dyn Fn(&str) + Send + Sync)) -> Result<Value, String> {
    use reqwest::Method;
    progress("Checking your Cloudflare account");
    let accounts = cf(http, token, Method::GET, "/accounts", None).await?;
    let account = accounts.as_array().and_then(|a| a.first()).ok_or("That token can't see a Cloudflare account. Create it again and keep \"All accounts\" selected.")?;
    let id = account["id"].as_str().unwrap_or_default().to_string();

    // Your free workers.dev address: brand-new accounts don't have one yet, so pick one.
    let sub = match cf(http, token, Method::GET, &format!("/accounts/{id}/workers/subdomain"), None).await {
        Ok(r) if r["subdomain"].as_str().is_some_and(|s| !s.is_empty()) => r["subdomain"].as_str().unwrap().to_string(),
        _ => {
            progress("Choosing your free workers.dev address");
            let base: String = account["name"].as_str().unwrap_or("devicetally").to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
            let mut chosen = None;
            for n in 0..5 {
                let suffix: u32 = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() + n) % 10_000;
                let cand = format!("{}{suffix}", if base.len() >= 3 { base.as_str() } else { "devicetally" });
                if cf(http, token, Method::PUT, &format!("/accounts/{id}/workers/subdomain"), Some(serde_json::json!({ "subdomain": cand }))).await.is_ok() {
                    chosen = Some(cand);
                    break;
                }
            }
            chosen.ok_or("Could not create your workers.dev address. Open Cloudflare → Workers & Pages once, then try again.")?
        }
    };
    let server = format!("https://{name}.{sub}.workers.dev");

    // Already set up in this account? Then this is a sign-in (or an update), not a new server.
    let exists = cf(http, token, Method::GET, &format!("/accounts/{id}/workers/scripts/{name}/settings"), None).await.is_ok();
    if exists && !update {
        return Ok(serde_json::json!({ "exists": true, "server": server }));
    }
    if update && !exists {
        return Err("No DeviceTally server was found in this Cloudflare account. Use the token from the account where you set it up.".into());
    }

    progress("Creating your database");
    let existing = cf(http, token, Method::GET, &format!("/accounts/{id}/d1/database?name={name}"), None).await?;
    let db_id = match existing.as_array().and_then(|a| a.iter().find(|d| d["name"] == name)) {
        Some(d) => d["uuid"].as_str().unwrap_or_default().to_string(),
        None => cf(http, token, Method::POST, &format!("/accounts/{id}/d1/database"), Some(serde_json::json!({ "name": name }))).await?["uuid"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    };

    progress("Creating tables");
    let query_path = format!("/accounts/{id}/d1/database/{db_id}/query");
    let query = |sql: String| cf(http, token, Method::POST, &query_path, Some(serde_json::json!({ "sql": sql })));
    query("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)".into()).await?;
    let applied = query("SELECT name FROM d1_migrations".into()).await?;
    let done: Vec<String> = applied[0]["results"].as_array().map(|r| r.iter().filter_map(|x| x["name"].as_str().map(String::from)).collect()).unwrap_or_default();
    let migrations: Vec<Value> = serde_json::from_str(MIGRATIONS).map_err(|e| e.to_string())?;
    for m in migrations {
        let name = m["name"].as_str().unwrap_or_default();
        if done.iter().any(|d| d == name) {
            continue;
        }
        // Recorded the same way as `wrangler d1 migrations apply`, so `npm run update` keeps working.
        query(format!("{}\nINSERT INTO d1_migrations (name) VALUES ('{}');", m["sql"].as_str().unwrap_or_default(), name.replace('\'', ""))).await?;
    }

    progress(if update { "Uploading the new server version" } else { "Uploading the server" });
    let setup_token: String = {
        use std::fmt::Write;
        let mut s = String::new();
        for b in random_bytes() {
            let _ = write!(s, "{b:02x}");
        }
        s
    };
    let mut bindings = vec![
        serde_json::json!({ "type": "d1", "name": "DB", "id": db_id }),
        serde_json::json!({ "type": "plain_text", "name": "RELEASE_REPO", "text": "bipul0525/devicetally" }),
    ];
    if !update {
        bindings.push(serde_json::json!({ "type": "secret_text", "name": "SETUP_TOKEN", "text": setup_token }));
    }
    let metadata = serde_json::json!({
        "main_module": "index.js",
        "compatibility_date": "2026-08-22",
        "bindings": bindings,
        // An update must not wipe the existing setup secret.
        "keep_bindings": ["secret_text"],
        "observability": { "enabled": true },
    });
    let form = reqwest::multipart::Form::new()
        .part("metadata", reqwest::multipart::Part::text(metadata.to_string()).mime_str("application/json").map_err(|e| e.to_string())?)
        .part("index.js", reqwest::multipart::Part::text(WORKER_JS).file_name("index.js").mime_str("application/javascript+module").map_err(|e| e.to_string())?);
    let v: Value = http
        .put(format!("https://api.cloudflare.com/client/v4/accounts/{id}/workers/scripts/{name}"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "Could not reach Cloudflare. Check your connection.".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if v["success"].as_bool() != Some(true) {
        return Err(cf_error(&v));
    }

    progress("Turning on your address");
    cf(http, token, Method::POST, &format!("/accounts/{id}/workers/scripts/{name}/subdomain"), Some(serde_json::json!({ "enabled": true, "previews_enabled": false }))).await?;
    cf(http, token, Method::PUT, &format!("/accounts/{id}/workers/scripts/{name}/schedules"), Some(serde_json::json!([{ "cron": "17 3 * * *" }]))).await?;

    progress("Waiting for your server to come online");
    for _ in 0..60 {
        if let Ok(r) = http.get(format!("{server}/api/auth/state")).send().await {
            if r.status().is_success() {
                if update {
                    return Ok(serde_json::json!({ "updated": true, "server": server, "version": SERVER_VERSION.trim() }));
                }
                return Ok(serde_json::json!({ "exists": false, "server": server, "setup_token": setup_token }));
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Err(format!("Your server was created but isn't answering yet. Wait a minute, then choose \"I already have a server\" and use {server}"))
}

fn random_bytes() -> [u8; 24] {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).expect("random");
    b
}

/// First run of a new server: create the admin login with the setup token, then sign in.
#[tauri::command]
async fn create_admin(app: AppHandle, state: State<'_, AppState>, server: String, token: String, email: String, password: String, timezone: String) -> Result<(), String> {
    let server = server.trim().trim_end_matches('/').to_string();
    let server = if server.starts_with("http") { server } else { format!("https://{server}") };
    let res = state
        .http
        .post(format!("{server}/api/auth/setup"))
        .json(&serde_json::json!({ "token": token, "email": email, "password": password, "timezone": timezone }))
        .send()
        .await
        .map_err(|_| "Could not reach that server.".to_string())?;
    match res.status().as_u16() {
        200 => {}
        403 => return Err("That setup token is not right.".into()),
        409 => return Err("This server already has an admin. Sign in instead.".into()),
        400 => return Err("Use a valid email and a password of at least 10 characters.".into()),
        s => return Err(format!("The server answered {s}.")),
    }
    sign_in(app, state, server, email, password).await
}

/// "Open DeviceTally": the main window (the web dashboard is gone; everything lives in the app).
#[tauri::command]
fn open_dashboard(app: AppHandle) -> Result<(), String> {
    show_main(&app, "overview").map_err(|e| e.to_string())
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    show_main(&app, "settings").map_err(|e| e.to_string())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn show_main_settings(app: &AppHandle) -> tauri::Result<()> {
    show_main(app, "settings")
}

/// The main window: compact (owner: "not too broad"), opened on a given tab.
fn show_main(app: &AppHandle, tab: &str) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("popover") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!("window.dispatchEvent(new CustomEvent('dt:tab', {{ detail: '{tab}' }}))"));
        #[cfg(target_os = "macos")]
        {
            as_regular_app_if_full_screen(app);
            follow_desktop(&w);
        }
        w.show()?;
        return w.set_focus();
    }
    #[cfg(target_os = "macos")]
    as_regular_app_if_full_screen(app);
    let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(format!("index.html?view=main&tab={tab}").into()))
        .title(if test_build() { "DeviceTally (test)" } else { "DeviceTally" })
        .inner_size(900.0, 640.0)
        // Tauri's file-drop handler swallows the page's own drag and drop (reordering menu-bar items).
        .disable_drag_drop_handler()
        .min_inner_size(640.0, 480.0)
        .center()
        .build()?;
    #[cfg(target_os = "macos")]
    {
        follow_desktop(&w);
        // Closed: a menu-bar utility again (no Dock icon), unless the Dock icon is turned on.
        let a = app.clone();
        w.on_window_event(move |e| {
            if matches!(e, tauri::WindowEvent::Destroyed) && !a.state::<AppState>().config.lock().unwrap().show_in_dock {
                let _ = a.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        });
    }
    Ok(())
}

/// Whether you're in a full-screen app right now: its menu bar is hidden (the screen's visible
/// frame reaches the top). Main thread.
#[cfg(target_os = "macos")]
fn in_full_screen() -> bool {
    let mtm = unsafe { objc2_foundation::MainThreadMarker::new_unchecked() };
    objc2_app_kit::NSScreen::mainScreen(mtm).is_some_and(|s| {
        let (f, v) = (s.frame(), s.visibleFrame());
        (f.origin.y + f.size.height) - (v.origin.y + v.size.height) < 1.0
    })
}

/// In a full-screen app, DeviceTally opens its window like other apps, on a regular desktop: macOS
/// only does that for apps with a Dock icon, so it has one while that window is open.
#[cfg(target_os = "macos")]
fn as_regular_app_if_full_screen(app: &AppHandle) {
    if in_full_screen() {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
}

/// macOS: the main window opens on the desktop (Space) you're on, instead of switching you back to
/// the one where it was opened before.
#[cfg(target_os = "macos")]
fn follow_desktop(w: &tauri::WebviewWindow) {
    let w2 = w.clone();
    let _ = w.run_on_main_thread(move || {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let Ok(ptr) = w2.ns_window() else { return };
        // SAFETY: the live NSWindow of this webview window, used on the main thread.
        let win = unsafe { &*(ptr as *const NSWindow) };
        // On a normal desktop: open on the one you're on. In a full-screen app: like other apps, on a
        // regular desktop (macOS switches there) instead of floating over the full-screen app. A
        // full-screen space is spotted by its hidden menu bar (the screen's visible frame reaches the
        // top).
        let full_screen = in_full_screen();
        let b = win.collectionBehavior() - NSWindowCollectionBehavior::FullScreenAuxiliary;
        win.setCollectionBehavior(if full_screen { b - NSWindowCollectionBehavior::MoveToActiveSpace } else { b | NSWindowCollectionBehavior::MoveToActiveSpace });
    });
}

// The popover as a macOS panel that can take keyboard focus (a borderless panel can't by default).
#[cfg(target_os = "macos")]
objc2::define_class!(
    #[unsafe(super(objc2_app_kit::NSPanel, objc2_app_kit::NSWindow, objc2_app_kit::NSResponder, objc2::runtime::NSObject))]
    #[thread_kind = objc2::MainThreadOnly]
    #[name = "DeviceTallyPopoverPanel"]
    struct PopoverPanel;

    impl PopoverPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool {
            true
        }
    }
);

/// macOS: show the popover over full-screen apps and on every desktop, like other menu-bar apps.
/// Only a non-activating panel can do that: a normal window (or activating the app) makes macOS
/// switch to the desktop the app belongs to instead.
#[cfg(target_os = "macos")]
fn float_everywhere(w: &tauri::WebviewWindow) {
    use objc2::ClassType;
    use objc2_app_kit::{NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};
    let Ok(ptr) = w.ns_window() else { return };
    // SAFETY: Tauri returns the live NSWindow for this webview window, and setup runs on the main
    // thread. PopoverPanel adds no instance variables, so switching the class only changes behaviour.
    let win = unsafe { &*(ptr as *const NSWindow) };
    unsafe { objc2::runtime::AnyObject::set_class(win, PopoverPanel::class()) };
    win.setStyleMask(win.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    win.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    win.setLevel(NSPopUpMenuWindowLevel);
    win.setHidesOnDeactivate(false);
}

/// Above other windows on every desktop, without taking focus (the notification card).
#[cfg(target_os = "macos")]
fn on_every_desktop(w: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior};
    let Ok(ptr) = w.ns_window() else { return };
    // SAFETY: Tauri returns the live NSWindow for this webview window, on the main thread.
    let win = unsafe { &*(ptr as *const NSWindow) };
    win.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary | NSWindowCollectionBehavior::Stationary | NSWindowCollectionBehavior::IgnoresCycle);
    win.setLevel(NSPopUpMenuWindowLevel);
}

/// Keeps one menu-bar item per module in `want`, in order (macOS adds new items to the left, so
/// they're created right to left). Recreated only when the list changes.
fn sync_trays(app: &AppHandle, want: &[String]) {
    let state = app.state::<AppState>();
    let mut have = state.tray_items.lock().unwrap();
    if have.as_slice() == want {
        return;
    }
    for k in have.iter() {
        let _ = app.remove_tray_by_id(&format!("mb-{k}"));
    }
    state.item_icons.lock().unwrap().clear();
    have.clear();
    for k in want.iter().rev() {
        let id = format!("mb-{k}");
        let panel = k.clone();
        let Ok(menu) = tray_menu(app) else { continue };
        let built = TrayIconBuilder::with_id(&id)
            .icon(tauri::image::Image::new_owned(vec![0; 4 * 4 * 4], 4, 4))
            .icon_as_template(true)
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(move |tray, event| {
                tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    toggle_popover(tray.app_handle(), &panel);
                }
            })
            .on_menu_event(on_tray_menu)
            .build(app);
        if built.is_ok() {
            have.insert(0, k.clone());
        }
    }
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "dashboard", "Open DeviceTally", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit DeviceTally", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &settings, &PredefinedMenuItem::separator(app)?, &quit])
}

fn on_tray_menu(app: &AppHandle, e: tauri::menu::MenuEvent) {
    match e.id.as_ref() {
        "dashboard" => {
            let _ = show_main(app, "overview");
        }
        "settings" => {
            let _ = show_main_settings(app);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Keeps the last ~3 minutes of readings (one every 2 s) for the panels' graphs.
fn record(state: &AppState, s: &stats::Stats) {
    let mut h = state.history.lock().unwrap();
    // The menu bar and an open panel may both read; keep one point per ~2 s.
    if h.back().is_some_and(|p| now_ms() - p.t < 1500) {
        return;
    }
    h.push_back(stats::Point::from(s, now_ms()));
    while h.len() > 90 {
        h.pop_front();
    }
}

/// Opens the main window on a tab (e.g. a panel's "What's using space?" → Storage).
#[tauri::command]
fn open_tab(app: AppHandle, tab: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("popover") {
        let _ = w.hide();
    }
    let tab = if ["overview", "sessions", "devices", "menubar", "storage", "settings"].contains(&tab.as_str()) { tab } else { "overview".into() };
    show_main(&app, &tab).map_err(|e| e.to_string())
}

/// Top processes for the CPU ("cpu") or Memory ("mem") panel.
#[tauri::command]
async fn top_processes(state: State<'_, AppState>, by: String) -> Result<Vec<stats::Proc>, String> {
    Ok(state.sampler.lock().unwrap().top(&by, 5))
}

/// Network panel details: connectivity checks (ms, null = failed), latency, jitter, DNS, MAC and
/// the totals since the last reset.
#[tauri::command]
async fn net_details(state: State<'_, AppState>) -> Result<Value, String> {
    *state.net_wanted.lock().unwrap() = Some(std::time::Instant::now());
    let s = state.last_stats.lock().unwrap().clone();
    let base = *state.net_base.lock().unwrap();
    let (latency, jitter) = state.connectivity.lock().unwrap().latency();
    let checks: Vec<Option<f32>> = state.connectivity.lock().unwrap().checks.iter().copied().collect();
    let mac = sysinfo::Networks::new_with_refreshed_list().iter().find(|(n, _)| **n == s.net_iface).map(|(_, d)| d.mac_address().to_string()).unwrap_or_default();
    Ok(serde_json::json!({
        "checks": checks, "latency": latency, "jitter": jitter, "dns": net::dns(), "mac": mac,
        "total_down": s.net_total_down.saturating_sub(base.0), "total_up": s.net_total_up.saturating_sub(base.1), "reset": base != (0, 0),
    }))
}

/// Starts the network totals from zero now.
#[tauri::command]
async fn reset_net_totals(state: State<'_, AppState>) -> Result<(), String> {
    let s = state.last_stats.lock().unwrap().clone();
    *state.net_base.lock().unwrap() = (s.net_total_down, s.net_total_up);
    Ok(())
}

/// Apps using the network now (macOS), busiest first.
#[tauri::command]
async fn net_processes(app: AppHandle) -> Result<Vec<net::NetProc>, String> {
    tokio::task::spawn_blocking(move || app.state::<AppState>().net_apps.lock().unwrap().top(6)).await.map_err(|e| e.to_string())
}

/// This connection's public address, country and provider (ipinfo.io), asked only while the
/// Network panel is open, at most every 30 minutes unless refreshed.
#[tauri::command]
async fn public_ip(state: State<'_, AppState>, refresh: bool) -> Result<Value, String> {
    if let Some((t, v)) = state.public_ip.lock().unwrap().clone() {
        if !refresh && t.elapsed() < Duration::from_secs(1800) {
            return Ok(v);
        }
    }
    let v: Value = state.http.get("https://ipinfo.io/json").send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let v = serde_json::json!({ "ip": v["ip"], "country": v["country"], "city": v["city"], "org": v["org"] });
    *state.public_ip.lock().unwrap() = Some((std::time::Instant::now(), v.clone()));
    Ok(v)
}

/// Recent readings for a panel's graph.
#[tauri::command]
async fn stats_history(state: State<'_, AppState>) -> Result<Vec<stats::Point>, String> {
    Ok(state.history.lock().unwrap().iter().cloned().collect())
}

/// The panel to show when the popover opens ("all", or one module such as "net").
#[tauri::command]
async fn current_panel(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.panel.lock().unwrap().clone())
}

/// Popover height per panel: the full summary is tall, a module's panel shorter.
fn panel_height(panel: &str) -> f64 {
    match panel {
        "all" | "tokens" => 600.0,
        "agent" => 540.0,
        "net" => 640.0,
        "clock" => 380.0,
        "disk" => 340.0,
        _ => 460.0,
    }
}

fn toggle_popover(app: &AppHandle, panel: &str) {
    let Some(w) = app.get_webview_window("popover") else { return };
    let state = app.state::<AppState>();
    let same = *state.panel.lock().unwrap() == panel;
    if w.is_visible().unwrap_or(false) && same {
        let _ = w.hide();
    } else {
        *state.activity_seen.lock().unwrap() = now_ms();
        *state.panel.lock().unwrap() = panel.to_string();
        let _ = w.emit("dt:panel", panel.to_string());
        let _ = w.set_size(tauri::LogicalSize::new(340.0, panel_height(panel)));
        let _ = w.move_window(Position::TrayCenter);
        let _ = w.show();
        // macOS: the panel takes focus itself; activating the app would leave the full-screen space.
        #[cfg(not(target_os = "macos"))]
        let _ = w.set_focus();
    }
}

pub fn run() {
    // macOS puts a gap (about 16 pt) between menu-bar items, read when an app starts. DeviceTally
    // sets its own copy to 0, so its items sit together (the Spacing setting adds room); other
    // apps' items keep the Mac-wide value.
    #[cfg(target_os = "macos")]
    {
        let d = objc2_foundation::NSUserDefaults::standardUserDefaults();
        d.setInteger_forKey(0, &objc2_foundation::NSString::from_str("NSStatusItemSpacing"));
        d.setInteger_forKey(2, &objc2_foundation::NSString::from_str("NSStatusItemSelectionPadding"));
    }
    tauri::Builder::default()
        // One DeviceTally at a time: opening it again (Finder, Spotlight, login) shows the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_main(app, "overview");
        }))
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![status, sign_in, sign_out, summary, add_this_device, connect_with_code, setup_local, api, save_export, create_admin, create_server, update_server, delete_server, bundled_server_version, disconnect_this_computer, servers, switch_server, get_menubar, set_menubar, set_dock, get_dock, set_menubar_live, menubar_preview, menubar_dark, test_build, system_stats, stats_history, current_panel, top_processes, net_details, reset_net_totals, net_processes, public_ip, open_tab, activity, agent_history, test_alert, open_notification_settings, card_action, show_notice, card_update, in_use, update_policy, report_update_error, preview_sound, list_sounds, storage_scan, open_full_disk_access, reveal_path, trash_path, lock_status, lock_computer, unlock_computer, open_dashboard, open_settings, quit])
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = load_config(&handle);
            // A menu-bar utility: no Dock icon or app switcher entry, unless asked for.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(if cfg.show_in_dock { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
            app.manage(AppState {
                config: Mutex::new(cfg.clone()),
                http: reqwest::Client::builder().timeout(Duration::from_secs(15)).dns_resolver(std::sync::Arc::new(netx::Resolver)).build()?,
                token: Mutex::new(Some(read_session(&handle, &cfg.server))),
                agent: Mutex::new(read_agent()),
                sampler: Mutex::new(stats::Sampler::new()),
                last_stats: Mutex::new(stats::Stats::default()),
                tokens_today: Mutex::new(None),
                activity_seen: Mutex::new(now_ms()),
                seen_sessions: Mutex::new(None),
                disk_alerted: Mutex::new(0),
                device_alerted: Mutex::new(None),
                animating: std::sync::atomic::AtomicBool::new(false),
                agent_now: Mutex::new((menubar::Agent::Idle, 0)),
                temp: Mutex::new(None),
                card_id: std::sync::atomic::AtomicI64::new(0),
                last_sample: Mutex::new(None),
                tray_items: Mutex::new(vec![]),
                agent_log: Mutex::new(std::fs::read(agent_dir().join("app-agent-history.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()),
                update_error: Mutex::new(None),
                battery_change: Mutex::new((None, None)),
                battery_moving: Default::default(),
                connectivity: Mutex::new(Default::default()),
                net_apps: Mutex::new(Default::default()),
                net_base: Mutex::new((0, 0)),
                public_ip: Mutex::new(None),
                net_wanted: Mutex::new(None),
                item_icons: Mutex::new(Default::default()),
                panel: Mutex::new("all".into()),
                history: Mutex::new(Default::default()),
            });

            let open = MenuItem::with_id(app, "dashboard", "Open DeviceTally", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit DeviceTally", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &settings, &PredefinedMenuItem::separator(app)?, &quit])?;

            // macOS: a monochrome template icon the menu bar tints for light/dark (native look).
            // Windows/Linux: the coloured app icon, since a black one vanishes on dark taskbars.
            #[cfg(target_os = "macos")]
            let (icon, template) = (tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?, true);
            #[cfg(not(target_os = "macos"))]
            let (icon, template) = (app.default_window_icon().unwrap().clone(), false);
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .icon_as_template(template)
                .tooltip("DeviceTally")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_popover(tray.app_handle(), "all");
                    }
                })
                .on_menu_event(on_tray_menu)
                .build(app)?;

            #[cfg(target_os = "macos")]
            if let Some(mtm) = objc2_foundation::MainThreadMarker::new() {
                notify::setup(mtm);
            }
            // The popover closes when it loses focus, like a system popover.
            if let Some(w) = app.get_webview_window("popover") {
                #[cfg(target_os = "macos")]
                float_everywhere(&w);
                let w2 = w.clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::Focused(false) = e {
                        let _ = w2.hide();
                    }
                });
            }

            // First run: no server yet, so open Settings to sign in.
            if cfg.server.is_empty() && read_agent().is_none() {
                let _ = show_main_settings(&handle);
            }

            // Support check: DEVICETALLY_NOTIFY_SELFTEST=1 sends one test notification at start.
            if std::env::var("DEVICETALLY_NOTIFY_SELFTEST").is_ok() {
                #[cfg(target_os = "macos")]
                notify_mac(&handle, "DeviceTally test", "Notifications work (self-test)", Some("Glass"), |r| eprintln!("selftest notification: {r}"));
            }
            // Support check: DEVICETALLY_MENUBAR_SELFTEST=1 adds and removes menu-bar items 40 times
            // from other threads (as Settings does) and reports whether the app stayed responsive.
            if std::env::var("DEVICETALLY_MENUBAR_SELFTEST").is_ok() {
                let h3 = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let st = h3.state::<AppState>();
                    let orig = st.config.lock().unwrap().menubar.clone();
                    let sets: [&[&str]; 4] = [&["agent", "net", "temp"], &["agent"], &["cpu", "mem", "disk", "clock"], &["net", "agent"]];
                    let jobs: Vec<_> = (0..40).map(|i| { let h = h3.clone(); let items: Vec<String> = sets[i % 4].iter().map(|x| x.to_string()).collect(); let mut c = orig.clone(); c.items = items; c.combined = i % 7 == 0;
                        tauri::async_runtime::spawn(async move { h.state::<AppState>().config.lock().unwrap().menubar = c; draw_menubar(&h); }) }).collect();
                    for j in jobs { let _ = j.await; }
                    st.config.lock().unwrap().menubar = orig;
                    draw_menubar(&h3);
                    let (tx, rx) = std::sync::mpsc::channel();
                    let _ = h3.run_on_main_thread(move || { let _ = tx.send(()); });
                    eprintln!("selftest menubar: {}", if rx.recv_timeout(Duration::from_secs(5)).is_ok() { "responsive" } else { "FROZE" });
                });
            }
            std::thread::spawn(update_tracker);
            // `npm run try` (local testing): open the main window right away, so it's clear the app is up.
            if std::env::var("DEVICETALLY_OPEN_WINDOW").is_ok() {
                let _ = show_main(&handle, "overview");
            }
            // Connectivity checks every 2 s while the Network panel was looked at in the last 15 s (one
            // small connection to 1.1.1.1, like Stats). Only the panel shows them; checking all day
            // for the menu-bar item kept Wi-Fi from resting.
            let h4 = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    let st = h4.state::<AppState>();
                    let looked = st.net_wanted.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_secs(15));
                    if looked {
                        let r = tokio::task::spawn_blocking(net::probe).await.ok().flatten();
                        st.connectivity.lock().unwrap().push(r);
                    }
                }
            });
            // Today's tokens every 5 minutes; the menu-bar item (network, CPU, clock…) every 2 seconds.
            let h2 = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    refresh_tray(&handle).await;
                    heartbeat(&handle).await;
                    disk_check(&handle);
                    device_check(&handle).await;
                    tokio::time::sleep(Duration::from_secs(300)).await;
                }
            });
            tauri::async_runtime::spawn(async move {
                let mut last_full = std::time::Instant::now();
                loop {
                    let fast = h2.state::<AppState>().animating.load(std::sync::atomic::Ordering::Relaxed);
                    tokio::time::sleep(Duration::from_millis(if fast { FRAME_MS } else { 2000 })).await;
                    // Everything every 2 s; in between only the turning ring.
                    if !fast || last_full.elapsed() >= Duration::from_secs(2) || !draw_ring(&h2) {
                        draw_menubar(&h2);
                        last_full = std::time::Instant::now();
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running DeviceTally")
        .run(|app, e| {
            // Clicking DeviceTally in the Dock (or opening it again from Finder) opens its window.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = e {
                let _ = show_main(app, "overview");
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, e);
        });
}

#[cfg(test)]
mod tests {

    #[test]
    fn device_alerts_cover_blocks_and_recent_events() {
        use super::device_alerts;
        let now = 100_000_000;
        let devices = serde_json::json!([
            { "id": "a", "name": "Dibbya", "revoked_at": null, "health": { "server_blocked": true, "hooks": "user", "events": [
                { "at": now - 1000, "kind": "hosts", "text": "Hosts file edited" },
                { "at": now - 2000, "kind": "silent", "text": "Couldn't reach the server for 1h: no internet connection" },
                { "at": now - 90_000_000, "kind": "hooks", "text": "old" } ] } },
            { "id": "b", "name": "Old", "revoked_at": 5, "health": { "server_blocked": true } },
            { "id": "c", "name": "Riya", "revoked_at": null, "health": null }
        ]);
        let keys: Vec<String> = device_alerts(&devices, now).into_iter().map(|(k, ..)| k).collect();
        assert_eq!(keys, vec!["a:blocked".to_string(), format!("a:ev:{}:hosts", now - 1000)]);
    }

    #[test]
    fn update_policy_device_beats_global() {
        let cfg = serde_json::json!({ "device_id": "d1", "settings": [
            { "scope": "global", "scope_id": "", "json": { "app_updates": "auto" } },
            { "scope": "device", "scope_id": "d2", "json": { "app_updates": "ask", "update_now": 5 } },
        ] });
        assert_eq!(super::policy_of(&cfg), ("auto".into(), 0), "global applies; another device's row doesn't");
        let cfg = serde_json::json!({ "device_id": "d2", "settings": cfg["settings"] });
        assert_eq!(super::policy_of(&cfg), ("ask".into(), 5), "the device's own choice and update-now");
        assert_eq!(super::policy_of(&serde_json::json!({})), ("auto".into(), 0), "default: automatic");
    }

    #[test]
    fn export_file_dates() {
        assert_eq!(super::ymd(0), "1970-01-01");
        assert_eq!(super::ymd(20_729), "2026-10-03");
        assert_eq!(super::ymd(11_016), "2000-02-29");
    }

    #[test]
    fn menu_bar_numbers_are_short() {
        use super::fmt_short;
        assert_eq!(fmt_short(150_660_000.0), "151M");
        assert_eq!(fmt_short(1_726_320.0), "1.7M");
        assert_eq!(fmt_short(2_000_000.0), "2M");
        assert_eq!(fmt_short(12_400.0), "12K");
        assert_eq!(fmt_short(950.0), "950");
        assert_eq!(fmt_short(0.0), "0");
    }

}
