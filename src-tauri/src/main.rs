use tauri::{GlobalShortcutManager, Manager, WindowEvent};

fn show_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_window("main") {
    window.show().expect("failed to show main window");
    window.unminimize().expect("failed to restore main window");
    window.set_focus().expect("failed to focus main window");
  }
}

fn main() {
  tauri::Builder::default()
    .on_window_event(|event| {
      if let WindowEvent::CloseRequested { api, .. } = event.event() {
        api.prevent_close();
        event.window().hide().expect("failed to hide window");
      }
    })
    .setup(|app| {
      let app_handle = app.handle();
      let mut shortcut_manager = app.global_shortcut_manager();

      shortcut_manager
        .register("CmdOrCtrl+K", move || show_main_window(&app_handle))
      .expect("failed to register global shortcut");

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
