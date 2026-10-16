fn main() {
    println!("cargo:rerun-if-env-changed=GROVE_IOS_SERVER_URL");
    println!("cargo:rerun-if-env-changed=TAURI_GROVE_IOS_SERVER_URL");
    if let Ok(server) = std::env::var("TAURI_GROVE_IOS_SERVER_URL") {
        println!("cargo:rustc-env=GROVE_IOS_SERVER_URL={server}");
    }
    #[cfg(feature = "app")]
    tauri_build::build();
}
