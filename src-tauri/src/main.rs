// PeterCord – Desktop-Hülle. Die Oberfläche liegt in ../app, hier passiert nur, was ein Browser nicht kann:
// Updates, Benachrichtigungen, Tray-Symbol, Autostart und Links im Standardbrowser öffnen.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, UserAttentionType, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// Startet PeterCord mit diesem Argument, bleibt das Fenster zu (Autostart mit Windows).
const HIDDEN_ARG: &str = "--hidden";

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Symbole für den Infobereich: normal und mit rotem Punkt für ungelesene Nachrichten.
struct Icons {
    base: Image<'static>,
    alert: Image<'static>,
    dot: Image<'static>,
}

/// Malt einen weich gezeichneten Kreis in ein RGBA-Bild.
fn paint_circle(px: &mut [u8], w: u32, h: u32, cx: f32, cy: f32, r: f32, color: [u8; 3]) {
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let a = (r + 0.5 - d).clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            let i = ((y * w + x) * 4) as usize;
            let below = px[i + 3] as f32 / 255.0;
            let out = a + below * (1.0 - a);
            for k in 0..3 {
                let mixed = (color[k] as f32 * a + px[i + k] as f32 * below * (1.0 - a)) / out;
                px[i + k] = mixed.round() as u8;
            }
            px[i + 3] = (out * 255.0).round() as u8;
        }
    }
}

fn make_icons(base: Image<'static>) -> Icons {
    let (w, h) = (base.width(), base.height());
    let mut px = base.rgba().to_vec();
    let r = w as f32 * 0.25;
    let (cx, cy) = (w as f32 - r - 1.0, h as f32 - r - 1.0);
    paint_circle(&mut px, w, h, cx, cy, r + w as f32 * 0.07, [13, 23, 22]);
    paint_circle(&mut px, w, h, cx, cy, r, [255, 92, 112]);
    let alert = Image::new_owned(px, w, h);

    let mut dot = vec![0u8; 32 * 32 * 4];
    paint_circle(&mut dot, 32, 32, 16.0, 16.0, 13.0, [255, 92, 112]);
    Icons { base, alert, dot: Image::new_owned(dot, 32, 32) }
}

/// Sparmodus für den Tray: Solange das Fenster versteckt ist, zeichnet die Oberfläche nichts mehr und
/// WebView2 gibt Arbeitsspeicher frei. Nachrichten kommen trotzdem an. Beim Öffnen gilt wieder Normalbetrieb.
fn set_active(window: &tauri::WebviewWindow, active: bool) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;
        let _ = window.with_webview(move |webview| unsafe {
            let controller = webview.controller();
            let _ = controller.SetIsVisible(active);
            if let Ok(core) = controller.CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_19>()) {
                let level = if active {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                };
                let _ = core.SetMemoryUsageTargetLevel(level);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (window, active);
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        set_active(&w, true);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() }))
}

/// Lädt das Update, prüft die Signatur und startet den Installer. Unter Windows beendet sich die App dabei
/// selbst und wird vom Installer neu gestartet.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = update {
        update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Nur Web-Adressen können geöffnet werden.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Lässt das Symbol in der Taskleiste blinken, wenn das Fenster nicht im Vordergrund ist.
#[tauri::command]
fn attention(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_focused().unwrap_or(false) {
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
}

/// Zeigt ungelesene Nachrichten am Tray-Symbol und in der Taskleiste an.
#[tauri::command]
fn set_unread(app: AppHandle, count: u32) {
    let icons = app.state::<Icons>();
    if let Some(tray) = app.tray_by_id("main") {
        let icon = if count > 0 { icons.alert.clone() } else { icons.base.clone() };
        let _ = tray.set_icon(Some(icon));
        let tip = match count {
            0 => "PeterCord".to_string(),
            1 => "PeterCord – 1 ungelesene Nachricht".to_string(),
            n => format!("PeterCord – {n} ungelesene Nachrichten"),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_overlay_icon(if count > 0 { Some(icons.dot.clone()) } else { None });
    }
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    let auto = app.autolaunch();
    let result = if enabled { auto.enable() } else { auto.disable() };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        .invoke_handler(tauri::generate_handler![
            check_update,
            install_update,
            notify,
            open_url,
            attention,
            set_unread,
            autostart_get,
            autostart_set,
            app_version
        ])
        .setup(|app| {
            let icons = make_icons(app.default_window_icon().expect("App-Symbol fehlt").clone().to_owned());
            let open = MenuItem::with_id(app, "open", "PeterCord öffnen", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(icons.base.clone())
                .tooltip("PeterCord")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;
            app.manage(icons);
            // Das Fenster ist anfangs unsichtbar; beim Autostart mit Windows bleibt es das auch.
            if !std::env::args().any(|a| a == HIDDEN_ARG) {
                show(app.handle());
            } else if let Some(w) = app.get_webview_window("main") {
                set_active(&w, false);
            }
            Ok(())
        })
        // Schließen versteckt das Fenster nur; PeterCord läuft im Tray weiter und meldet neue Nachrichten.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    set_active(&w, false);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("PeterCord konnte nicht gestartet werden");
}
