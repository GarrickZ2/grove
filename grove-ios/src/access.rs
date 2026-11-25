//! Signing in to whatever stands in front of a server.
//!
//! An access proxy answers with a redirect to its sign-in page, and only a
//! person can get through that (a one-time code, MFA). So the person does, on
//! a native sheet that follows the redirects, and the app keeps the cookies
//! the server's own host ended up with. Nothing here knows which proxy it was.
//!
//! Getting a code often means leaving the app, and the loopback listeners stop
//! while it is in the background: a sign-in never depends on a request that is
//! still open. The page starts one, then asks how it is going.

use std::{
    collections::HashMap,
    sync::{Mutex, RwLock},
};
use tokio::sync::mpsc;

#[cfg(target_os = "ios")]
use std::ffi::{c_char, CStr};

/// What the sheet reports: the cookies of a page on the server's own host, or
/// `None` once the person closes it.
pub type Report = Option<String>;

static SHEET: Mutex<Option<mpsc::UnboundedSender<Report>>> = Mutex::new(None);

#[cfg(target_os = "ios")]
extern "C" {
    fn grove_access_open(url: *const c_char, report: extern "C" fn(*const c_char));
    fn grove_access_close();
    fn grove_session_read(server: *const c_char) -> *mut c_char;
    fn grove_session_write(server: *const c_char, cookie: *const c_char);
    fn grove_session_free(value: *mut c_char);
}

#[cfg(target_os = "ios")]
extern "C" fn sheet_reported(cookie: *const c_char) {
    let report = (!cookie.is_null()).then(|| {
        unsafe { CStr::from_ptr(cookie) }
            .to_string_lossy()
            .into_owned()
    });
    report_from_sheet(report);
}

pub fn report_from_sheet(report: Report) {
    if let Some(sheet) = SHEET.lock().unwrap().as_ref() {
        let _ = sheet.send(report);
    }
}

/// Show the sheet on `url`, in place of one already open.
pub fn open_sheet(url: &str) -> mpsc::UnboundedReceiver<Report> {
    let (sender, receiver) = mpsc::unbounded_channel();
    *SHEET.lock().unwrap() = Some(sender);
    #[cfg(target_os = "ios")]
    if let Ok(url) = std::ffi::CString::new(url) {
        unsafe { grove_access_open(url.as_ptr(), sheet_reported) };
    }
    #[cfg(not(target_os = "ios"))]
    let _ = url;
    receiver
}

pub fn close_sheet() {
    *SHEET.lock().unwrap() = None;
    #[cfg(target_os = "ios")]
    unsafe {
        grove_access_close()
    };
}

/// The `Cookie` header each server's front door takes, kept in the Keychain.
#[derive(Default)]
pub struct Sessions(RwLock<HashMap<String, Option<String>>>);

impl Sessions {
    pub fn get(&self, server: &str) -> Option<String> {
        if let Some(known) = self.0.read().unwrap().get(server) {
            return known.clone();
        }
        let stored = read_keychain(server);
        self.0
            .write()
            .unwrap()
            .insert(server.to_owned(), stored.clone());
        stored
    }

    /// An empty cookie forgets the session.
    pub fn set(&self, server: &str, cookie: &str) {
        write_keychain(server, cookie);
        let value = (!cookie.is_empty()).then(|| cookie.to_owned());
        self.0.write().unwrap().insert(server.to_owned(), value);
    }
}

#[cfg(target_os = "ios")]
fn read_keychain(server: &str) -> Option<String> {
    let server = std::ffi::CString::new(server).ok()?;
    unsafe {
        let value = grove_session_read(server.as_ptr());
        if value.is_null() {
            return None;
        }
        let cookie = CStr::from_ptr(value).to_string_lossy().into_owned();
        grove_session_free(value);
        Some(cookie)
    }
}

#[cfg(target_os = "ios")]
fn write_keychain(server: &str, cookie: &str) {
    use std::ffi::CString;
    if let (Ok(server), Ok(cookie)) = (CString::new(server), CString::new(cookie)) {
        unsafe { grove_session_write(server.as_ptr(), cookie.as_ptr()) };
    }
}

#[cfg(not(target_os = "ios"))]
fn read_keychain(_server: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "ios"))]
fn write_keychain(_server: &str, _cookie: &str) {}
