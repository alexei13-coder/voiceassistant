fn main() {
    // Явный список команд приложения: без этого Tauri разрешает их всем окнам,
    // а так каждая требует разрешения в capabilities (allow-core-connection, allow-emergency-stop).
    let manifest = tauri_build::AppManifest::new().commands(&["core_connection", "emergency_stop"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("не удалось подготовить сборку Tauri");
}
