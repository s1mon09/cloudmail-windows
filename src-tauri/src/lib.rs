use keyring::Entry;

const SERVICE: &str = "site.kodao.cloudmail";

#[tauri::command]
fn save_secret(account: String, secret: String) -> Result<(), String> {
    Entry::new(SERVICE, &account)
        .map_err(|error| error.to_string())?
        .set_password(&secret)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_secret(account: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, &account).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn delete_secret(account: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &account).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(_) => Ok(()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![save_secret, get_secret, delete_secret])
        .run(tauri::generate_context!())
        .expect("error while running CloudMail");
}
