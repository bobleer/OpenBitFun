//! NativeUI tool: an interactive card in the conversation, written as a TSX
//! module and run natively by the reader's NSH app in a sandboxed engine.
//!
//! The tool compiles the module (`openbitfun-native-ui`) where the turn runs
//! and returns the compiled factory in its result, so the transcript carries
//! the card as data: replay, remote control, peer devices and history read it
//! without the workspace. Clients that cannot run cards show the title and the
//! source instead and say why.

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_agent_runtime::remote_file_delivery::TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY;
use serde_json::{json, Value};

pub const NATIVE_UI_TOOL_NAME: &str = "NativeUI";

const MAX_TITLE_CHARS: usize = 120;

pub struct NativeUiTool;

impl Default for NativeUiTool {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeUiTool {
    pub fn new() -> Self {
        Self
    }
}

fn description() -> String {
    format!(
        r#"Show an interactive card inside the conversation: a calculator, a planner, a comparison with controls, a dashboard of numbers, a checklist, a form whose answer becomes the user's next message. The reader's app runs it natively (not a web page) in a sandbox, styled like the app.

Use it when the reader gains from doing something with the answer (adjust an input and see the result, switch between views, pick options) or from seeing numbers as a chart or table. Do not use it for plain prose, code, or a file or webpage the user asked for.

Write `source` as one TSX module:
- Import only from "nsh" (View, Text, Image, Scroll, signal, computed, effect), "nsh/base" (unstyled primitives), "nsh/base/plot" (Plot, Bar, Line, Area, Pie, PlotAxis, Grid, Cell for custom charts) and "openbitfun/genui" (the styled kit below). No HTML tags, no CSS, no network, no other modules.
- `export default function Card() {{ ... }}` returns the card. Components run once; read signals inside JSX (`{{count()}}`, `value={{n()}}`) so the card updates. Keep state in `signal(initial)` (read `s()`, write `s.set(v)`), derived values in `computed(() => ...)`, lists with `{{items().map(item => <ListItem title={{item.name}} />)}}`.
- Put data the card needs in the source. Keep it under {max_kb} KiB.

Kit ("openbitfun/genui"):
- Layout: <Card title? subtitle?>, <Stack gap?>, <Row gap? align? wrap?>, <Grid columns? gap?>, <Divider />, <Spacer size? />
- Text: <Heading level={{1|2|3}}>, <Body>, <Muted>, <Code>, <Markdown text />
- Controls: <Button label onPress variant?="primary|secondary|ghost|danger" disabled? />, <Toggle label value onChange />, <Slider label value min max step? format? onChange />, <TextField label value placeholder? onChange onSubmit? />, <Segmented options value onChange /> (options: strings or {{value, label}}), <Tabs tabs={{[{{value, label, content}}]}} value? onChange? />
- Display: <Badge label tone? />, <Stat label value delta? tone? hint? />, <Progress value={{0..1}} label? tone? />, <Table columns={{[{{key, label, align?}}]}} rows maxHeight? />, <List>, <ListItem title subtitle? trailing? icon? onPress? />, <Callout tone? title?>, <KeyValue items={{[{{key, value}}]}} />
- Charts: <BarChart data x y stacked? height? format? />, <LineChart data x y dots? height? format? />, <PieChart data label value donut? height? /> (y may be one field or several)
- tone: "neutral" | "accent" | "success" | "warning" | "danger"
- Host: ask(text) puts a follow-up into the reader's composer for them to send; openLink(url); copyText(text); persisted(key, initial) is a signal the reader's device keeps for this card; theme() returns the reader's colors.

Example:
import {{ signal, computed }} from "nsh";
import {{ Card, Slider, Stat, Row, Button, ask }} from "openbitfun/genui";
const amount = signal(300000), rate = signal(4.2), years = signal(30);
const monthly = computed(() => {{ const r = rate() / 1200, n = years() * 12; return amount() * r / (1 - Math.pow(1 + r, -n)); }});
export default function Card() {{
  return (
    <Card title="Mortgage" subtitle="Drag to compare">
      <Slider label="Amount" value={{amount()}} min={{50000}} max={{1000000}} step={{10000}} onChange={{v => amount.set(v)}} />
      <Slider label="Rate %" value={{rate()}} min={{1}} max={{10}} step={{0.1}} onChange={{v => rate.set(v)}} />
      <Row><Stat label="Monthly" value={{monthly().toFixed(0)}} /><Stat label="Years" value={{years()}} /></Row>
      <Button label="Ask about refinancing" onPress={{() => ask(`Refinance a ${{amount()}} loan at ${{rate()}}%?`)}} />
    </Card>
  );
}}

A compile error comes back with its line; fix the source and call again. After the card shows, reply briefly in prose; do not repeat its content."#,
        max_kb = openbitfun_native_ui::MAX_SOURCE_BYTES / 1024
    )
}

#[async_trait]
impl Tool for NativeUiTool {
    fn name(&self) -> &str {
        NATIVE_UI_TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(description())
    }

    fn short_description(&self) -> String {
        "Show an interactive native card (TSX) in the conversation: calculators, planners, charts, forms.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "A short name for the card, shown where the card cannot run."
                },
                "source": {
                    "type": "string",
                    "description": "The card as one TSX module whose default export is its root component."
                }
            },
            "required": ["title", "source"],
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "format": {"type": "string"},
                "kitApi": {"type": "integer"},
                "factory": {"type": "string"},
                "imports": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["title", "format", "kitApi", "factory"],
            "additionalProperties": true
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        match input.get("title").and_then(Value::as_str) {
            Some(title) if !title.trim().is_empty() => format!("Show card: {}", title.trim()),
            _ => "Show card".to_string(),
        }
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        output
            .get("title")
            .and_then(Value::as_str)
            .map(|title| format!("Card shown: {title}"))
            .unwrap_or_else(|| "Card shown".to_string())
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if context
            .custom_data
            .get(TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY)
            .and_then(Value::as_bool)
            == Some(true)
        {
            return Err(OpenBitFunError::tool(
                "This reader is a chat bot and cannot show NativeUI cards. Answer in text, or deliver a file with a computer:// link.".to_string(),
            ));
        }
        let title: String = input
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .chars()
            .take(MAX_TITLE_CHARS)
            .collect();
        if title.is_empty() {
            return Err(OpenBitFunError::tool("title is required".to_string()));
        }
        let source = input
            .get("source")
            .and_then(Value::as_str)
            .ok_or_else(|| OpenBitFunError::tool("source is required".to_string()))?;
        let compiled = openbitfun_native_ui::compile(source).map_err(|error| {
            OpenBitFunError::tool(format!("The card did not compile:\n{error}"))
        })?;
        let data = json!({
            "title": title,
            "format": openbitfun_native_ui::FORMAT,
            "kitApi": openbitfun_native_ui::KIT_API,
            "factory": compiled.factory,
            "imports": compiled.imports,
            "sourceBytes": source.len(),
        });
        let result_for_assistant = format!(
            "The card \"{title}\" compiled and shows inline in the reader's conversation. Readers whose app cannot run cards see its title and source. Reply briefly in prose; do not repeat the card's content."
        );
        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn context(custom: HashMap<String, Value>) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            model_client: None,
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: custom,
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[tokio::test]
    async fn compiles_the_card_into_its_result() {
        let source = "import { Card, Body } from \"openbitfun/genui\";\nexport default function Hello() { return <Card title=\"Hi\"><Body>hello</Body></Card>; }";
        let result = NativeUiTool::new()
            .call_impl(
                &json!({ "title": "Hello", "source": source }),
                &context(HashMap::new()),
            )
            .await
            .expect("compiles");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &result[0]
        else {
            panic!("structured result");
        };
        assert_eq!(data["title"], "Hello");
        assert_eq!(data["format"], openbitfun_native_ui::FORMAT);
        assert_eq!(data["kitApi"], openbitfun_native_ui::KIT_API);
        assert!(data["factory"].as_str().unwrap().contains("return Hello;"));
        assert!(result_for_assistant
            .as_deref()
            .unwrap()
            .contains("shows inline"));
    }

    #[tokio::test]
    async fn returns_compile_errors_to_the_model() {
        let error = NativeUiTool::new()
            .call_impl(
                &json!({ "title": "Bad", "source": "export default () => <div />;" }),
                &context(HashMap::new()),
            )
            .await
            .expect_err("html tags are refused");
        assert!(
            error.to_string().contains("Cards have no HTML tags"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn chat_bot_readers_get_an_explicit_refusal() {
        let mut custom = HashMap::new();
        custom.insert(
            TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY.to_string(),
            Value::Bool(true),
        );
        let error = NativeUiTool::new()
            .call_impl(
                &json!({ "title": "x", "source": "export default () => null;" }),
                &context(custom),
            )
            .await
            .expect_err("bots cannot show cards");
        assert!(
            error.to_string().contains("cannot show NativeUI cards"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn the_tool_is_deferred_and_documents_the_kit() {
        let tool = NativeUiTool::new();
        assert_eq!(tool.default_exposure(), ToolExposure::Deferred);
        let description = tool.description().await.unwrap();
        for name in openbitfun_native_ui::KIT_EXPORTS {
            assert!(
                description.contains(name),
                "description misses kit export {name}"
            );
        }
    }
}
