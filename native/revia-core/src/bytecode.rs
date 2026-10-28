use std::collections::BTreeMap;

use crate::{
    canonical_json::quote,
    digest::sha256_hex,
    graph::{Argument, Call, Graph, GraphError, Statement, Target, check_graph, graph_revision},
    lexer::decode_json_string,
};

pub const NATIVE_BYTECODE_SCHEMA: &str = "re.native-bytecode-artifact@0.1.0";
pub const NATIVE_BYTECODE_PROFILE: &str = "re.native-bytecode@0.1.0";
pub const NATIVE_BYTECODE_RELEASE: &str = "re.native-bytecode-release@0.1.0";
pub const NATIVE_BYTECODE_TRANSLATOR: &str = "re.native-bytecode-translator@0.1.0";
const HEADER: &str = "re 0.1 bytecode";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BytecodeLiteral {
    pub uid: String,
    pub type_name: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BytecodeArgument {
    pub name: String,
    pub literal: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BytecodeInstruction {
    InvokeCapability {
        destination: u16,
        instance: String,
        member: String,
        invocation_id: String,
        arguments: Vec<BytecodeArgument>,
    },
    BranchResult {
        source: u16,
        ok: usize,
        err: usize,
    },
    ReturnStatus {
        code_literal: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BytecodeArtifact {
    pub schema: String,
    pub profile: String,
    pub release: String,
    pub translator: String,
    pub graph_revision: String,
    pub canonical_graph_sha256: String,
    pub literals: Vec<BytecodeLiteral>,
    pub instructions: Vec<BytecodeInstruction>,
    pub artifact_digest: String,
}

pub fn translate_graph(graph: &Graph) -> Result<BytecodeArtifact, GraphError> {
    validate_graph_shape(graph)?;
    let checked = check_graph(graph.clone())?;
    let revision = graph_revision(&checked)?;
    translate_checked(&checked, &revision)
}

pub fn bytecode_artifact_digest(artifact: &BytecodeArtifact) -> Result<String, GraphError> {
    Ok(format!(
        "sha256:{}",
        sha256_hex(serialize_without_digest(artifact)?.as_bytes())
    ))
}

pub fn serialize_bytecode_artifact(artifact: &BytecodeArtifact) -> Result<String, GraphError> {
    validate_artifact_shape(artifact)?;
    let expected = bytecode_artifact_digest(artifact)?;
    if artifact.artifact_digest != expected {
        return Err(GraphError::new("bytecode-artifact-digest-mismatch"));
    }
    let mut lines = serialize_without_digest(artifact)?.trim_end().to_owned();
    lines.push_str(&format!("\nartifact_digest {}", artifact.artifact_digest));
    lines.push('\n');
    Ok(lines)
}

pub fn load_bytecode_artifact(source: &str) -> Result<BytecodeArtifact, GraphError> {
    if !source.starts_with(&format!("{HEADER}\n")) {
        return Err(GraphError::new("bytecode-header-invalid"));
    }
    if !source.ends_with('\n') {
        return Err(GraphError::new("bytecode-trailing-newline-missing"));
    }
    let lines = source
        .trim_end_matches('\n')
        .split('\n')
        .collect::<Vec<_>>();
    let mut index = 1usize;
    let schema = take_value(&lines, &mut index, "schema")?;
    let profile = take_value(&lines, &mut index, "profile")?;
    let release = take_value(&lines, &mut index, "release")?;
    let translator = take_value(&lines, &mut index, "translator")?;
    let graph_revision = take_value(&lines, &mut index, "graph_revision")?;
    let canonical_graph_sha256 = take_value(&lines, &mut index, "canonical_graph_sha256")?;
    let literal_count = take_count(&lines, &mut index, "literal_count")?;
    let mut literals = Vec::with_capacity(literal_count);
    for expected_index in 0..literal_count {
        let tokens = line_tokens(next_line(&lines, &mut index)?)?;
        if tokens.len() != 5 || tokens[0] != "literal" {
            return Err(GraphError::new("bytecode-literal-shape-invalid"));
        }
        if parse_usize(&tokens[1])? != expected_index {
            return Err(GraphError::new("bytecode-literal-order-invalid"));
        }
        let value = decode_json_string(&tokens[4])
            .ok_or_else(|| GraphError::new("bytecode-literal-value-invalid"))?;
        literals.push(BytecodeLiteral {
            uid: tokens[2].clone(),
            type_name: tokens[3].clone(),
            value,
        });
    }
    let instruction_count = take_count(&lines, &mut index, "instruction_count")?;
    let mut instructions = Vec::with_capacity(instruction_count);
    for expected_index in 0..instruction_count {
        let tokens = line_tokens(next_line(&lines, &mut index)?)?;
        instructions.push(parse_instruction(&tokens, expected_index)?);
    }
    let artifact_digest = take_value(&lines, &mut index, "artifact_digest")?;
    if index != lines.len() {
        return Err(GraphError::new("bytecode-extra-line"));
    }
    let artifact = BytecodeArtifact {
        schema,
        profile,
        release,
        translator,
        graph_revision,
        canonical_graph_sha256,
        literals,
        instructions,
        artifact_digest,
    };
    validate_artifact_shape(&artifact)?;
    let expected = bytecode_artifact_digest(&artifact)?;
    if artifact.artifact_digest != expected {
        return Err(GraphError::new("bytecode-artifact-digest-mismatch"));
    }
    if serialize_bytecode_artifact(&artifact)? != source {
        return Err(GraphError::new("bytecode-non-canonical-source"));
    }
    Ok(artifact)
}

pub fn verify_bytecode_artifact(
    checked_graph: &Graph,
    source: &str,
) -> Result<BytecodeArtifact, GraphError> {
    let artifact = load_bytecode_artifact(source)?;
    let checked = check_graph(checked_graph.clone())?;
    let revision = graph_revision(&checked)?;
    if artifact.graph_revision != revision || artifact.canonical_graph_sha256 != revision {
        return Err(GraphError::new("bytecode-graph-revision-mismatch"));
    }
    let expected = translate_checked(&checked, &revision)?;
    if artifact != expected {
        return Err(GraphError::new("bytecode-graph-artifact-mismatch"));
    }
    Ok(artifact)
}

fn translate_checked(graph: &Graph, revision: &str) -> Result<BytecodeArtifact, GraphError> {
    validate_graph_shape(graph)?;
    let function = &graph.functions[0];
    let (let_uid, invocation) = match &function.statements[0] {
        Statement::Let { uid, value, .. } => (uid.clone(), value),
        _ => return Err(GraphError::new("bytecode-statement-shape-unsupported")),
    };
    let returned = match &function.statements[1] {
        Statement::Return { value, .. } => value,
        _ => return Err(GraphError::new("bytecode-statement-shape-unsupported")),
    };
    if returned.input_producer != let_uid {
        return Err(GraphError::new("bytecode-control-shape-unsupported"));
    }
    let capability = match &invocation.target {
        Target::CapabilityMember {
            instance, member, ..
        } => (instance.clone(), member.clone()),
        Target::PureOperation { .. } => {
            return Err(GraphError::new("bytecode-capability-call-required"));
        }
    };
    let mut branches = BTreeMap::new();
    for branch in &returned.branches {
        if branches
            .insert(branch.variant.clone(), &branch.value)
            .is_some()
        {
            return Err(GraphError::new("bytecode-control-shape-unsupported"));
        }
    }
    let ok = branches
        .remove("ok")
        .ok_or_else(|| GraphError::new("bytecode-control-shape-unsupported"))?;
    let err = branches
        .remove("err")
        .ok_or_else(|| GraphError::new("bytecode-control-shape-unsupported"))?;
    if !branches.is_empty() {
        return Err(GraphError::new("bytecode-control-shape-unsupported"));
    }
    let mut literals = function
        .literals
        .iter()
        .map(|literal| BytecodeLiteral {
            uid: literal.uid.clone(),
            type_name: literal.type_name.clone(),
            value: literal.value.clone(),
        })
        .collect::<Vec<_>>();
    literals.sort_by(|left, right| left.uid.as_bytes().cmp(right.uid.as_bytes()));
    let literal_index = literals
        .iter()
        .enumerate()
        .map(|(index, literal)| (literal.uid.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    let invocation_arguments = compile_arguments(invocation, &literal_index)?;
    let ok_literal = process_status_literal(ok)?;
    let err_literal = process_status_literal(err)?;
    let instructions = vec![
        BytecodeInstruction::InvokeCapability {
            destination: 0,
            instance: capability.0,
            member: capability.1,
            invocation_id: invocation.uid.clone(),
            arguments: invocation_arguments,
        },
        BytecodeInstruction::BranchResult {
            source: 0,
            ok: 2,
            err: 3,
        },
        BytecodeInstruction::ReturnStatus {
            code_literal: literal_index
                .get(ok_literal)
                .copied()
                .ok_or_else(|| GraphError::new("bytecode-literal-missing"))?,
        },
        BytecodeInstruction::ReturnStatus {
            code_literal: literal_index
                .get(err_literal)
                .copied()
                .ok_or_else(|| GraphError::new("bytecode-literal-missing"))?,
        },
    ];
    let mut artifact = BytecodeArtifact {
        schema: NATIVE_BYTECODE_SCHEMA.to_owned(),
        profile: NATIVE_BYTECODE_PROFILE.to_owned(),
        release: NATIVE_BYTECODE_RELEASE.to_owned(),
        translator: NATIVE_BYTECODE_TRANSLATOR.to_owned(),
        graph_revision: revision.to_owned(),
        canonical_graph_sha256: revision.to_owned(),
        literals,
        instructions,
        artifact_digest: String::new(),
    };
    artifact.artifact_digest = bytecode_artifact_digest(&artifact)?;
    validate_artifact_shape(&artifact)?;
    Ok(artifact)
}

fn validate_graph_shape(graph: &Graph) -> Result<(), GraphError> {
    if graph.functions.len() != 1 || graph.functions[0].name != "@main" {
        return Err(GraphError::new("bytecode-function-shape-unsupported"));
    }
    if graph.functions[0].statements.len() != 2 {
        return Err(GraphError::new("bytecode-statement-shape-unsupported"));
    }
    Ok(())
}

fn compile_arguments(
    call: &Call,
    literal_index: &BTreeMap<&str, usize>,
) -> Result<Vec<BytecodeArgument>, GraphError> {
    let mut arguments = call.arguments.clone();
    arguments.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    arguments
        .into_iter()
        .map(|argument: Argument| {
            Ok(BytecodeArgument {
                name: argument.name,
                literal: literal_index
                    .get(argument.endpoint.as_str())
                    .copied()
                    .ok_or_else(|| GraphError::new("bytecode-literal-missing"))?,
            })
        })
        .collect()
}

fn process_status_literal(call: &Call) -> Result<&str, GraphError> {
    match &call.target {
        Target::PureOperation {
            operation,
            schema_reference,
            ..
        } if operation == "process.exit" && schema_reference == "process.exit@0.1.0" => {}
        _ => return Err(GraphError::new("bytecode-process-status-required")),
    }
    let argument = call
        .arguments
        .iter()
        .find(|argument| argument.name == "code")
        .ok_or_else(|| GraphError::new("bytecode-process-status-required"))?;
    Ok(argument.endpoint.as_str())
}

fn serialize_without_digest(artifact: &BytecodeArtifact) -> Result<String, GraphError> {
    validate_artifact_shape(artifact)?;
    let mut lines = vec![
        HEADER.to_owned(),
        format!("schema {}", artifact.schema),
        format!("profile {}", artifact.profile),
        format!("release {}", artifact.release),
        format!("translator {}", artifact.translator),
        format!("graph_revision {}", artifact.graph_revision),
        format!("canonical_graph_sha256 {}", artifact.canonical_graph_sha256),
        format!("literal_count {}", artifact.literals.len()),
    ];
    for (index, literal) in artifact.literals.iter().enumerate() {
        lines.push(format!(
            "literal {index} {} {} {}",
            literal.uid,
            literal.type_name,
            quote(&literal.value)
        ));
    }
    lines.push(format!("instruction_count {}", artifact.instructions.len()));
    for (index, instruction) in artifact.instructions.iter().enumerate() {
        match instruction {
            BytecodeInstruction::InvokeCapability {
                destination,
                instance,
                member,
                invocation_id,
                arguments,
            } => {
                let args = arguments
                    .iter()
                    .map(|argument| format!("{}:{}", argument.name, argument.literal))
                    .collect::<Vec<_>>()
                    .join(",");
                lines.push(format!(
                    "instruction {index} invoke-capability destination={destination} instance={} member={} invocation_id={} arguments={args}",
                    quote(instance),
                    quote(member),
                    quote(invocation_id),
                ));
            }
            BytecodeInstruction::BranchResult { source, ok, err } => {
                lines.push(format!(
                    "instruction {index} branch-result source={source} ok={ok} err={err}"
                ));
            }
            BytecodeInstruction::ReturnStatus { code_literal } => {
                lines.push(format!(
                    "instruction {index} return-status code_literal={code_literal}"
                ));
            }
        }
    }
    Ok(format!("{}\n", lines.join("\n")))
}

fn validate_artifact_shape(artifact: &BytecodeArtifact) -> Result<(), GraphError> {
    if artifact.schema != NATIVE_BYTECODE_SCHEMA {
        return Err(GraphError::new("bytecode-schema-mismatch"));
    }
    if artifact.profile != NATIVE_BYTECODE_PROFILE {
        return Err(GraphError::new("bytecode-profile-mismatch"));
    }
    if artifact.release != NATIVE_BYTECODE_RELEASE {
        return Err(GraphError::new("bytecode-release-mismatch"));
    }
    if artifact.translator != NATIVE_BYTECODE_TRANSLATOR {
        return Err(GraphError::new("bytecode-translator-mismatch"));
    }
    if !valid_digest(&artifact.graph_revision)
        || artifact.canonical_graph_sha256 != artifact.graph_revision
    {
        return Err(GraphError::new("bytecode-graph-revision-invalid"));
    }
    if artifact.literals.is_empty() || artifact.instructions.len() != 4 {
        return Err(GraphError::new("bytecode-shape-unsupported"));
    }
    let mut previous = None;
    for literal in &artifact.literals {
        if !valid_uid(&literal.uid)
            || !valid_literal_type(&literal.type_name, &literal.value)
            || previous.is_some_and(|value: &str| value.as_bytes() >= literal.uid.as_bytes())
        {
            return Err(if !valid_literal_type(&literal.type_name, &literal.value) {
                GraphError::new("bytecode-literal-type-invalid")
            } else {
                GraphError::new("bytecode-literal-shape-invalid")
            });
        }
        previous = Some(literal.uid.as_str());
    }
    if !matches!(
        artifact.instructions.as_slice(),
        [
            BytecodeInstruction::InvokeCapability { .. },
            BytecodeInstruction::BranchResult { .. },
            BytecodeInstruction::ReturnStatus { .. },
            BytecodeInstruction::ReturnStatus { .. }
        ]
    ) {
        return Err(GraphError::new("bytecode-opcode-invalid"));
    }
    match &artifact.instructions[0] {
        BytecodeInstruction::InvokeCapability {
            destination,
            instance,
            member,
            invocation_id,
            arguments,
        } if *destination == 0
            && instance.starts_with('@')
            && !member.is_empty()
            && valid_uid(invocation_id)
            && arguments_valid(arguments, &artifact.literals) => {}
        BytecodeInstruction::InvokeCapability { destination, .. } if *destination != 0 => {
            return Err(GraphError::new("bytecode-register-invalid"));
        }
        _ => return Err(GraphError::new("bytecode-opcode-invalid")),
    }
    match artifact.instructions[1] {
        BytecodeInstruction::BranchResult { source, .. } if source != 0 => {
            return Err(GraphError::new("bytecode-register-invalid"));
        }
        BytecodeInstruction::BranchResult { ok, err, .. } if ok != 2 || err != 3 => {
            return Err(GraphError::new("bytecode-jump-invalid"));
        }
        BytecodeInstruction::BranchResult { .. } => {}
        _ => return Err(GraphError::new("bytecode-opcode-invalid")),
    }
    for instruction in &artifact.instructions[2..] {
        let BytecodeInstruction::ReturnStatus { code_literal } = instruction else {
            return Err(GraphError::new("bytecode-opcode-invalid"));
        };
        if *code_literal >= artifact.literals.len()
            || artifact.literals[*code_literal].type_name != "int"
            || !process_status_value(&artifact.literals[*code_literal].value)
        {
            return Err(GraphError::new("bytecode-literal-type-invalid"));
        }
    }
    Ok(())
}

fn arguments_valid(arguments: &[BytecodeArgument], literals: &[BytecodeLiteral]) -> bool {
    let mut previous = None;
    arguments.iter().all(|argument| {
        let ordered =
            previous.is_none_or(|value: &str| value.as_bytes() < argument.name.as_bytes());
        let valid = !argument.name.is_empty() && argument.literal < literals.len();
        previous = Some(argument.name.as_str());
        ordered && valid
    })
}

fn valid_literal_type(type_name: &str, value: &str) -> bool {
    match type_name {
        "text.utf8" | "fs.path" => true,
        "text.encoding" => value == "text.encoding.utf8",
        "bytes" => is_bytes(value),
        "int" => is_integer(value),
        _ => false,
    }
}

fn process_status_value(value: &str) -> bool {
    let Some(parsed) = value.parse::<i64>().ok() else {
        return false;
    };
    (0..=255).contains(&parsed)
}

fn is_integer(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && !(digits.len() > 1 && digits.starts_with('0'))
        && value != "-0"
}

fn is_bytes(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("hex:") else {
        return false;
    };
    !hex.is_empty()
        && hex.len() % 2 == 0
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn parse_instruction(
    tokens: &[String],
    expected_index: usize,
) -> Result<BytecodeInstruction, GraphError> {
    if tokens.len() < 3 || tokens[0] != "instruction" || parse_usize(&tokens[1])? != expected_index
    {
        return Err(GraphError::new("bytecode-instruction-shape-invalid"));
    }
    match tokens[2].as_str() {
        "invoke-capability" if tokens.len() == 8 => Ok(BytecodeInstruction::InvokeCapability {
            destination: parse_field_u16(&tokens[3], "destination")?,
            instance: parse_field_quoted(&tokens[4], "instance")?,
            member: parse_field_quoted(&tokens[5], "member")?,
            invocation_id: parse_field_quoted(&tokens[6], "invocation_id")?,
            arguments: parse_arguments(&tokens[7])?,
        }),
        "branch-result" if tokens.len() == 6 => Ok(BytecodeInstruction::BranchResult {
            source: parse_field_u16(&tokens[3], "source")?,
            ok: parse_field_usize(&tokens[4], "ok")?,
            err: parse_field_usize(&tokens[5], "err")?,
        }),
        "return-status" if tokens.len() == 4 => Ok(BytecodeInstruction::ReturnStatus {
            code_literal: parse_field_usize(&tokens[3], "code_literal")?,
        }),
        "invoke-unknown" => Err(GraphError::new("bytecode-opcode-invalid")),
        _ => Err(GraphError::new("bytecode-opcode-invalid")),
    }
}

fn parse_arguments(token: &str) -> Result<Vec<BytecodeArgument>, GraphError> {
    let value = token
        .strip_prefix("arguments=")
        .ok_or_else(|| GraphError::new("bytecode-argument-shape-invalid"))?;
    if value.is_empty() {
        return Ok(Vec::new());
    }
    value
        .split(',')
        .map(|entry| {
            let (name, literal) = entry
                .split_once(':')
                .ok_or_else(|| GraphError::new("bytecode-argument-shape-invalid"))?;
            Ok(BytecodeArgument {
                name: name.to_owned(),
                literal: parse_usize(literal)?,
            })
        })
        .collect()
}

fn line_tokens(line: &str) -> Result<Vec<String>, GraphError> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in line.chars() {
        if quoted {
            current.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
        } else if character == '"' {
            quoted = true;
            current.push(character);
        } else if character.is_ascii_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if quoted {
        return Err(GraphError::new("bytecode-quoted-value-invalid"));
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Ok(tokens)
}

fn take_value(lines: &[&str], index: &mut usize, field: &str) -> Result<String, GraphError> {
    let line = next_line(lines, index)?;
    line.strip_prefix(&format!("{field} "))
        .map(ToOwned::to_owned)
        .ok_or_else(|| GraphError::new("bytecode-field-order-invalid"))
}

fn take_count(lines: &[&str], index: &mut usize, field: &str) -> Result<usize, GraphError> {
    parse_usize(&take_value(lines, index, field)?)
}

fn next_line<'a>(lines: &'a [&str], index: &mut usize) -> Result<&'a str, GraphError> {
    let line = lines
        .get(*index)
        .copied()
        .ok_or_else(|| GraphError::new("bytecode-truncated"))?;
    *index += 1;
    Ok(line)
}

fn parse_field_quoted(token: &str, field: &str) -> Result<String, GraphError> {
    let value = token
        .strip_prefix(&format!("{field}="))
        .ok_or_else(|| GraphError::new("bytecode-field-invalid"))?;
    decode_json_string(value).ok_or_else(|| GraphError::new("bytecode-quoted-value-invalid"))
}

fn parse_field_usize(token: &str, field: &str) -> Result<usize, GraphError> {
    parse_usize(
        token
            .strip_prefix(&format!("{field}="))
            .ok_or_else(|| GraphError::new("bytecode-field-invalid"))?,
    )
}

fn parse_field_u16(token: &str, field: &str) -> Result<u16, GraphError> {
    parse_field_usize(token, field)?
        .try_into()
        .map_err(|_| GraphError::new("bytecode-register-invalid"))
}

fn parse_usize(value: &str) -> Result<usize, GraphError> {
    value
        .parse()
        .map_err(|_| GraphError::new("bytecode-number-invalid"))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_uid(value: &str) -> bool {
    value.len() == 26
        && value
            .bytes()
            .all(|byte| b"abcdefghijklmnopqrstuvwxyz234567".contains(&byte))
}
