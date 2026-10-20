//! Чем запускать ядро. В релизе — собранный PyInstaller-exe из ресурсов установщика,
//! в отладке — исходники из `core/` через uv (с переопределением через переменные окружения).

use std::ffi::OsString;
use std::path::PathBuf;

use tauri::AppHandle;

pub struct CoreCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub current_dir: Option<PathBuf>,
}

#[cfg(not(debug_assertions))]
pub fn resolve(app: &AppHandle) -> Result<CoreCommand, String> {
    use tauri::{path::BaseDirectory, Manager};

    const CORE_EXE: &str = if cfg!(windows) {
        "core/jarvis-core.exe"
    } else {
        "core/jarvis-core"
    };
    let program = app
        .path()
        .resolve(CORE_EXE, BaseDirectory::Resource)
        .map_err(|err| format!("Не найдена папка ресурсов приложения: {err}"))?;
    if !program.is_file() {
        return Err(format!(
            "Не найден файл ядра {} — переустановите приложение",
            program.display()
        ));
    }
    Ok(CoreCommand {
        program: program.into(),
        args: vec!["--port".into(), "0".into()],
        current_dir: None,
    })
}

#[cfg(debug_assertions)]
pub fn resolve(_app: &AppHandle) -> Result<CoreCommand, String> {
    use std::path::Path;

    // Путь вычисляется при сборке: отладочная оболочка всегда запускается из этого репозитория.
    let core_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(|repo| repo.join("core"))
        .ok_or("Не удалось определить папку core/ репозитория")?;

    let program = std::env::var_os("JARVIS_CORE_PROGRAM")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "uv".into());
    let args = match std::env::var("JARVIS_CORE_ARGS") {
        Ok(raw) if !raw.trim().is_empty() => raw.split_whitespace().map(OsString::from).collect(),
        _ => {
            let mut args: Vec<OsString> = vec!["run".into(), "--project".into()];
            args.push(core_dir.clone().into());
            args.extend(["python", "-m", "jarvis", "--dev", "--port", "0"].map(OsString::from));
            args
        }
    };
    Ok(CoreCommand {
        program,
        args,
        current_dir: Some(core_dir),
    })
}
