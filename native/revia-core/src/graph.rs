use crate::{
    canonical_json::quote,
    digest::sha256_hex,
    lexer::{Token, TokenKind, decode_json_string},
    parser::tokenize_source,
};

const VERSION: &str = "0.1";
const CANONICAL_HEADER: &str = "re 0.1 canonical";
const UID_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphError {
    pub code: String,
    pub actual: Option<String>,
    pub expected: Option<String>,
}

impl GraphError {
    pub(crate) fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
            actual: None,
            expected: None,
        }
    }

    pub(crate) fn with_actual(mut self, actual: impl Into<String>) -> Self {
        self.actual = Some(actual.into());
        self
    }

    pub(crate) fn with_expected(mut self, expected: impl Into<String>) -> Self {
        self.expected = Some(expected.into());
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Graph {
    pub version: String,
    pub unit: String,
    pub capabilities: Vec<CapabilityNode>,
    pub functions: Vec<FunctionNode>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityNode {
    pub kind: String,
    pub uid: String,
    pub instance: String,
    pub reference: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FunctionNode {
    pub kind: String,
    pub uid: String,
    pub name: String,
    pub return_type: String,
    pub literals: Vec<LiteralNode>,
    pub statements: Vec<Statement>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiteralNode {
    pub kind: String,
    pub uid: String,
    pub type_name: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Statement {
    Let {
        kind: String,
        uid: String,
        binding: String,
        value: Call,
    },
    Return {
        kind: String,
        uid: String,
        value: MatchNode,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchNode {
    pub kind: String,
    pub uid: String,
    pub input_producer: String,
    pub branches: Vec<BranchNode>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BranchNode {
    pub kind: String,
    pub uid: String,
    pub variant: String,
    pub value: Call,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    pub kind: String,
    pub uid: String,
    pub target: Target,
    pub arguments: Vec<Argument>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    CapabilityMember {
        kind: String,
        instance: String,
        member: String,
        schema_reference: String,
    },
    PureOperation {
        kind: String,
        operation: String,
        schema_reference: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Argument {
    pub name: String,
    pub endpoint: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewManifest {
    pub schema: String,
    pub graph_revision: String,
    pub unit: String,
    pub reachable: Vec<String>,
    pub executed: Vec<String>,
    pub execution_evidence: String,
    pub uid_anchors: Vec<String>,
}

pub fn parse_compact_graph(source: &str, file: &str) -> Result<Graph, GraphError> {
    let tokens = tokenize_source(source, file).map_err(|diagnostic| {
        GraphError::new(&diagnostic.code)
            .with_actual(diagnostic.actual.unwrap_or(diagnostic.lexeme))
    })?;
    let mut cursor = Cursor::new(tokens);
    let mut ids = IdFactory::default();
    cursor.expect("unit")?;
    let unit = cursor.take("unit identity")?.text;
    let mut capabilities = Vec::new();
    while cursor.peek().text == "cap" {
        cursor.expect("cap")?;
        let instance = cursor.take("capability instance")?.text;
        cursor.expect(":")?;
        let reference = cursor.take("schema reference")?.text;
        capabilities.push(CapabilityNode {
            kind: "cap".to_owned(),
            uid: ids.next(),
            instance,
            reference,
        });
    }
    cursor.expect("fn")?;
    let name = cursor.take("function name")?.text;
    cursor.expect("(")?;
    cursor.expect(")")?;
    cursor.expect("->")?;
    let return_type = cursor.take("return type")?.text;
    cursor.expect("{")?;
    let mut function = FunctionNode {
        kind: "function".to_owned(),
        uid: ids.next(),
        name,
        return_type,
        literals: Vec::new(),
        statements: Vec::new(),
    };
    while cursor.peek().text != "}" {
        if cursor.peek().text.starts_with('%') {
            let binding = cursor.take("value binding")?.text;
            let statement_uid = ids.next();
            cursor.expect("=")?;
            let value =
                parse_compact_call(&mut cursor, &capabilities, &mut function.literals, &mut ids)?;
            function.statements.push(Statement::Let {
                kind: "let".to_owned(),
                uid: statement_uid,
                binding,
                value,
            });
        } else if cursor.peek().text == "return" {
            cursor.expect("return")?;
            let statement_uid = ids.next();
            let value =
                parse_compact_match(&mut cursor, &capabilities, &mut function.literals, &mut ids)?;
            function.statements.push(Statement::Return {
                kind: "return".to_owned(),
                uid: statement_uid,
                value,
            });
        } else {
            return Err(cursor.error("unexpected-token"));
        }
    }
    cursor.expect("}")?;
    cursor.expect_end()?;
    Ok(Graph {
        version: VERSION.to_owned(),
        unit,
        capabilities,
        functions: vec![function],
    })
}

pub fn check_graph(mut graph: Graph) -> Result<Graph, GraphError> {
    validate_identities(&graph)?;
    if graph.version != VERSION {
        return Err(GraphError::new("unsupported-language-version"));
    }
    for capability in &graph.capabilities {
        if !is_known_schema(&capability.reference) {
            return Err(GraphError::new("unknown-schema-reference")
                .with_actual(capability.reference.clone()));
        }
    }
    if graph.functions.is_empty() {
        return Err(GraphError::new("missing-main-entry"));
    }
    let capabilities = graph
        .capabilities
        .iter()
        .map(|capability| (capability.instance.clone(), capability.reference.clone()))
        .collect::<std::collections::BTreeMap<_, _>>();
    for function in &mut graph.functions {
        let mut producers = std::collections::BTreeMap::new();
        for literal in &function.literals {
            validate_literal(literal)?;
        }
        for statement in &mut function.statements {
            match statement {
                Statement::Let {
                    uid,
                    binding,
                    value,
                    ..
                } => {
                    if producers.insert(binding.clone(), uid.clone()).is_some() {
                        return Err(GraphError::new("duplicate-value-binding"));
                    }
                    check_call(value, &capabilities, &function.literals)?;
                    if binding.is_empty() {
                        return Err(GraphError::new("invalid-value-binding"));
                    }
                }
                Statement::Return { value, .. } => {
                    if let Some(producer_uid) = producers.get(&value.input_producer).cloned() {
                        value.input_producer = producer_uid;
                    } else if !producers.values().any(|uid| uid == &value.input_producer) {
                        return Err(GraphError::new("unknown-value-producer")
                            .with_actual(value.input_producer.clone()));
                    }
                    if value.branches.is_empty() {
                        return Err(GraphError::new("non-exhaustive-result-match"));
                    }
                    for branch in &value.branches {
                        check_call(&branch.value, &capabilities, &function.literals)?;
                    }
                }
            }
        }
    }
    Ok(graph)
}

pub fn serialize_canonical_graph(graph: &Graph) -> Result<String, GraphError> {
    validate_identities(graph)?;
    let mut capabilities = graph.capabilities.clone();
    capabilities.sort_by(|left, right| left.instance.as_bytes().cmp(right.instance.as_bytes()));
    let mut functions = graph.functions.clone();
    functions.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    let mut lines = vec![CANONICAL_HEADER.to_owned(), format!("unit {}", graph.unit)];
    for capability in capabilities {
        lines.push(format!(
            "cap {} {} = {}",
            render_identity(&capability.uid),
            capability.instance,
            capability.reference
        ));
    }
    for function in functions {
        lines.push(format!(
            "fn {} {} -> {} {{",
            render_identity(&function.uid),
            function.name,
            function.return_type
        ));
        let mut literals = function.literals.clone();
        literals.sort_by(|left, right| left.uid.as_bytes().cmp(right.uid.as_bytes()));
        for literal in literals {
            lines.push(format!(
                "  literal {} {} = {}",
                render_identity(&literal.uid),
                literal.type_name,
                encode_literal(&literal)?
            ));
        }
        let mut statements = function.statements.clone();
        statements.sort_by_key(statement_rank);
        for statement in statements {
            render_statement(&mut lines, statement)?;
        }
        lines.push("}".to_owned());
    }
    Ok(format!("{}\n", lines.join("\n")))
}

pub fn load_canonical_graph(source: &str) -> Result<Graph, GraphError> {
    if !source.starts_with(&format!("{CANONICAL_HEADER}\n")) {
        return Err(GraphError::new("invalid-grammar-header"));
    }
    let mut lines = source.split('\n').collect::<Vec<_>>();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let mut state = CanonicalState::default();
    let mut index = 1usize;
    let mut unit = None;
    let mut capabilities = Vec::new();
    let mut functions = Vec::new();
    while index < lines.len() {
        let line = lines[index];
        if let Some(unit_text) = line.strip_prefix("unit ") {
            if unit.is_some() {
                return Err(GraphError::new("duplicate-unit"));
            }
            unit = Some(unit_text.to_owned());
            index += 1;
            continue;
        }
        if line.starts_with("cap ") {
            let (capability, reference) = parse_canonical_capability(line, &mut state)?;
            state
                .references
                .insert(capability.instance.clone(), reference);
            capabilities.push(capability);
            index += 1;
            continue;
        }
        if line.starts_with("fn ") {
            let (function, next) = parse_canonical_function(&lines, index, &mut state)?;
            functions.push(function);
            index = next;
            continue;
        }
        return Err(GraphError::new("unexpected-canonical-line"));
    }
    let mut graph = Graph {
        version: VERSION.to_owned(),
        unit: unit.ok_or_else(|| GraphError::new("missing-unit"))?,
        capabilities,
        functions,
    };
    resolve_labels(&mut graph, &state)?;
    let checked = check_graph(graph)?;
    let expected = serialize_canonical_graph(&checked)?;
    if expected != source {
        return Err(GraphError::new("non-canonical-source"));
    }
    Ok(checked)
}

pub fn graph_revision(graph: &Graph) -> Result<String, GraphError> {
    Ok(format!(
        "sha256:{}",
        sha256_hex(serialize_canonical_graph(graph)?.as_bytes())
    ))
}

pub fn review_manifest(graph: &Graph) -> Result<ReviewManifest, GraphError> {
    let revision = graph_revision(graph)?;
    let mut reachable = vec![
        "unit".to_owned(),
        "capability".to_owned(),
        "function".to_owned(),
        "return".to_owned(),
    ];
    let executed = Vec::new();
    for function in &graph.functions {
        reachable.push(format!("function:{}", function.name));
        for statement in &function.statements {
            match statement {
                Statement::Let { .. } => {
                    reachable.push("call".to_owned());
                }
                Statement::Return { value, .. } => {
                    reachable.push("match".to_owned());
                    for branch in &value.branches {
                        reachable.push(format!("branch:{}", branch.variant));
                    }
                }
            }
        }
    }
    reachable.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    let mut uid_anchors = collect_uids(graph);
    uid_anchors.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(ReviewManifest {
        schema: "re.native-review-manifest@0.1.0".to_owned(),
        graph_revision: revision,
        unit: graph.unit.clone(),
        reachable,
        executed,
        execution_evidence: "not-collected".to_owned(),
        uid_anchors,
    })
}

fn parse_compact_call(
    cursor: &mut Cursor,
    capabilities: &[CapabilityNode],
    literals: &mut Vec<LiteralNode>,
    ids: &mut IdFactory,
) -> Result<Call, GraphError> {
    let operation = cursor.take("operation call")?.text;
    let target = compact_target(&operation, capabilities)?;
    let call_uid = ids.next();
    cursor.expect("(")?;
    let mut arguments = Vec::new();
    if cursor.peek().text != ")" {
        loop {
            let first = cursor.take("call argument")?.text;
            let named = cursor.peek().text == ":";
            let name = if named {
                cursor.expect(":")?;
                first.clone()
            } else {
                default_argument_name(&target, arguments.len())?
            };
            let value = if named {
                cursor.take("call argument")?
            } else {
                Token {
                    text: first.clone(),
                    kind: if first.starts_with('"') {
                        TokenKind::String
                    } else {
                        TokenKind::Atom
                    },
                    start: 0,
                    end: 0,
                    line: 0,
                    column: 0,
                }
            };
            let (type_name, value_text) = contextual_literal(&target, &name, &value)?;
            let literal_uid = ids.next();
            literals.push(LiteralNode {
                kind: "literal".to_owned(),
                uid: literal_uid.clone(),
                type_name,
                value: value_text,
            });
            arguments.push(Argument {
                name,
                endpoint: literal_uid,
            });
            if cursor.peek().text != "," {
                break;
            }
            cursor.expect(",")?;
        }
    }
    cursor.expect(")")?;
    Ok(Call {
        kind: "call".to_owned(),
        uid: call_uid,
        target,
        arguments,
    })
}

fn parse_compact_match(
    cursor: &mut Cursor,
    capabilities: &[CapabilityNode],
    literals: &mut Vec<LiteralNode>,
    ids: &mut IdFactory,
) -> Result<MatchNode, GraphError> {
    cursor.expect("match")?;
    let input = cursor.take("matched value")?.text;
    cursor.expect("{")?;
    let match_uid = ids.next();
    let mut branches = Vec::new();
    while cursor.peek().text != "}" {
        let variant = cursor.take("match variant")?.text;
        cursor.expect("(")?;
        cursor.expect("_")?;
        cursor.expect(")")?;
        cursor.expect("=>")?;
        let branch_uid = ids.next();
        let call = parse_compact_call(cursor, capabilities, literals, ids)?;
        branches.push(BranchNode {
            kind: "match-branch".to_owned(),
            uid: branch_uid,
            variant,
            value: call,
        });
    }
    cursor.expect("}")?;
    Ok(MatchNode {
        kind: "match".to_owned(),
        uid: match_uid,
        input_producer: input,
        branches,
    })
}

fn compact_target(operation: &str, capabilities: &[CapabilityNode]) -> Result<Target, GraphError> {
    if operation == "process.exit" {
        return Ok(Target::PureOperation {
            kind: "pure-operation".to_owned(),
            operation: "process.exit".to_owned(),
            schema_reference: "process.exit@0.1.0".to_owned(),
        });
    }
    if !operation.starts_with('@') {
        return Err(GraphError::new("invalid-call-target"));
    }
    let separator = operation
        .rfind('.')
        .ok_or_else(|| GraphError::new("invalid-call-target"))?;
    let instance = &operation[..separator];
    let member = &operation[separator + 1..];
    let capability = capabilities
        .iter()
        .find(|capability| capability.instance == instance)
        .ok_or_else(|| GraphError::new("unknown-capability-instance"))?;
    Ok(Target::CapabilityMember {
        kind: "capability-member".to_owned(),
        instance: instance.to_owned(),
        member: member.to_owned(),
        schema_reference: capability.reference.clone(),
    })
}

fn contextual_literal(
    target: &Target,
    name: &str,
    token: &Token,
) -> Result<(String, String), GraphError> {
    match target {
        Target::PureOperation { operation, .. } if operation == "process.exit" => {
            if token.kind != TokenKind::Atom || !is_integer(&token.text) {
                return Err(GraphError::new("invalid-numeric-literal"));
            }
            Ok(("int".to_owned(), token.text.clone()))
        }
        Target::CapabilityMember {
            schema_reference,
            member,
            ..
        } => {
            if token.text == "text.encoding.utf8" {
                return Ok(("text.encoding".to_owned(), token.text.clone()));
            }
            let value = if token.kind == TokenKind::String {
                decode_json_string(&token.text)
                    .ok_or_else(|| GraphError::new("invalid-string-literal"))?
            } else {
                return Err(GraphError::new("unexpected-token"));
            };
            let type_name = match (schema_reference.as_str(), member.as_str(), name) {
                ("fs.write@0.1.0", "write_file", "data") => {
                    if !is_canonical_bytes(&value) {
                        return Err(GraphError::new("invalid-bytes-literal"));
                    }
                    "bytes"
                }
                ("fs.read@0.1.0", "read_file", "path") => "fs.path",
                ("process.stdout@0.1.0", "write", "data") => "text.utf8",
                _ => "text.utf8",
            };
            let canonical_value =
                if type_name == "text.utf8" || type_name == "fs.path" || type_name == "bytes" {
                    value.clone()
                } else {
                    format!("hex:{}", hex_encode(value.as_bytes()))
                };
            if schema_reference == "fs.write@0.1.0" && member == "write_file" && name == "path" {
                return Ok(("fs.path".to_owned(), value));
            }
            Ok((type_name.to_owned(), canonical_value))
        }
        Target::PureOperation { .. } => Err(GraphError::new("unsupported-pure-operation")),
    }
}

fn default_argument_name(target: &Target, index: usize) -> Result<String, GraphError> {
    match target {
        Target::CapabilityMember { member, .. } if member == "write" => Ok("data".to_owned()),
        Target::CapabilityMember { member, .. } if member == "read_file" && index == 0 => {
            Ok("path".to_owned())
        }
        Target::PureOperation { operation, .. } if operation == "process.exit" => {
            Ok("code".to_owned())
        }
        _ => Err(GraphError::new("missing-argument-name")),
    }
}

fn check_call(
    call: &Call,
    capabilities: &std::collections::BTreeMap<String, String>,
    literals: &[LiteralNode],
) -> Result<(), GraphError> {
    let (schema, member) = match &call.target {
        Target::CapabilityMember {
            instance,
            member,
            schema_reference,
            ..
        } => {
            let declared = capabilities
                .get(instance)
                .ok_or_else(|| GraphError::new("unknown-capability-instance"))?;
            if declared != schema_reference {
                return Err(GraphError::new("call-schema-reference-mismatch"));
            }
            (schema_reference.as_str(), member.as_str())
        }
        Target::PureOperation {
            operation,
            schema_reference,
            ..
        } => {
            if operation == "process.exit" && schema_reference != "process.exit@0.1.0" {
                return Err(GraphError::new("unsupported-pure-operation"));
            }
            (schema_reference.as_str(), operation.as_str())
        }
    };
    let params = parameters(schema, member, call.arguments.len())?;
    if call.arguments.len() != params.len() {
        return Err(GraphError::new("argument-count-mismatch"));
    }
    for argument in &call.arguments {
        let expected = params
            .iter()
            .find(|(name, _)| name == &argument.name)
            .ok_or_else(|| GraphError::new("unknown-argument"))?;
        let literal = literals
            .iter()
            .find(|literal| literal.uid == argument.endpoint)
            .ok_or_else(|| GraphError::new("unknown-value-endpoint"))?;
        if literal.type_name != expected.1 {
            return Err(GraphError::new("literal-type-mismatch")
                .with_actual(literal.type_name.clone())
                .with_expected(expected.1.clone()));
        }
    }
    Ok(())
}

fn parameters(
    schema: &str,
    member: &str,
    argument_count: usize,
) -> Result<Vec<(String, String)>, GraphError> {
    match (schema, member) {
        ("process.stdout@0.1.0", "write") => Ok(vec![("data".to_owned(), "text.utf8".to_owned())]),
        ("process.args@0.1.0", "read") => Ok(Vec::new()),
        ("fs.read@0.1.0", "read_file") if argument_count == 1 => {
            Ok(vec![("path".to_owned(), "fs.path".to_owned())])
        }
        ("fs.read@0.1.0", "read_file") if argument_count == 2 => Ok(vec![
            ("encoding".to_owned(), "text.encoding".to_owned()),
            ("path".to_owned(), "fs.path".to_owned()),
        ]),
        ("fs.write@0.1.0", "write_file") => Ok(vec![
            ("data".to_owned(), "bytes".to_owned()),
            ("path".to_owned(), "fs.path".to_owned()),
        ]),
        ("process.exit@0.1.0", "process.exit") => Ok(vec![("code".to_owned(), "int".to_owned())]),
        _ => Err(GraphError::new("unknown-capability-member")),
    }
}

fn validate_literal(literal: &LiteralNode) -> Result<(), GraphError> {
    if literal.type_name == "int" && !is_integer(&literal.value) {
        return Err(GraphError::new("literal-type-mismatch"));
    }
    match literal.type_name.as_str() {
        "text.utf8" | "fs.path" => Ok(()),
        "text.encoding" if literal.value == "text.encoding.utf8" => Ok(()),
        "bytes" if is_canonical_bytes(&literal.value) => Ok(()),
        "int" => Ok(()),
        type_name if type_name.starts_with("decimal<") && is_decimal(&literal.value) => Ok(()),
        _ => Err(GraphError::new("invalid-literal-value")),
    }
}

fn encode_literal(literal: &LiteralNode) -> Result<String, GraphError> {
    validate_literal(literal)?;
    if literal.type_name == "text.utf8" || literal.type_name == "fs.path" {
        return Ok(quote(&literal.value));
    }
    Ok(literal.value.clone())
}

fn render_statement(lines: &mut Vec<String>, statement: Statement) -> Result<(), GraphError> {
    match statement {
        Statement::Let {
            uid,
            binding,
            value,
            ..
        } => lines.push(format!(
            "  let {} {} = {}",
            render_identity(&uid),
            binding,
            render_call(&value)?
        )),
        Statement::Return { uid, value, .. } => {
            let mut branches = value.branches;
            branches.sort_by(|left, right| {
                left.variant
                    .as_bytes()
                    .cmp(right.variant.as_bytes())
                    .then(left.uid.as_bytes().cmp(right.uid.as_bytes()))
            });
            lines.push(format!(
                "  return {} match {} {} {{",
                render_identity(&uid),
                render_identity(&value.uid),
                label_of(&value.input_producer)?
            ));
            for branch in branches {
                lines.push(format!(
                    "    branch {} {} => {}",
                    render_identity(&branch.uid),
                    branch.variant,
                    render_call(&branch.value)?
                ));
            }
            lines.push("  }".to_owned());
        }
    }
    Ok(())
}

fn render_call(call: &Call) -> Result<String, GraphError> {
    let mut arguments = call.arguments.clone();
    arguments.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    let rendered = arguments
        .into_iter()
        .map(|argument| {
            Ok(format!(
                "{}: {}",
                argument.name,
                label_of(&argument.endpoint)?
            ))
        })
        .collect::<Result<Vec<_>, GraphError>>()?
        .join(", ");
    let target = match &call.target {
        Target::CapabilityMember {
            instance, member, ..
        } => format!("{instance}.{member}"),
        Target::PureOperation {
            schema_reference, ..
        } => schema_reference.clone(),
    };
    Ok(format!(
        "call {} {}({rendered})",
        render_identity(&call.uid),
        target
    ))
}

fn render_identity(uid: &str) -> String {
    format!("{}: uid(\"{}\"):", label_of(uid).unwrap_or_default(), uid)
}

fn label_of(uid: &str) -> Result<String, GraphError> {
    if uid.len() != 26 {
        return Err(GraphError::new("invalid-uid"));
    }
    Ok(format!("%u{}", &uid[..7]))
}

fn statement_rank(statement: &Statement) -> (u8, Vec<u8>) {
    match statement {
        Statement::Let { uid, .. } => (0, uid.as_bytes().to_vec()),
        Statement::Return { uid, .. } => (1, uid.as_bytes().to_vec()),
    }
}

#[derive(Default)]
struct IdFactory {
    counter: usize,
}

impl IdFactory {
    fn next(&mut self) -> String {
        let mut value = self.counter;
        self.counter += 1;
        let mut prefix = [b'a'; 7];
        for index in (0..7).rev() {
            prefix[index] = UID_ALPHABET[value % 32];
            value /= 32;
        }
        format!(
            "{}{}",
            String::from_utf8(prefix.to_vec()).unwrap(),
            "a".repeat(19)
        )
    }
}

#[derive(Default)]
struct CanonicalState {
    labels: std::collections::BTreeMap<String, String>,
    references: std::collections::BTreeMap<String, String>,
    uids: std::collections::BTreeSet<String>,
}

fn validate_identities(graph: &Graph) -> Result<(), GraphError> {
    let mut labels = std::collections::BTreeMap::new();
    let mut uids = std::collections::BTreeSet::new();
    for uid in collect_uids(graph) {
        if !is_valid_uid(&uid) {
            return Err(GraphError::new("invalid-uid").with_actual(uid));
        }
        let label = &uid[..7];
        if !uids.insert(uid.clone()) {
            return Err(GraphError::new("uid-collision").with_actual(uid));
        }
        if let Some(previous) = labels.insert(label.to_owned(), uid.clone())
            && previous != uid
        {
            return Err(GraphError::new("ambiguous-label").with_actual(label));
        }
    }
    Ok(())
}

fn collect_uids(graph: &Graph) -> Vec<String> {
    let mut result = Vec::new();
    for capability in &graph.capabilities {
        result.push(capability.uid.clone());
    }
    for function in &graph.functions {
        result.push(function.uid.clone());
        for literal in &function.literals {
            result.push(literal.uid.clone());
        }
        for statement in &function.statements {
            match statement {
                Statement::Let { uid, value, .. } => {
                    result.push(uid.clone());
                    result.push(value.uid.clone());
                }
                Statement::Return { uid, value, .. } => {
                    result.push(uid.clone());
                    result.push(value.uid.clone());
                    for branch in &value.branches {
                        result.push(branch.uid.clone());
                        result.push(branch.value.uid.clone());
                    }
                }
            }
        }
    }
    result
}

fn is_known_schema(reference: &str) -> bool {
    matches!(
        reference,
        "process.stdout@0.1.0"
            | "process.args@0.1.0"
            | "process.exit@0.1.0"
            | "fs.read@0.1.0"
            | "fs.write@0.1.0"
    )
}

fn resolve_labels(graph: &mut Graph, state: &CanonicalState) -> Result<(), GraphError> {
    for function in &mut graph.functions {
        for statement in &mut function.statements {
            match statement {
                Statement::Let { value, .. } => resolve_call(value, state)?,
                Statement::Return { value, .. } => {
                    resolve_endpoint(&mut value.input_producer, state)?;
                    for branch in &value.branches {
                        resolve_call(&branch.value, state)?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn resolve_call(call: &Call, state: &CanonicalState) -> Result<(), GraphError> {
    for argument in &call.arguments {
        if !state.labels.contains_key(&argument.endpoint)
            && !state.uids.contains(&argument.endpoint)
        {
            return Err(GraphError::new("unknown-canonical-label"));
        }
    }
    Ok(())
}

fn resolve_endpoint(endpoint: &mut String, state: &CanonicalState) -> Result<(), GraphError> {
    if let Some(uid) = state.labels.get(endpoint) {
        *endpoint = uid.clone();
        return Ok(());
    }
    if state.uids.contains(endpoint) {
        return Ok(());
    }
    Err(GraphError::new("unknown-canonical-label"))
}

fn parse_canonical_capability(
    line: &str,
    state: &mut CanonicalState,
) -> Result<(CapabilityNode, String), GraphError> {
    let mut cursor = LineCursor::new(line);
    cursor.expect("cap")?;
    let uid = cursor.identity(state)?;
    let instance = cursor.take()?;
    cursor.expect("=")?;
    let reference = cursor.take()?;
    cursor.end()?;
    Ok((
        CapabilityNode {
            kind: "cap".to_owned(),
            uid,
            instance,
            reference: reference.clone(),
        },
        reference,
    ))
}

fn parse_canonical_function(
    lines: &[&str],
    start: usize,
    state: &mut CanonicalState,
) -> Result<(FunctionNode, usize), GraphError> {
    let mut cursor = LineCursor::new(lines[start]);
    cursor.expect("fn")?;
    let uid = cursor.identity(state)?;
    let name = cursor.take()?;
    cursor.expect("->")?;
    let return_type = cursor.take()?;
    cursor.expect("{")?;
    cursor.end()?;
    let mut function = FunctionNode {
        kind: "function".to_owned(),
        uid,
        name,
        return_type,
        literals: Vec::new(),
        statements: Vec::new(),
    };
    let mut index = start + 1;
    while index < lines.len() && lines[index] != "}" {
        let line = lines[index];
        if line.starts_with("  literal ") {
            let mut cursor = LineCursor::new(line);
            cursor.expect("literal")?;
            let uid = cursor.identity(state)?;
            let type_name = cursor.take()?;
            cursor.expect("=")?;
            let raw = cursor.remaining();
            let value = if type_name == "text.utf8" || type_name == "fs.path" {
                decode_json_string(raw).ok_or_else(|| GraphError::new("invalid-literal-value"))?
            } else {
                raw.to_owned()
            };
            function.literals.push(LiteralNode {
                kind: "literal".to_owned(),
                uid,
                type_name,
                value,
            });
            index += 1;
            continue;
        }
        if line.starts_with("  let ") {
            let mut cursor = LineCursor::new(line);
            cursor.expect("let")?;
            let uid = cursor.identity(state)?;
            let binding = cursor.take()?;
            cursor.expect("=")?;
            let call = parse_canonical_call(cursor.remaining(), state)?;
            function.statements.push(Statement::Let {
                kind: "let".to_owned(),
                uid,
                binding,
                value: call,
            });
            index += 1;
            continue;
        }
        if line.starts_with("  return ") {
            let (statement, next) = parse_canonical_return(lines, index, state)?;
            function.statements.push(statement);
            index = next;
            continue;
        }
        return Err(GraphError::new("invalid-statement-line"));
    }
    if index >= lines.len() {
        return Err(GraphError::new("unterminated-function"));
    }
    Ok((function, index + 1))
}

fn parse_canonical_return(
    lines: &[&str],
    start: usize,
    state: &mut CanonicalState,
) -> Result<(Statement, usize), GraphError> {
    let mut cursor = LineCursor::new(lines[start]);
    cursor.expect("return")?;
    let statement_uid = cursor.identity(state)?;
    cursor.expect("match")?;
    let match_uid = cursor.identity(state)?;
    let input_label = cursor.take()?;
    cursor.expect("{")?;
    let mut branches = Vec::new();
    let mut index = start + 1;
    while index < lines.len() && lines[index] != "  }" {
        let mut branch_cursor = LineCursor::new(lines[index]);
        branch_cursor.expect("branch")?;
        let uid = branch_cursor.identity(state)?;
        let variant = branch_cursor.take()?;
        branch_cursor.expect("=>")?;
        let call = parse_canonical_call(branch_cursor.remaining(), state)?;
        branches.push(BranchNode {
            kind: "match-branch".to_owned(),
            uid,
            variant,
            value: call,
        });
        index += 1;
    }
    if index >= lines.len() {
        return Err(GraphError::new("unterminated-match"));
    }
    Ok((
        Statement::Return {
            kind: "return".to_owned(),
            uid: statement_uid,
            value: MatchNode {
                kind: "match".to_owned(),
                uid: match_uid,
                input_producer: input_label,
                branches,
            },
        },
        index + 1,
    ))
}

fn parse_canonical_call(text: &str, state: &CanonicalState) -> Result<Call, GraphError> {
    let body = text
        .strip_prefix("call ")
        .ok_or_else(|| GraphError::new("invalid-call"))?;
    let identity_end = body
        .find("): ")
        .ok_or_else(|| GraphError::new("invalid-identity"))?;
    let uid = parse_uid_identity(&body[..identity_end + 2])?;
    let target_and_args = &body[identity_end + 3..];
    let target_end = target_and_args
        .find('(')
        .ok_or_else(|| GraphError::new("invalid-call-target"))?;
    let target_text = &target_and_args[..target_end];
    let target = if target_text.starts_with('@') {
        let separator = target_text
            .rfind('.')
            .ok_or_else(|| GraphError::new("invalid-call-target"))?;
        let instance = &target_text[..separator];
        let member = &target_text[separator + 1..];
        let reference = state
            .references
            .get(instance)
            .ok_or_else(|| GraphError::new("unknown-canonical-capability-instance"))?;
        Target::CapabilityMember {
            kind: "capability-member".to_owned(),
            instance: instance.to_owned(),
            member: member.to_owned(),
            schema_reference: reference.clone(),
        }
    } else {
        let (operation, version) = target_text
            .rsplit_once('@')
            .ok_or_else(|| GraphError::new("invalid-call-target"))?;
        Target::PureOperation {
            kind: "pure-operation".to_owned(),
            operation: operation.to_owned(),
            schema_reference: format!("{operation}@{version}"),
        }
    };
    let open = target_and_args
        .find('(')
        .ok_or_else(|| GraphError::new("invalid-call"))?;
    let close = target_and_args
        .rfind(')')
        .ok_or_else(|| GraphError::new("invalid-call"))?;
    let args_text = &target_and_args[open + 1..close];
    let mut arguments = Vec::new();
    if !args_text.is_empty() {
        for item in args_text.split(", ") {
            let (name, label) = item
                .split_once(": ")
                .ok_or_else(|| GraphError::new("invalid-call"))?;
            arguments.push(Argument {
                name: name.to_owned(),
                endpoint: state
                    .labels
                    .get(label)
                    .cloned()
                    .unwrap_or_else(|| label.to_owned()),
            });
        }
    }
    Ok(Call {
        kind: "call".to_owned(),
        uid,
        target,
        arguments,
    })
}

fn parse_uid_identity(text: &str) -> Result<String, GraphError> {
    let marker = "uid(\"";
    let start = text
        .find(marker)
        .ok_or_else(|| GraphError::new("invalid-identity"))?
        + marker.len();
    let end = text[start..]
        .find("\"):")
        .ok_or_else(|| GraphError::new("invalid-identity"))?
        + start;
    let uid = &text[start..end];
    if !is_valid_uid(uid) {
        return Err(GraphError::new("invalid-uid"));
    }
    let label = text[..text
        .find(':')
        .ok_or_else(|| GraphError::new("invalid-identity"))?]
        .trim();
    if label != format!("%u{}", &uid[..7]) {
        return Err(GraphError::new("label-uid-mismatch"));
    }
    Ok(uid.to_owned())
}

struct LineCursor<'a> {
    parts: Vec<&'a str>,
    index: usize,
    raw: &'a str,
}

impl<'a> LineCursor<'a> {
    fn new(raw: &'a str) -> Self {
        Self {
            parts: raw.split_whitespace().collect(),
            index: 0,
            raw,
        }
    }

    fn take(&mut self) -> Result<String, GraphError> {
        let value = self
            .parts
            .get(self.index)
            .ok_or_else(|| GraphError::new("unexpected-token"))?;
        self.index += 1;
        Ok((*value).to_owned())
    }

    fn expect(&mut self, expected: &str) -> Result<(), GraphError> {
        if self.take()? != expected {
            return Err(GraphError::new("unexpected-token").with_expected(expected));
        }
        Ok(())
    }

    fn identity(&mut self, state: &mut CanonicalState) -> Result<String, GraphError> {
        let label = self.take()?.trim_end_matches(':').to_owned();
        let quoted = self.take()?;
        let uid = quoted
            .strip_prefix("uid(\"")
            .and_then(|value| value.strip_suffix("\"):"))
            .ok_or_else(|| GraphError::new("invalid-identity"))?
            .to_owned();
        if label != format!("%u{}", &uid[..7]) {
            return Err(GraphError::new("label-uid-mismatch"));
        }
        if !state.uids.insert(uid.clone()) {
            return Err(GraphError::new("uid-collision"));
        }
        state.labels.insert(label, uid.clone());
        Ok(uid)
    }

    fn end(&self) -> Result<(), GraphError> {
        if self.index != self.parts.len() {
            Err(GraphError::new("unexpected-token"))
        } else {
            Ok(())
        }
    }

    fn remaining(&self) -> &'a str {
        let marker = self.parts.get(self.index).copied().unwrap_or("");
        self.raw
            .find(marker)
            .map(|offset| &self.raw[offset..])
            .unwrap_or("")
    }
}

struct Cursor {
    tokens: Vec<Token>,
    index: usize,
}

impl Cursor {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, index: 0 }
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.index]
    }

    fn take(&mut self, expected: &str) -> Result<Token, GraphError> {
        let token = self.peek().clone();
        if token.kind == TokenKind::End {
            return Err(self.error(expected));
        }
        self.index += 1;
        Ok(token)
    }

    fn expect(&mut self, expected: &str) -> Result<(), GraphError> {
        if self.take(expected)?.text != expected {
            return Err(self.error(expected));
        }
        Ok(())
    }

    fn expect_end(&self) -> Result<(), GraphError> {
        if self.peek().kind == TokenKind::End {
            Ok(())
        } else {
            Err(self.error("end of file"))
        }
    }

    fn error(&self, expected: &str) -> GraphError {
        GraphError::new("unexpected-token").with_expected(expected)
    }
}

fn is_valid_uid(uid: &str) -> bool {
    uid.len() == 26 && uid.bytes().all(|byte| UID_ALPHABET.contains(&byte))
}

fn is_integer(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && !(digits.len() > 1 && digits.starts_with('0'))
        && value != "-0"
}

fn is_decimal(value: &str) -> bool {
    let Some((whole, fraction)) = value.split_once('.') else {
        return false;
    };
    let whole = whole.strip_prefix('-').unwrap_or(whole);
    !whole.is_empty()
        && !fraction.is_empty()
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.bytes().all(|byte| byte.is_ascii_digit())
        && !(whole.len() > 1 && whole.starts_with('0'))
}

fn is_canonical_bytes(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("hex:") else {
        return false;
    };
    !hex.is_empty()
        && hex.len() % 2 == 0
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
