//! Reliable macOS dragging for floating NSH panels (companion pet, desktop cards).
//!
//! NSH opens floating panels (`kind: "panel"`, `activate: false`) as `NshPanel`
//! instances with `NSWindowStyleMask::NonactivatingPanel`, and starts drags
//! from `window_press_drag` by calling `-[NSWindow performWindowDragWithEvent:]`
//! with a `LeftMouseDragged` event once pointer movement passes the click slop.
//! When OpenBitFun is not the active foreground application (and on recent
//! macOS builds where SkyLight rejects client-initiated drags started from
//! `LeftMouseDragged` on non-activating panels), AppKit's
//! `performWindowDragWithEvent:` silently ignores the drag until the user
//! activates the app first.
//!
//! Installing a narrow `performWindowDragWithEvent:` override on `NSPanel`
//! scoped strictly to `NshPanel` instances tracks screen-space cursor movement
//! via `NSEvent::mouseLocation()` and `NSWindow::setFrameOrigin:` inside
//! `NSEventTrackingRunLoopMode`. That drags immediately on the very first
//! press-and-drag regardless of whether OpenBitFun is foreground or background,
//! without stealing focus from the active application, while leaving system
//! panels (`NSOpenPanel`/`NSSavePanel`), clicks, right-click menus, and normal
//! app windows untouched.

use std::ffi::{c_void, CStr};
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::Once;
use std::time::{Duration, Instant};

use objc2::ffi::{
    class_addMethod, class_getInstanceMethod, method_getImplementation, method_getTypeEncoding,
    method_setImplementation,
};
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, ClassType, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSEvent, NSEventMask, NSEventTrackingRunLoopMode, NSEventType, NSPanel, NSWindow,
};
use objc2_foundation::{NSDate, NSPoint};

/// Objective-C class name registered by `nsh-platform-macos` for `WindowKind::{Panel, Popup, Overlay}`.
const NSH_PANEL_CLASS_NAME: &CStr = c"NshPanel";

/// Polling interval while tracking a drag so inactive apps still follow cursor
/// motion smoothly and detect button release promptly even if a mouse-up event
/// is lost outside the app.
const DRAG_POLL_INTERVAL_SECS: f64 = 0.016;

/// Minimum origin delta (in points) before moving the window to avoid redundant
/// frame updates when the pointer is stationary.
const DRAG_MOVE_EPSILON: f64 = 0.25;

/// Defensive upper bound for drags whose starting button state is not reflected
/// in `NSEvent::pressedMouseButtons()` (e.g. accessibility three-finger drag or
/// synthetic drag events) if `LeftMouseUp` is never delivered.
const SYNTHETIC_DRAG_IDLE_TIMEOUT: Duration = Duration::from_secs(5);

type PerformWindowDragFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSEvent);

static INSTALL_ONCE: Once = Once::new();
static ORIGINAL_IMP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

/// Installs the `NSPanel` `performWindowDragWithEvent:` override once per process.
pub(crate) fn install() {
    INSTALL_ONCE.call_once(|| {
        let panel_cls: *const AnyClass = NSPanel::class();
        let selector = sel!(performWindowDragWithEvent:);
        // SAFETY: `panel_cls` is the registered AppKit `NSPanel` class and
        // `selector` is the standard `NSWindow` instance method selector.
        let method = unsafe { class_getInstanceMethod(panel_cls, selector) };
        if method.is_null() {
            log::warn!("macOS panel drag fix: performWindowDragWithEvent: not found on NSPanel");
            return;
        }
        // SAFETY: `method` is a valid non-null Objective-C method descriptor.
        let Some(original) = (unsafe { method_getImplementation(method) }) else {
            log::warn!("macOS panel drag fix: original IMP missing for NSPanel");
            return;
        };
        // SAFETY: `method` is a valid non-null Objective-C method descriptor.
        let types = unsafe { method_getTypeEncoding(method) };
        ORIGINAL_IMP.store(original as usize as *mut c_void, Ordering::Release);

        let replacement_fn: PerformWindowDragFn = panel_perform_window_drag;
        // SAFETY: `PerformWindowDragFn` has the exact Objective-C ABI for
        // `-(void)performWindowDragWithEvent:(NSEvent *)` (`v@:@`).
        let replacement: Imp =
            unsafe { std::mem::transmute::<PerformWindowDragFn, Imp>(replacement_fn) };

        // SAFETY: `NSPanel` is a valid Objective-C class pointer. `class_addMethod`
        // adds the override directly to `NSPanel` (without touching `NSWindow`)
        // when `NSPanel` only inherited the method from `NSWindow`.
        let added = unsafe { class_addMethod(panel_cls.cast_mut(), selector, replacement, types) };
        if !added.as_bool() {
            // `NSPanel` already defines its own implementation; replace it in place.
            // SAFETY: `method` belongs to `NSPanel` and `replacement` matches its encoding.
            if let Some(previous) = unsafe { method_setImplementation(method, replacement) } {
                ORIGINAL_IMP.store(previous as usize as *mut c_void, Ordering::Release);
            }
        }
    });
}

fn is_nsh_panel_class(class_name: &CStr) -> bool {
    class_name == NSH_PANEL_CLASS_NAME
}

/// Computes the target window origin in AppKit screen points given the initial
/// window origin, initial cursor position, and current cursor position.
fn next_drag_origin(
    start_origin: NSPoint,
    start_mouse: NSPoint,
    current_mouse: NSPoint,
) -> NSPoint {
    NSPoint::new(
        start_origin.x + (current_mouse.x - start_mouse.x),
        start_origin.y + (current_mouse.y - start_mouse.y),
    )
}

fn moved_enough(a: NSPoint, b: NSPoint) -> bool {
    (a.x - b.x).abs() >= DRAG_MOVE_EPSILON || (a.y - b.y).abs() >= DRAG_MOVE_EPSILON
}

/// Calls the original `-[NSWindow performWindowDragWithEvent:]` implementation.
///
/// # Safety
/// `this`, `cmd`, and `event` must be the valid arguments received by the
/// overridden Objective-C method.
unsafe fn call_original(this: *mut AnyObject, cmd: Sel, event: *mut NSEvent) {
    let raw = ORIGINAL_IMP.load(Ordering::Acquire);
    if raw.is_null() {
        return;
    }
    // SAFETY: `raw` was stored from `method_getImplementation` for
    // `performWindowDragWithEvent:` (`PerformWindowDragFn`).
    let original: PerformWindowDragFn =
        unsafe { std::mem::transmute::<*mut c_void, PerformWindowDragFn>(raw) };
    // SAFETY: forwards the exact Objective-C receiver, selector, and event.
    unsafe { original(this, cmd, event) };
}

unsafe extern "C-unwind" fn panel_perform_window_drag(
    this: *mut AnyObject,
    cmd: Sel,
    event: *mut NSEvent,
) {
    let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if this.is_null() {
            return false;
        }
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        // SAFETY: `this` is a non-null `NSPanel` (`NSWindow` subclass) instance
        // invoked on the main thread by AppKit.
        let window: &NSWindow = unsafe { &*this.cast::<NSWindow>() };
        if !is_nsh_panel_class(window.class().name()) {
            return false;
        }
        if !window.isMovable() {
            return true;
        }
        // SAFETY: `event` is either null or a valid `NSEvent` passed by the caller.
        let event_ref = unsafe { event.as_ref() };
        track_panel_drag(mtm, window, event_ref);
        true
    }));

    if !matches!(handled, Ok(true)) {
        // SAFETY: forwards unchanged arguments to the original AppKit method.
        unsafe { call_original(this, cmd, event) };
    }
}

fn initial_mouse_location(
    mtm: MainThreadMarker,
    window: &NSWindow,
    start_origin: NSPoint,
    event: Option<&NSEvent>,
) -> NSPoint {
    if let Some(ev) = event {
        let is_left_drag_event = matches!(
            ev.r#type(),
            NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged
        );
        if is_left_drag_event && ev.window(mtm).as_deref() == Some(window) {
            let loc = ev.locationInWindow();
            return NSPoint::new(start_origin.x + loc.x, start_origin.y + loc.y);
        }
    }
    NSEvent::mouseLocation()
}

fn track_panel_drag(mtm: MainThreadMarker, window: &NSWindow, event: Option<&NSEvent>) {
    let start_origin = window.frame().origin;
    let start_mouse = initial_mouse_location(mtm, window, start_origin, event);
    let mut last_origin = start_origin;

    // Apply any cursor motion already accumulated since `event` was queued.
    let current = NSEvent::mouseLocation();
    let initial_target = next_drag_origin(start_origin, start_mouse, current);
    if moved_enough(initial_target, last_origin) {
        window.setFrameOrigin(initial_target);
        last_origin = initial_target;
    }

    let button_held_at_start = (NSEvent::pressedMouseButtons() & 1) != 0;
    let app = NSApplication::sharedApplication(mtm);
    let mask = NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp;
    // SAFETY: `NSEventTrackingRunLoopMode` is an immutable AppKit run-loop mode constant.
    let mode = unsafe { NSEventTrackingRunLoopMode };
    let mut last_activity = Instant::now();

    loop {
        if button_held_at_start && (NSEvent::pressedMouseButtons() & 1) == 0 {
            break;
        }
        let expiration = NSDate::dateWithTimeIntervalSinceNow(DRAG_POLL_INTERVAL_SECS);
        let next =
            app.nextEventMatchingMask_untilDate_inMode_dequeue(mask, Some(&expiration), mode, true);

        let cur = NSEvent::mouseLocation();
        let target = next_drag_origin(start_origin, start_mouse, cur);
        if moved_enough(target, last_origin) {
            window.setFrameOrigin(target);
            last_origin = target;
            last_activity = Instant::now();
        }

        if let Some(ev) = next {
            last_activity = Instant::now();
            if ev.r#type() == NSEventType::LeftMouseUp {
                break;
            }
        } else if !button_held_at_start && last_activity.elapsed() >= SYNTHETIC_DRAG_IDLE_TIMEOUT {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_origin_tracks_positive_negative_and_multi_monitor_deltas() {
        let start_origin = NSPoint::new(1200.0, 240.0);
        let start_mouse = NSPoint::new(1250.0, 280.0);

        let moved_right_up =
            next_drag_origin(start_origin, start_mouse, NSPoint::new(1310.5, 305.25));
        assert!((moved_right_up.x - 1260.5).abs() < 1e-6);
        assert!((moved_right_up.y - 265.25).abs() < 1e-6);

        // Secondary display positioned to the left/below primary produces negative screen points.
        let moved_left_down =
            next_drag_origin(start_origin, start_mouse, NSPoint::new(-250.0, -120.0));
        assert!((moved_left_down.x - -300.0).abs() < 1e-6);
        assert!((moved_left_down.y - -160.0).abs() < 1e-6);
    }

    #[test]
    fn only_nsh_panel_class_is_intercepted() {
        assert!(is_nsh_panel_class(c"NshPanel"));
        assert!(!is_nsh_panel_class(c"NSPanel"));
        assert!(!is_nsh_panel_class(c"NSOpenPanel"));
        assert!(!is_nsh_panel_class(c"NSSavePanel"));
        assert!(!is_nsh_panel_class(c"NshWindow"));
    }

    #[test]
    fn install_is_idempotent_and_registers_original_imp() {
        install();
        let first = ORIGINAL_IMP.load(Ordering::Acquire);
        assert!(
            !first.is_null(),
            "expected NSPanel original performWindowDragWithEvent: IMP"
        );

        install();
        let second = ORIGINAL_IMP.load(Ordering::Acquire);
        assert_eq!(first, second);
    }
}
