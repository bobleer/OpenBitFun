//! NativeUI cards: a card the Agent wrote (`NativeUI` tool, compiled by
//! `openbitfun-native-ui` to a factory) runs in an NSH engine of its own,
//! embedded in the transcript as the native component
//! `openbitfun.genui-card`.
//!
//! The card's engine is a sandbox: a hardened VM with embedded-app limits, no
//! capability but the `genui.*` host functions (no network, web views,
//! clipboard, files or windows), and storage that lives only as long as the
//! card. What it asks of the reader (a follow-up, a link, a copy, a state
//! change) reaches the transcript as component events; the transcript decides.
//!
//! macOS only for now: the Windows and Linux runners report the component as
//! unavailable (`Backend.nativeCards()`), and the transcript says so.

use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use nsh_core::JsonValue;
use nsh_engine::{AppError, Limits, Policy, Trial};
use nsh_platform_macos::{
    objc2::{rc::Retained, MainThreadMarker},
    objc2_app_kit::NSView,
    AppOptions, AppView, Bundle, ComponentContext, Components, NativeComponent,
};

/// The component name the transcript renders cards with.
pub(crate) const COMPONENT: &str = "openbitfun.genui-card";

/// The card kit (`openbitfun/genui`), generated from `src/nsh-ui/genui-kit/kit.tsx`.
const KIT_FACTORY: &str = include_str!("../genui_kit.generated.js");

/// The only capability a card has: its host functions.
const CARD_CAPABILITIES: &str = r#"{ "host": ["genui.*"] }"#;

/// Registers the card component on every view the runner makes.
pub(crate) fn register(components: &Components) {
    components.register(
        COMPONENT,
        Rc::new(|ctx| Box::new(Card::new(ctx)) as Box<dyn NativeComponent>),
    );
}

/// The bundle a card runs: the kit, then the card, mounted by the kit.
pub(crate) fn bundle_source(factory: &str) -> String {
    format!(
        "import * as __rt from \"nsh:rt\";\n\
         import * as __nsh from \"nsh\";\n\
         import * as __base from \"nsh/base\";\n\
         import * as __plot from \"nsh/base/plot\";\n\
         const __kit = ({kit})(__rt, __nsh, __base, __plot, {{}})();\n\
         const __card = ({factory}\n)(__rt, __nsh, __base, __plot, __kit);\n\
         __nsh.mount(() => __kit.__mountCard(__card));\n",
        kit = kit_factory(),
    )
}

/// The kit factory without its generated-file header.
fn kit_factory() -> &'static str {
    let start = KIT_FACTORY.find("(function").unwrap_or(0);
    KIT_FACTORY[start..].trim()
}

/// Limits of a card's VM: smaller than an embedded app's, a card is a widget.
fn card_limits() -> Limits {
    let mut limits = Limits::default();
    limits.memory_bytes = 64 << 20;
    limits.max_nodes = 20_000;
    limits
}

/// Storage that lives as long as the card's engine.
#[derive(Default)]
struct CardStorage(Mutex<BTreeMap<String, String>>);

impl nsh_core::storage::StorageBackend for CardStorage {
    fn load(&self) -> Result<BTreeMap<String, String>, String> {
        Ok(self.0.lock().map(|map| map.clone()).unwrap_or_default())
    }

    fn write(&self, change: nsh_core::storage::StorageChange) -> Result<(), String> {
        let mut map = self
            .0
            .lock()
            .map_err(|_| "card storage poisoned".to_owned())?;
        match change {
            nsh_core::storage::StorageChange::Set(key, value) => {
                if map.len() >= 64 && !map.contains_key(&key) {
                    return Err("a card keeps at most 64 entries".to_owned());
                }
                map.insert(key, value);
            }
            nsh_core::storage::StorageChange::Remove(key) => {
                map.remove(&key);
            }
            nsh_core::storage::StorageChange::Clear => map.clear(),
        }
        Ok(())
    }
}

/// Reports a card whose VM did not start or stopped.
#[derive(Debug)]
struct CardTrial(ComponentContext);

impl Trial for CardTrial {
    fn healthy(&self) {}

    fn failed(&self, error: &AppError) {
        self.0
            .emit("error", serde_json::json!({ "message": error.message }));
    }
}

struct Card {
    ctx: ComponentContext,
    view: Rc<AppView>,
    factory: Option<String>,
    theme: JsonValue,
    state: JsonValue,
    loaded: bool,
}

impl Card {
    fn new(ctx: ComponentContext) -> Self {
        let mtm = MainThreadMarker::new().expect("native components are made on the main thread");
        let options = AppOptions {
            app_id: "com.openbitfun.genui-card".to_owned(),
            limits: card_limits(),
            storage: Some(Arc::new(CardStorage::default())),
            transparent: true,
            size: (480, 1),
            ..AppOptions::default()
        };
        let view = AppView::new(mtm, options);
        // A card cannot nest cards (the runner registers this component on
        // every view it makes, the card's included).
        view.register_component(
            COMPONENT,
            Rc::new(|_| Box::new(Empty::new()) as Box<dyn NativeComponent>),
        );
        let host = view.host();
        for name in [
            "genui.ask",
            "genui.copy",
            "genui.state",
            "genui.openUrl",
            "genui.error",
        ] {
            let ctx = ctx.clone();
            let event = name.trim_start_matches("genui.");
            host.handle(name, move |mut call| {
                ctx.emit(event, call.take_data());
                call.resolve(JsonValue::Null);
            });
        }
        {
            let ctx = ctx.clone();
            host.handle("genui.size", move |call| {
                let height = call.data()["height"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .clamp(0.0, 20_000.0);
                ctx.set_size(0.0, height as f32);
                call.resolve(JsonValue::Null);
            });
        }
        {
            // `openUrl` from `nsh` (a TextView link, say): the transcript decides.
            let ctx = ctx.clone();
            host.handle_open_url(move |request| {
                ctx.emit("openUrl", serde_json::json!({ "url": request.url() }));
                request.handled();
            });
        }
        Self {
            ctx,
            view,
            factory: None,
            theme: JsonValue::Null,
            state: JsonValue::Null,
            loaded: false,
        }
    }

    fn load(&mut self) {
        let Some(factory) = self.factory.as_deref() else {
            return;
        };
        let mut params = serde_json::Map::new();
        params.insert("theme".into(), self.theme.clone());
        params.insert("state".into(), self.state.clone());
        self.view.host().set_params(params);
        let capabilities = match nsh_engine::parse_capabilities(CARD_CAPABILITIES) {
            Ok(capabilities) => capabilities,
            Err(error) => {
                self.ctx
                    .emit("error", serde_json::json!({ "message": error }));
                return;
            }
        };
        let mut bundle = Bundle::source(bundle_source(factory))
            .with_app_id(Some("com.openbitfun.genui-card"))
            .with_policy(Policy {
                harden: true,
                declared: Some(capabilities.clone()),
                granted: Some(capabilities),
            });
        bundle.trial = Some(Arc::new(CardTrial(self.ctx.clone())));
        self.loaded = true;
        // Start the engine once the transcript has put this view in its
        // window: props arrive right after the view is made, before it is
        // placed, and an engine started off-window keeps the window's size.
        let view = MainOnly(Rc::clone(&self.view));
        dispatch::Queue::main().exec_async(move || {
            let view = view;
            view.0.load(bundle.into());
        });
    }
}

/// A main-thread value handed to the main queue.
struct MainOnly<T>(T);
// SAFETY: only moved to the main queue, which is the thread it came from.
unsafe impl<T> Send for MainOnly<T> {}

impl NativeComponent for Card {
    fn view(&self) -> Retained<NSView> {
        self.view.view()
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        match name {
            "factory" => {
                let next = value.and_then(JsonValue::as_str).map(str::to_owned);
                if next != self.factory {
                    self.factory = next;
                    self.load();
                }
            }
            "theme" => {
                self.theme = value.cloned().unwrap_or(JsonValue::Null);
                if self.loaded {
                    let _ = self.view.host().send("theme", self.theme.clone());
                }
            }
            // Read when the card starts; later changes come from the card itself.
            "state" => self.state = value.cloned().unwrap_or(JsonValue::Null),
            _ => {}
        }
    }
}

impl Drop for Card {
    fn drop(&mut self) {
        self.view.stop();
    }
}

/// What a card sees in place of a nested card.
struct Empty(Retained<NSView>);

impl Empty {
    fn new() -> Self {
        let mtm = MainThreadMarker::new().expect("main thread");
        Self(NSView::new(mtm))
    }
}

impl NativeComponent for Empty {
    fn view(&self) -> Retained<NSView> {
        self.0.clone()
    }

    fn set_prop(&mut self, _name: &str, _value: Option<&JsonValue>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundle_mounts_the_card_with_the_kit() {
        let source = bundle_source("(function () { return function Card() { return null; }; })");
        assert!(source.starts_with("import * as __rt from \"nsh:rt\";"));
        assert!(source.contains("const __kit = ((function (__rt, __nsh, __base, __plot, __kit) {"));
        assert!(source.contains("__nsh.mount(() => __kit.__mountCard(__card));"));
    }

    #[test]
    fn cards_may_only_call_their_host_functions() {
        let capabilities = nsh_engine::parse_capabilities(CARD_CAPABILITIES).expect("parses");
        let text = format!("{capabilities:?}");
        assert!(text.contains("genui.*"), "{text}");
    }
}
