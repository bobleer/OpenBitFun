//! TSX → card factory.
//!
//! 1. Parse the TSX and strip its types with oxc, keeping the JSX.
//! 2. Parse the result again and splice: every outermost JSX node becomes
//!    `__rt.component(...)` text (nested JSX inside its expressions is spliced
//!    the same way), imports become destructurings of the factory's module
//!    parameters, and `export default` becomes the factory's return value.

use std::cell::RefCell;
use std::fmt::Write as _;
use std::path::Path;

use oxc_parse::allocator::Allocator;
use oxc_parse::ast::ast::{
    ExportDefaultDeclarationKind, Expression, ImportDeclarationSpecifier, JSXAttributeItem,
    JSXAttributeName, JSXAttributeValue, JSXChild, JSXElement, JSXElementName, JSXFragment,
    Program, Statement,
};
use oxc_parse::ast_visit::{walk, Visit};
use oxc_parse::codegen::Codegen;
use oxc_parse::diagnostics::OxcDiagnostic;
use oxc_parse::parser::Parser;
use oxc_parse::semantic::SemanticBuilder;
use oxc_parse::span::{GetSpan, SourceType, Span};
use oxc_parse::transformer::{JsxOptions, TransformOptions, Transformer};

use crate::{KIT_EXPORTS, MAX_FACTORY_BYTES, MAX_SOURCE_BYTES, MODULES};

/// A compiled NativeUI module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledModule {
    /// The factory expression (see the crate docs).
    pub factory: String,
    /// The modules the source imported, in first-import order.
    pub imports: Vec<String>,
}

/// Why a source does not compile. `message` is written for the model that
/// wrote the source: it names the place and what to change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileError {
    pub message: String,
}

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CompileError {}

fn error(message: impl Into<String>) -> CompileError {
    CompileError {
        message: message.into(),
    }
}

/// Compiles a NativeUI TSX module.
pub fn compile(source: &str) -> Result<CompiledModule, CompileError> {
    if source.trim().is_empty() {
        return Err(error("The source is empty. Write a TSX module whose default export is the card's root component."));
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err(error(format!(
            "The source has {} bytes; the limit is {MAX_SOURCE_BYTES}. Keep data small or summarize it.",
            source.len()
        )));
    }
    let stripped = strip_types(source)?;
    let factory = splice(&stripped)?;
    if factory.factory.len() > MAX_FACTORY_BYTES {
        return Err(error(
            "The compiled card is larger than 1 MiB. Keep data small or summarize it.",
        ));
    }
    check_parses(&factory.factory)?;
    Ok(factory)
}

/// Line and column (1-based) of a byte offset.
fn position(source: &str, offset: usize) -> (usize, usize) {
    let offset = offset.min(source.len());
    let before = &source[..offset];
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
    (line, column)
}

fn describe(source: &str, diagnostics: &[OxcDiagnostic]) -> String {
    let mut out = String::new();
    for diagnostic in diagnostics.iter().take(5) {
        let at = diagnostic
            .labels
            .as_slice()
            .first()
            .map(|label| position(source, label.offset() as usize));
        match at {
            Some((line, column)) => {
                let _ = writeln!(out, "{line}:{column}: {diagnostic}");
            }
            None => {
                let _ = writeln!(out, "{diagnostic}");
            }
        }
    }
    out.trim_end().to_owned()
}

/// TSX → JS that still has its JSX.
fn strip_types(source: &str) -> Result<String, CompileError> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();
    if parsed.panicked || parsed.diagnostics.has_errors() {
        let errors: Vec<OxcDiagnostic> = parsed.diagnostics.errors().cloned().collect();
        return Err(error(format!(
            "The TSX does not parse:\n{}",
            describe(source, &errors)
        )));
    }
    let mut program = parsed.program;
    let scoping = SemanticBuilder::new()
        .build(&program)
        .semantic
        .into_scoping();
    let mut options = TransformOptions::default();
    options.jsx = JsxOptions {
        jsx_plugin: false,
        display_name_plugin: false,
        jsx_self_plugin: false,
        jsx_source_plugin: false,
        ..JsxOptions::default()
    };
    // Keep every value import: JSX references the components by name.
    options.typescript.only_remove_type_imports = true;
    let transformed = Transformer::new(&allocator, Path::new("card.tsx"), &options)
        .build_with_scoping(scoping, &mut program);
    let errors: Vec<OxcDiagnostic> = transformed.diagnostics.errors().cloned().collect();
    if !errors.is_empty() {
        return Err(error(format!(
            "The TSX cannot be compiled:\n{}",
            describe(source, &errors)
        )));
    }
    Ok(Codegen::new().build(&program).code)
}

/// The output must be one parseable expression.
fn check_parses(factory: &str) -> Result<(), CompileError> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, factory, SourceType::cjs()).parse();
    if parsed.panicked || parsed.diagnostics.has_errors() {
        let errors: Vec<OxcDiagnostic> = parsed.diagnostics.errors().cloned().collect();
        return Err(error(format!(
            "Internal NativeUI compile error; simplify the JSX around:\n{}",
            describe(factory, &errors)
        )));
    }
    Ok(())
}

struct Ctx<'s> {
    src: &'s str,
    errors: RefCell<Vec<String>>,
}

impl Ctx<'_> {
    fn text(&self, span: Span) -> &str {
        &self.src[span.start as usize..span.end as usize]
    }

    fn fail(&self, span: Span, message: impl std::fmt::Display) {
        let (line, column) = position(self.src, span.start as usize);
        let snippet: String = self.text(span).chars().take(60).collect();
        self.errors
            .borrow_mut()
            .push(format!("{line}:{column} `{snippet}`: {message}"));
    }
}

/// Collects the replacements of one source range: its outermost JSX nodes
/// and, at the top level, the module syntax.
struct Collector<'c, 's> {
    ctx: &'c Ctx<'s>,
    out: Vec<(u32, u32, String)>,
}

impl<'c, 's> Collector<'c, 's> {
    fn new(ctx: &'c Ctx<'s>) -> Self {
        Self {
            ctx,
            out: Vec::new(),
        }
    }

    /// `span`'s text with the collected replacements applied.
    fn apply(mut self, span: Span) -> String {
        self.out.sort_by_key(|(start, _, _)| *start);
        let mut text = String::new();
        let mut cursor = span.start;
        for (start, end, replacement) in self.out {
            if start < cursor || end > span.end {
                continue;
            }
            text.push_str(&self.ctx.src[cursor as usize..start as usize]);
            text.push_str(&replacement);
            cursor = end;
        }
        text.push_str(&self.ctx.src[cursor as usize..span.end as usize]);
        text
    }
}

impl<'a> Visit<'a> for Collector<'_, '_> {
    fn visit_jsx_element(&mut self, it: &JSXElement<'a>) {
        let rendered = render_element(self.ctx, it);
        self.out.push((it.span.start, it.span.end, rendered));
    }

    fn visit_jsx_fragment(&mut self, it: &JSXFragment<'a>) {
        let rendered = render_children(self.ctx, &it.children).array();
        self.out.push((it.span.start, it.span.end, rendered));
    }

    fn visit_import_expression(&mut self, it: &oxc_parse::ast::ast::ImportExpression<'a>) {
        self.ctx.fail(
            it.span,
            "dynamic import() is not available in a card; import statically from nsh, nsh/base, nsh/base/plot or openbitfun/genui",
        );
    }
}

/// Renders `expression`, splicing the JSX inside it.
fn render_expression(ctx: &Ctx<'_>, expression: &Expression<'_>) -> String {
    let mut collector = Collector::new(ctx);
    collector.visit_expression(expression);
    collector.apply(expression.span())
}

/// Literals, identifiers and functions are read once; anything else is read
/// through a getter or thunk so the card follows the signals it reads.
fn is_static(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::Identifier(_)
        | Expression::ArrowFunctionExpression(_)
        | Expression::FunctionExpression(_) => true,
        Expression::TemplateLiteral(template) => template.expressions.is_empty(),
        _ => false,
    }
}

fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';').filter(|end| *end <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// JSX text as React reads it: lines trimmed where they meet a line break,
/// blank lines dropped, the rest joined by one space.
fn jsx_text(raw: &str) -> Option<String> {
    let lines: Vec<&str> = raw.split('\n').collect();
    let last = lines.len() - 1;
    let mut parts = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let mut line = line.trim_end_matches('\r');
        if index != 0 {
            line = line.trim_start();
        }
        if index != last {
            line = line.trim_end();
        }
        if !line.is_empty() {
            parts.push(line);
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(decode_entities(&parts.join(" ")))
}

struct Children(Vec<String>);

impl Children {
    fn array(self) -> String {
        format!("[{}]", self.0.join(", "))
    }

    /// The value of a `children` prop: one child alone, several as an array.
    fn value(self) -> Option<String> {
        match self.0.len() {
            0 => None,
            1 => self.0.into_iter().next(),
            _ => Some(self.array()),
        }
    }
}

fn render_children(ctx: &Ctx<'_>, children: &[JSXChild<'_>]) -> Children {
    let mut out = Vec::new();
    for child in children {
        match child {
            JSXChild::Text(text) => {
                if let Some(text) = jsx_text(&text.value) {
                    out.push(quote(&text));
                }
            }
            JSXChild::Element(element) => out.push(render_element(ctx, element)),
            JSXChild::Fragment(fragment) => {
                out.push(render_children(ctx, &fragment.children).array())
            }
            JSXChild::ExpressionContainer(container) => {
                let Some(expression) = container.expression.as_expression() else {
                    continue; // `{/* comment */}`
                };
                let rendered = render_expression(ctx, expression);
                if is_static(expression) {
                    out.push(format!("({rendered})"));
                } else {
                    out.push(format!("() => ({rendered})"));
                }
            }
            JSXChild::Spread(spread) => {
                ctx.fail(
                    spread.span,
                    "spread children are not supported; map the array inside `{...}`",
                );
            }
        }
    }
    Children(out)
}

fn render_tag(ctx: &Ctx<'_>, element: &JSXElement<'_>) -> Option<String> {
    let name = &element.opening_element.name;
    match name {
        JSXElementName::IdentifierReference(identifier) => Some(identifier.name.to_string()),
        JSXElementName::MemberExpression(member) => Some(ctx.text(member.span).to_owned()),
        JSXElementName::Identifier(identifier) => {
            ctx.fail(
                identifier.span,
                format!(
                    "`<{}>` is not a component. Cards have no HTML tags: use View, Text, Image or Scroll from \"nsh\", or the kit's components from \"openbitfun/genui\"",
                    identifier.name
                ),
            );
            None
        }
        JSXElementName::NamespacedName(namespaced) => {
            ctx.fail(namespaced.span, "namespaced tags are not supported");
            None
        }
        JSXElementName::ThisExpression(this) => {
            ctx.fail(this.span, "`<this>` is not supported");
            None
        }
    }
}

fn render_element(ctx: &Ctx<'_>, element: &JSXElement<'_>) -> String {
    let Some(tag) = render_tag(ctx, element) else {
        return "null".to_owned();
    };
    // Props: groups of plain entries, joined by spreads through `merge`.
    let mut sources: Vec<String> = Vec::new();
    let mut entries: Vec<String> = Vec::new();
    for item in &element.opening_element.attributes {
        match item {
            JSXAttributeItem::SpreadAttribute(spread) => {
                if !entries.is_empty() {
                    sources.push(format!("{{ {} }}", entries.join(", ")));
                    entries.clear();
                }
                sources.push(format!("({})", render_expression(ctx, &spread.argument)));
            }
            JSXAttributeItem::Attribute(attribute) => {
                let name = match &attribute.name {
                    JSXAttributeName::Identifier(identifier) => identifier.name.to_string(),
                    JSXAttributeName::NamespacedName(namespaced) => {
                        ctx.fail(namespaced.span, "namespaced attributes are not supported");
                        continue;
                    }
                };
                let key = quote(&name);
                match &attribute.value {
                    None => entries.push(format!("{key}: true")),
                    Some(JSXAttributeValue::StringLiteral(literal)) => {
                        entries.push(format!(
                            "{key}: {}",
                            quote(&decode_entities(&literal.value))
                        ));
                    }
                    Some(JSXAttributeValue::ExpressionContainer(container)) => {
                        let Some(expression) = container.expression.as_expression() else {
                            continue;
                        };
                        let rendered = render_expression(ctx, expression);
                        if is_static(expression) {
                            entries.push(format!("{key}: ({rendered})"));
                        } else {
                            entries.push(format!("get {key}() {{ return ({rendered}); }}"));
                        }
                    }
                    Some(JSXAttributeValue::Element(inner)) => {
                        entries.push(format!(
                            "get {key}() {{ return {}; }}",
                            render_element(ctx, inner)
                        ));
                    }
                    Some(JSXAttributeValue::Fragment(fragment)) => {
                        entries.push(format!(
                            "get {key}() {{ return {}; }}",
                            render_children(ctx, &fragment.children).array()
                        ));
                    }
                }
            }
        }
    }
    if let Some(children) = render_children(ctx, &element.children).value() {
        entries.push(format!("get \"children\"() {{ return {children}; }}"));
    }
    if !entries.is_empty() || sources.is_empty() {
        sources.push(format!("{{ {} }}", entries.join(", ")));
    }
    let mut props = sources.remove(0);
    for source in sources {
        props = format!("__rt.merge({props}, {source})");
    }
    format!("__rt.component({tag}, {props})")
}

fn module_parameter(specifier: &str) -> Option<&'static str> {
    MODULES
        .iter()
        .find(|(name, _)| *name == specifier)
        .map(|(_, parameter)| *parameter)
}

/// JS with JSX → the factory.
fn splice(js: &str) -> Result<CompiledModule, CompileError> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, js, SourceType::jsx().with_module(true)).parse();
    if parsed.panicked || parsed.diagnostics.has_errors() {
        let errors: Vec<OxcDiagnostic> = parsed.diagnostics.errors().cloned().collect();
        return Err(error(format!(
            "The module does not parse after its types are removed:\n{}",
            describe(js, &errors)
        )));
    }
    let program: &Program<'_> = &parsed.program;
    let ctx = Ctx {
        src: js,
        errors: RefCell::new(Vec::new()),
    };
    let mut collector = Collector::new(&ctx);
    let mut bindings: Vec<String> = Vec::new();
    let mut imports: Vec<String> = Vec::new();
    let mut root: Option<String> = None;

    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                collector
                    .out
                    .push((import.span.start, import.span.end, String::new()));
                let specifier = import.source.value.as_str();
                let Some(parameter) = module_parameter(specifier) else {
                    ctx.fail(
                        import.span,
                        format!(
                            "\"{specifier}\" cannot be imported in a card; import only from {}",
                            MODULES
                                .iter()
                                .map(|(name, _)| format!("\"{name}\""))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    );
                    continue;
                };
                if !imports.iter().any(|m| m == specifier) {
                    imports.push(specifier.to_owned());
                }
                for spec in import.specifiers.iter().flatten() {
                    match spec {
                        ImportDeclarationSpecifier::ImportSpecifier(named) => {
                            let imported = named.imported.name();
                            if parameter == "__kit" && !KIT_EXPORTS.contains(&imported.as_str()) {
                                ctx.fail(
                                    named.span,
                                    format!(
                                        "\"openbitfun/genui\" has no export `{imported}`; it exports {}",
                                        KIT_EXPORTS.join(", ")
                                    ),
                                );
                            }
                            bindings.push(format!(
                                "const {} = {parameter}[{}];",
                                named.local.name,
                                quote(&imported)
                            ));
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                            bindings.push(format!("const {} = {parameter};", namespace.local.name));
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                            ctx.fail(
                                default.span,
                                format!(
                                    "\"{specifier}\" has no default export; import names in braces"
                                ),
                            );
                        }
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let declaration_start = export.declaration.span().start;
                match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        match &function.id {
                            Some(id) => {
                                collector.out.push((
                                    export.span.start,
                                    declaration_start,
                                    String::new(),
                                ));
                                root = Some(id.name.to_string());
                            }
                            None => {
                                collector.out.push((
                                    export.span.start,
                                    declaration_start,
                                    "const __card = ".to_owned(),
                                ));
                                root = Some("__card".to_owned());
                            }
                        }
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                        ctx.fail(
                            class.span,
                            "the default export must be a function component, not a class",
                        );
                    }
                    kind => {
                        if kind.as_expression().is_some() {
                            collector.out.push((
                                export.span.start,
                                declaration_start,
                                "const __card = ".to_owned(),
                            ));
                            root = Some("__card".to_owned());
                        }
                    }
                }
                collector.visit_export_default_declaration(export);
            }
            Statement::ExportNamedDeclaration(export) => {
                if export.source.is_some() {
                    ctx.fail(export.span, "re-exports are not supported in a card");
                    continue;
                }
                match &export.declaration {
                    Some(declaration) => {
                        collector.out.push((
                            export.span.start,
                            declaration.span().start,
                            String::new(),
                        ));
                        collector.visit_declaration(declaration);
                    }
                    None => collector
                        .out
                        .push((export.span.start, export.span.end, String::new())),
                }
            }
            Statement::ExportAllDeclaration(export) => {
                ctx.fail(export.span, "`export *` is not supported in a card");
            }
            other => walk::walk_statement(&mut collector, other),
        }
    }

    let errors = ctx.errors.borrow().clone();
    if !errors.is_empty() {
        return Err(error(errors.join("\n")));
    }
    let Some(root) = root else {
        return Err(error(
            "The module has no default export. End with `export default function Card() { ... }`, the card's root component.",
        ));
    };
    let body = collector.apply(program.span);
    let mut factory =
        String::from("(function (__rt, __nsh, __base, __plot, __kit) {\n\"use strict\";\n");
    for binding in bindings {
        factory.push_str(&binding);
        factory.push('\n');
    }
    factory.push_str(body.trim());
    let _ = write!(factory, "\nreturn {root};\n}})");
    Ok(CompiledModule { factory, imports })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(source: &str) -> String {
        match compile(source) {
            Ok(module) => module.factory,
            Err(error) => panic!("did not compile: {error}"),
        }
    }

    fn err(source: &str) -> String {
        compile(source).expect_err("should not compile").message
    }

    #[test]
    fn compiles_components_with_getters_and_thunks() {
        let factory = ok(r#"
import { signal, View, Text } from "nsh";
import { Button } from "openbitfun/genui";
const n = signal<number>(0);
interface Props { label: string }
export default function Card(props: Props) {
  return (
    <View class="p-4" style={{ gap: n() }}>
      <Text>hits {n()}</Text>
      <Button label="Hit" onPress={() => n.set(n() + 1)} />
      {n() > 1 ? <Text>big</Text> : null}
    </View>
  );
}
"#);
        assert!(factory.starts_with("(function (__rt, __nsh, __base, __plot, __kit) {"));
        assert!(factory.contains("const View = __nsh[\"View\"];"));
        assert!(factory.contains("const Button = __kit[\"Button\"];"));
        assert!(factory.contains(
            "__rt.component(View, { \"class\": \"p-4\", get \"style\"() { return ({ gap: n() }); }"
        ));
        assert!(factory.contains(
            "__rt.component(Text, { get \"children\"() { return [\"hits \", () => (n())]; } })"
        ));
        assert!(factory.contains("\"onPress\": (() => n.set(n() + 1))"));
        assert!(factory.contains("() => (n() > 1 ? __rt.component(Text, { get \"children\"() { return \"big\"; } }) : null)"));
        assert!(factory.trim_end().ends_with("return Card;\n})"));
        assert!(!factory.contains("interface"));
        assert!(!factory.contains("<number>"));
    }

    #[test]
    fn spreads_merge_and_fragments_become_arrays() {
        let factory = ok(r#"
import { View, Text } from "nsh";
const rest = { testID: "x" };
export default () => <View {...rest} accessible><>a{rest.testID}</></View>;
"#);
        assert!(factory.contains("__rt.merge((rest), { \"accessible\": true, get \"children\"() { return [\"a\", () => (rest.testID)]; } })"));
        assert!(factory.contains("const __card = "));
        assert!(factory.contains("return __card;"));
    }

    #[test]
    fn nested_jsx_inside_expressions_is_compiled() {
        let factory = ok(r#"
import { View, Text } from "nsh";
const rows = ["a", "b"];
export default function Card() {
  return <View>{rows.map(r => <Text key={r}>{r}</Text>)}</View>;
}
"#);
        assert!(factory.contains("() => (rows.map((r) => __rt.component(Text, { \"key\": (r), get \"children\"() { return (r); } })))"));
        assert!(!factory.contains("<Text"));
    }

    #[test]
    fn text_whitespace_follows_jsx() {
        let factory = ok("import { Text } from \"nsh\";\nexport default () => <Text>\n  Hello\n  world &amp; you\n</Text>;");
        assert!(factory.contains("\"Hello world & you\""));
    }

    #[test]
    fn rejects_html_tags_and_foreign_modules() {
        assert!(err("export default () => <div>x</div>;").contains("Cards have no HTML tags"));
        assert!(err("import fs from \"fs\";\nexport default () => null;")
            .contains("cannot be imported"));
        assert!(
            err("import { Nope } from \"openbitfun/genui\";\nexport default () => null;")
                .contains("has no export `Nope`")
        );
        assert!(
            err("import { View } from \"nsh\";\nexport const A = () => <View />;")
                .contains("no default export")
        );
        assert!(err("export default () => { import(\"x\"); return null; };")
            .contains("dynamic import()"));
    }

    #[test]
    fn reports_syntax_errors_with_positions() {
        let message = err("export default () => <View>;\n");
        assert!(message.contains("1:"), "{message}");
    }

    #[test]
    fn type_only_imports_disappear() {
        let factory = ok(r#"
import type { JSX } from "nsh";
import { View, type ViewStyle } from "nsh";
const s: ViewStyle = { padding: 4 };
export default function Card(): JSX.Element { return <View style={s} />; }
"#);
        assert!(factory.contains("const View = __nsh[\"View\"];"));
        assert!(!factory.contains("ViewStyle"));
        assert!(!factory.contains("JSX ="));
    }
}
