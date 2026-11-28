//! Lets an NSH floating panel handle right-clicks on its draggable views.
//!
//! NSH 0.7.1 returns `HTCAPTION` for these views, then handles primary
//! presses and drags there. Secondary clicks arrive as non-client messages
//! and never reach `onContextMenu`. Translate just those messages before
//! dispatch so the pet can keep both its native drag and its app menu.

use std::sync::Once;

use nsh_platform_windows::windows::{
    core::BOOL,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
        Graphics::Gdi::ScreenToClient,
        System::{
            SystemServices::{
                MK_CONTROL, MK_LBUTTON, MK_MBUTTON, MK_RBUTTON, MK_SHIFT, MK_XBUTTON1, MK_XBUTTON2,
            },
            Threading::GetCurrentProcessId,
        },
        UI::{
            Input::KeyboardAndMouse::{
                GetKeyState, VK_CONTROL, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON, VK_SHIFT, VK_XBUTTON1,
                VK_XBUTTON2,
            },
            WindowsAndMessaging::{
                CallNextHookEx, EnumWindows, GetClassNameW, GetWindowLongPtrW,
                GetWindowThreadProcessId, SetWindowsHookExW, GWL_EXSTYLE, GWL_STYLE, HC_ACTION,
                HTCAPTION, MSG, PM_REMOVE, WH_GETMESSAGE, WM_NCRBUTTONDBLCLK, WM_NCRBUTTONDOWN,
                WM_NCRBUTTONUP, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WS_CAPTION,
                WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_THICKFRAME,
            },
        },
    },
};

static INSTALL: Once = Once::new();

pub(crate) fn install() {
    INSTALL.call_once(|| {
        // NSH starts its Win32 UI thread and creates the host window before running
        // registry setup on its engine thread.
        let mut host = HostWindow {
            // SAFETY: a plain query of this process's ID.
            process_id: unsafe { GetCurrentProcessId() },
            thread_id: 0,
        };
        // SAFETY: EnumWindows invokes the callback synchronously with this live pointer.
        let _ = unsafe {
            EnumWindows(
                Some(find_host),
                LPARAM(&mut host as *mut HostWindow as isize),
            )
        };
        if host.thread_id == 0 {
            log::warn!("Could not find the Windows NSH window thread for panel context menus");
            return;
        }
        // SAFETY: the hook is restricted to the same-process window thread found above.
        // Windows removes the hook when this thread exits.
        if let Err(error) = unsafe {
            SetWindowsHookExW(WH_GETMESSAGE, Some(route_panel_click), None, host.thread_id)
        } {
            log::warn!("Could not install the Windows panel context menu hook: {error}");
        }
    });
}

struct HostWindow {
    process_id: u32,
    thread_id: u32,
}

unsafe extern "system" fn find_host(window: HWND, parameter: LPARAM) -> BOOL {
    // SAFETY: install passes a live HostWindow pointer. Both queries only
    // read the enumerated window's info.
    let host = unsafe { &mut *(parameter.0 as *mut HostWindow) };
    let mut process_id = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    if process_id == host.process_id && is_nsh_window(window) {
        host.thread_id = thread_id;
        BOOL(0)
    } else {
        BOOL(1)
    }
}

unsafe extern "system" fn route_panel_click(
    code: i32,
    flags: WPARAM,
    parameter: LPARAM,
) -> LRESULT {
    if code == HC_ACTION as i32 && flags.0 == PM_REMOVE.0 as usize {
        // SAFETY: WH_GETMESSAGE passes a writable MSG for HC_ACTION.
        let message = unsafe { &mut *(parameter.0 as *mut MSG) };
        if let Some(client_message) = client_message(message) {
            let mut point = POINT {
                x: message.lParam.0 as i16 as i32,
                y: (message.lParam.0 >> 16) as i16 as i32,
            };
            // SAFETY: plain queries for the window and key state of this message.
            if unsafe { ScreenToClient(message.hwnd, &mut point) }.as_bool() {
                message.message = client_message;
                message.wParam = mouse_keys();
                message.lParam =
                    LPARAM(((point.x as u16 as u32) | ((point.y as u16 as u32) << 16)) as isize);
            }
        }
    }
    // SAFETY: forward the same arguments to the rest of the thread's hook chain.
    unsafe { CallNextHookEx(None, code, flags, parameter) }
}

fn client_message(message: &MSG) -> Option<u32> {
    if message.wParam.0 != HTCAPTION as usize {
        return None;
    }
    let client = match message.message {
        WM_NCRBUTTONDOWN => WM_RBUTTONDOWN,
        WM_NCRBUTTONUP => WM_RBUTTONUP,
        WM_NCRBUTTONDBLCLK => WM_RBUTTONDBLCLK,
        _ => return None,
    };
    is_floating_panel(message.hwnd).then_some(client)
}

fn is_floating_panel(window: HWND) -> bool {
    // Desktop cards are resizable and the main window has its own window chrome.
    // The pet is a non-resizable, frameless, topmost tool window.
    // SAFETY: these Win32 queries only read window attributes.
    let (style, extended) = unsafe {
        (
            GetWindowLongPtrW(window, GWL_STYLE) as u32,
            GetWindowLongPtrW(window, GWL_EXSTYLE) as u32,
        )
    };
    let floating = WS_EX_TOPMOST.0 | WS_EX_TOOLWINDOW.0;
    style & (WS_CAPTION.0 | WS_THICKFRAME.0) == 0
        && extended & floating == floating
        && is_nsh_window(window)
}

fn is_nsh_window(window: HWND) -> bool {
    let mut class = [0; 16];
    // SAFETY: Win32 writes at most the capacity of the supplied buffer.
    let class_len = unsafe { GetClassNameW(window, &mut class) };
    class_len == 9 && class[..9].iter().copied().eq("NshWindow".encode_utf16())
}

fn mouse_keys() -> WPARAM {
    let mut keys = 0;
    for (key, flag) in [
        (VK_LBUTTON, MK_LBUTTON),
        (VK_RBUTTON, MK_RBUTTON),
        (VK_MBUTTON, MK_MBUTTON),
        (VK_XBUTTON1, MK_XBUTTON1),
        (VK_XBUTTON2, MK_XBUTTON2),
        (VK_SHIFT, MK_SHIFT),
        (VK_CONTROL, MK_CONTROL),
    ] {
        // SAFETY: queries the key state of this message queue.
        if unsafe { GetKeyState(i32::from(key.0)) } < 0 {
            keys |= flag.0;
        }
    }
    WPARAM(keys as usize)
}
