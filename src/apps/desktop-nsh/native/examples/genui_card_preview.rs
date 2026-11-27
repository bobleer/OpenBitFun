//! Opens a window running an NSH bundle with the NativeUI card component
//! registered, as the desktop runner does: a local preview of cards without
//! the backend.
//!
//!   cargo run --features runner --example genui_card_preview -- <bundle.js>

#[cfg(target_os = "macos")]
#[path = "../src/runner/genui_card.rs"]
mod genui_card;

#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    use nsh_platform_macos::{run_app, AppOptions, AppSource, Bundle};
    let path = std::env::args()
        .nth(1)
        .expect("usage: genui_card_preview <bundle.js>");
    let mut code = std::fs::read_to_string(&path).expect("read bundle");
    // `--direct <theme.json>`: run the file as a card factory, filling the window.
    let mut host = nsh_engine::HostChannel::new();
    if let Some(theme) = std::env::args()
        .nth(3)
        .filter(|_| std::env::args().nth(2).as_deref() == Some("--direct"))
    {
        code = genui_card::bundle_source(&code);
        let theme: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(theme).expect("theme")).expect("json");
        let mut params = serde_json::Map::new();
        params.insert("theme".into(), theme);
        params.insert("state".into(), serde_json::json!({}));
        host = nsh_engine::HostChannel::new();
        host.set_params(params);
        host.handle("genui.size", |call| {
            eprintln!("direct size {}", call.data());
            call.resolve(serde_json::Value::Null);
        });
    }
    nsh_platform_macos::set_ui_sets(vec![nsh_base::registry()]);
    nsh_platform_macos::set_components(genui_card::register);
    let options = AppOptions {
        title: "NativeUI card preview".to_owned(),
        size: (560, 760),
        host: host.clone(),
        ..AppOptions::default()
    };
    if std::env::args().nth(4).as_deref() == Some("--plain") {
        return plain(code, host);
    }
    run_app(AppSource::Bundle(Bundle::source(code)), options)
}

/// The card's view in a sub-rectangle of a plain AppKit window (no outer NSH).
#[cfg(target_os = "macos")]
fn plain(code: String, host: nsh_engine::HostChannel) -> std::process::ExitCode {
    use nsh_platform_macos::objc2::{MainThreadMarker, MainThreadOnly};
    use nsh_platform_macos::objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow,
        NSWindowStyleMask,
    };
    use nsh_platform_macos::objc2_foundation::{NSPoint, NSRect, NSSize};
    use nsh_platform_macos::{AppOptions, AppView, Bundle};
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    let frame = NSRect::new(NSPoint::new(200.0, 200.0), NSSize::new(560.0, 760.0));
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Resizable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    let view = AppView::new(
        mtm,
        AppOptions {
            host,
            size: (520, 582),
            ..AppOptions::default()
        },
    );
    view.load(Bundle::source(code.clone()).into());
    let ns = view.view();
    ns.setAutoresizingMask(nsh_platform_macos::objc2_app_kit::NSAutoresizingMaskOptions::empty());
    ns.setFrame(NSRect::new(
        NSPoint::new(20.0, 80.0),
        NSSize::new(520.0, 582.0),
    ));
    window.contentView().unwrap().addSubview(&ns);
    window.makeKeyAndOrderFront(None);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    if std::env::args().nth(5).as_deref() == Some("--two") {
        let second = AppView::new(
            mtm,
            AppOptions {
                size: (260, 300),
                ..AppOptions::default()
            },
        );
        second.load(Bundle::source(code.clone()).into());
        let ns2 = second.view();
        ns2.setAutoresizingMask(
            nsh_platform_macos::objc2_app_kit::NSAutoresizingMaskOptions::empty(),
        );
        ns2.setFrame(NSRect::new(
            NSPoint::new(20.0, 670.0),
            NSSize::new(520.0, 80.0),
        ));
        window.contentView().unwrap().addSubview(&ns2);
        std::mem::forget(second);
    }
    std::mem::forget(view);
    std::mem::forget(window);
    app.run();
    std::process::ExitCode::SUCCESS
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("the card preview runs on macOS");
}
