//! NativeUI: a TSX module the model writes, compiled to the card factory the
//! NSH clients run in a sandboxed engine of their own.
//!
//! The module imports from `nsh`, `nsh/base`, `nsh/base/plot` and the client
//! kit `openbitfun/genui`, and default-exports its root component. The output
//! is one JavaScript expression,
//!
//! ```text
//! (function (__rt, __nsh, __base, __plot, __kit) { ...; return App; })
//! ```
//!
//! which a client calls with the native module namespaces it imported and its
//! own kit, then mounts the returned component. JSX compiles to the same
//! fine-grained `nsh:rt` calls the NSH bundler emits (`component(Tag, props)`,
//! a getter per dynamic prop, a thunk per dynamic child), so the card stays
//! reactive without a bundler on the reading device.
//!
//! Pure in memory: no file, network or process IO.

mod compile;

pub use compile::{compile, CompileError, CompiledModule};

/// The wire format of [`CompiledModule::factory`]; clients refuse others.
pub const FORMAT: &str = "openbitfun.native-ui/1";

/// The modules a NativeUI source may import, with the factory parameter each
/// one binds to.
pub const MODULES: &[(&str, &str)] = &[
    ("nsh", "__nsh"),
    ("nsh/base", "__base"),
    ("nsh/base/plot", "__plot"),
    ("openbitfun/genui", "__kit"),
];

/// What `openbitfun/genui` exports (kit API version 1). Clients ship the kit;
/// this list only lets the compiler name a missing export early. Additive:
/// a removed name would break cards already in transcripts.
pub const KIT_EXPORTS: &[&str] = &[
    // Layout
    "Card",
    "Stack",
    "Row",
    "Grid",
    "Divider",
    "Spacer",
    // Text
    "Heading",
    "Body",
    "Muted",
    "Code",
    "Markdown",
    // Controls
    "Button",
    "Toggle",
    "Slider",
    "TextField",
    "Segmented",
    "Tabs",
    // Display
    "Badge",
    "Stat",
    "Progress",
    "Table",
    "List",
    "ListItem",
    "Callout",
    "KeyValue",
    // Charts
    "BarChart",
    "LineChart",
    "PieChart",
    // Host
    "theme",
    "ask",
    "openLink",
    "copyText",
    "persisted",
];

/// The kit API version the compiled factories expect.
pub const KIT_API: u32 = 1;

/// Largest accepted source, in bytes.
pub const MAX_SOURCE_BYTES: usize = 256 * 1024;

/// Largest factory produced, in bytes.
pub const MAX_FACTORY_BYTES: usize = 1024 * 1024;
