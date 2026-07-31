//! Independent Window Server proof for the AppKit shell.

#[cfg(target_os = "macos")]
use std::ffi::c_void;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSDate, NSRunLoop};
#[cfg(target_os = "macos")]
use orbit_child_runtime::window::WindowShell;
#[cfg(target_os = "macos")]
use orbit_child_ui::UiSize;

#[cfg(target_os = "macos")]
type CFIndex = isize;
#[cfg(target_os = "macos")]
type CFArrayRef = *const c_void;
#[cfg(target_os = "macos")]
type CFDictionaryRef = *const c_void;
#[cfg(target_os = "macos")]
type CFNumberRef = *const c_void;
#[cfg(target_os = "macos")]
type CFTypeRef = *const c_void;

#[cfg(target_os = "macos")]
const K_CF_NUMBER_SINT32_TYPE: u32 = 3;
#[cfg(target_os = "macos")]
const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1;
#[cfg(target_os = "macos")]
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    /// Whether this process already holds Screen Recording (screen capture) permission.
    /// Non-prompting, unlike `CGRequestScreenCaptureAccess`.
    fn CGPreflightScreenCaptureAccess() -> bool;
    static kCGWindowNumber: CFTypeRef;
    static kCGWindowOwnerPID: CFTypeRef;
}

/// Fail loudly and actionably when the window-server query cannot work at all.
///
/// 🔴 Without Screen Recording permission `CGWindowListCopyWindowInfo` returns NULL, so every
/// lookup reports "window absent" and the assertions below become **indistinguishable from a
/// genuinely missing window** (measured 2026-07-31: `CGPreflightScreenCaptureAccess() == false`
/// → NULL list → the test failed while `NSWindow #993` existed perfectly well).
///
/// This must **fail**, never skip: this test is the only independent evidence that a window
/// really reached the window server, and a silent skip would turn "never verified" into green.
#[cfg(target_os = "macos")]
fn require_screen_capture_permission() {
    assert!(
        unsafe { CGPreflightScreenCaptureAccess() },
        "this process lacks Screen Recording permission, so CGWindowListCopyWindowInfo returns \
         NULL and cannot witness any window. Grant it in System Settings → Privacy & Security → \
         Screen Recording for the process running the tests, then re-run. Do not weaken this \
         test: it is the only check independent of the child's own report."
    );
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, index: CFIndex) -> *const c_void;
    fn CFDictionaryGetValue(dictionary: CFDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFNumberGetValue(number: CFNumberRef, number_type: u32, value: *mut c_void) -> bool;
    fn CFRelease(value: CFTypeRef);
}

#[cfg(target_os = "macos")]
struct OwnedWindowList(CFArrayRef);

#[cfg(target_os = "macos")]
impl Drop for OwnedWindowList {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

#[cfg(target_os = "macos")]
fn dictionary_i32(dictionary: CFDictionaryRef, key: CFTypeRef) -> Option<i32> {
    let number = unsafe { CFDictionaryGetValue(dictionary, key) };
    if number.is_null() {
        return None;
    }
    let mut value = 0i32;
    unsafe {
        CFNumberGetValue(
            number,
            K_CF_NUMBER_SINT32_TYPE,
            std::ptr::addr_of_mut!(value).cast(),
        )
        .then_some(value)
    }
}

#[cfg(target_os = "macos")]
fn window_server_contains(window_number: u32, owner_pid: u32) -> bool {
    let list = unsafe {
        CGWindowListCopyWindowInfo(
            K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            0,
        )
    };
    if list.is_null() {
        return false;
    }
    let list = OwnedWindowList(list);
    let count = unsafe { CFArrayGetCount(list.0) };
    (0..count).any(|index| {
        let dictionary = unsafe { CFArrayGetValueAtIndex(list.0, index) };
        dictionary_i32(dictionary, unsafe { kCGWindowNumber }) == Some(window_number as i32)
            && dictionary_i32(dictionary, unsafe { kCGWindowOwnerPID }) == Some(owner_pid as i32)
    })
}

/// Every on-screen window this process owns, for diagnosing a failed match.
#[cfg(target_os = "macos")]
fn own_window_numbers() -> Vec<i32> {
    let list = unsafe {
        CGWindowListCopyWindowInfo(
            K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            0,
        )
    };
    if list.is_null() {
        return Vec::new();
    }
    let list = OwnedWindowList(list);
    let count = unsafe { CFArrayGetCount(list.0) };
    let me = std::process::id() as i32;
    (0..count)
        .filter_map(|index| {
            let dictionary = unsafe { CFArrayGetValueAtIndex(list.0, index) };
            (dictionary_i32(dictionary, unsafe { kCGWindowOwnerPID }) == Some(me))
                .then(|| dictionary_i32(dictionary, unsafe { kCGWindowNumber }))
                .flatten()
        })
        .collect()
}

/// Poll the window server while **letting AppKit run**.
///
/// 🔴 `makeKeyAndOrderFront` only schedules the ordering; the window reaches the window server
/// when the main run loop next processes events. Sleeping instead of running the loop leaves the
/// window permanently absent from `CGWindowListCopyWindowInfo`, which is indistinguishable from
/// "the window was never created" — so this loop must pump, not sleep.
#[cfg(target_os = "macos")]
fn wait_for_window_state(window_number: u32, expected: bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if window_server_contains(window_number, std::process::id()) == expected {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.02));
    }
}

#[cfg(target_os = "macos")]
fn run_window_shell_exists_in_cgwindowlist_and_disappears_after_close() {
    require_screen_capture_permission();

    let mtm = MainThreadMarker::new().expect("gated test must run on the process main thread");
    let app = NSApplication::sharedApplication(mtm);
    let _ = app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();

    let mut shell = WindowShell::new(
        UiSize {
            width: 360,
            height: 220,
        },
        true,
        || false,
    )
    .expect("create WindowShell");
    let window_number = shell.window_number();

    assert!(
        wait_for_window_state(window_number, true),
        "CGWindowListCopyWindowInfo did not contain this process's NSWindow #{window_number}. \
         on-screen windows owned by this process: {:?}",
        own_window_numbers()
    );

    shell.close();

    assert!(
        wait_for_window_state(window_number, false),
        "CGWindowListCopyWindowInfo still contained closed NSWindow #{window_number}"
    );
}

#[test]
#[ignore = "requires a logged-in macOS Window Server session"]
#[cfg(target_os = "macos")]
fn window_shell_exists_in_cgwindowlist_and_disappears_after_close() {
    run_window_shell_exists_in_cgwindowlist_and_disappears_after_close();
}

#[cfg(target_os = "macos")]
fn main() {
    let run_ignored = std::env::args().any(|arg| arg == "--ignored");
    println!("running 1 test");
    if !run_ignored {
        println!("test window_shell_exists_in_cgwindowlist_and_disappears_after_close ... ignored");
        println!();
        println!("test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out");
        return;
    }

    print!("test window_shell_exists_in_cgwindowlist_and_disappears_after_close ... ");
    let result = std::panic::catch_unwind(|| {
        run_window_shell_exists_in_cgwindowlist_and_disappears_after_close()
    });
    match result {
        Ok(()) => {
            println!("ok");
            println!();
            println!("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
        }
        Err(payload) => {
            println!("FAILED");
            println!();
            println!("failures:");
            println!("    window_shell_exists_in_cgwindowlist_and_disappears_after_close");
            println!();
            println!(
                "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out"
            );
            std::panic::resume_unwind(payload);
        }
    }
}

/// Off macOS there is no Window Server to witness, so this harness reports and exits 0
/// rather than failing — the suite it belongs to is gated on a logged-in macOS session.
#[cfg(not(target_os = "macos"))]
fn main() {
    println!("window_shell_gated is macOS-only; nothing to run on this platform");
}
