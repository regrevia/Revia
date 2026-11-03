//! The check-time half of the host schema registry.
//!
//! A registry artifact is a JSON document that carries host schema
//! definitions in the shape `src/host/schema-registry.js` already validates
//! and `src/host/demo-schema.js` already ships:
//!
//! ```json
//! {
//!   "schema": "revia.host-schema-definitions@0.1.0",
//!   "definitions": [
//!     {
//!       "identity": "echo",
//!       "revision": "0.1.0",
//!       "members": {"say": {"params": [{"name": "text", "type": "text.utf8"}]}}
//!     }
//!   ]
//! }
//! ```
//!
//! This module projects that document onto
//! [`DeclaredSchema`](crate::graph::DeclaredSchema): the reference is
//! `identity@revision`, each member keeps only its name and its positional
//! argument names and types. Everything else a real definition carries
//! (`types`, `access`, `returns`, `resource_catalog`, parameter `default` and
//! `primary` flags) is deliberately ignored here, so an out-of-tree library
//! definition can be loaded without being rewritten for this reader. Those
//! fields are read by later slices, not this one.
//!
//! The registry only widens the check-time gates. A graph admitted here still
//! fails closed at the runtime host boundary until the four runtime sites
//! learn about the declaration; see `create_graph` sources for that split.

use crate::{
    canonical_json::{JsonValue, canonicalize},
    graph::{DeclaredMember, DeclaredSchema, GraphError, validate_declarations},
    project::parse_json,
};

/// Artifact schema identifier written into and required from a registry file.
pub const REGISTRY_SCHEMA: &str = "revia.host-schema-definitions@0.1.0";

const INVALID: &str = "declared-schema-registry-invalid";

/// Reads a registry artifact into check-time declarations.
///
/// The document must be an object with this module's `schema` identifier and a
/// `definitions` array. Definition objects must carry a non-empty `identity`,
/// a non-empty `revision` and a non-empty `members` object; each member must
/// carry `params`, an array of objects with string `name` and `type` fields.
/// Additional definition, member and parameter fields are ignored. The result
/// is validated exactly as `check_graph_with_declared_schemas` validates
/// programmatic declarations, so duplicate references, members, parameters and
/// built-in shadowing are rejected here as `declared-schema-invalid`.
pub fn parse_registry(source: &str) -> Result<Vec<DeclaredSchema>, GraphError> {
    let value = parse_json(source).map_err(|_| invalid("json"))?;
    let registry = object(&value, "registry")?;
    reject_unknown_keys(registry, &["definitions", "schema"], "registry")?;
    if string_field(registry, "schema", "registry")? != REGISTRY_SCHEMA {
        return Err(invalid("schema"));
    }
    let definitions = field(registry, "definitions", "registry")?;
    let definitions = match definitions {
        JsonValue::Array(items) => items,
        _ => return Err(invalid("definitions")),
    };
    let mut declared = Vec::with_capacity(definitions.len());
    for (index, definition) in definitions.iter().enumerate() {
        declared.push(parse_definition(definition, index)?);
    }
    validate_declarations(&declared)?;
    Ok(declared)
}

/// Renders check-time declarations back into a canonical registry artifact.
///
/// The output is byte-stable for the same declarations (object keys are
/// sorted, members keep their order) and `parse_registry` reads it back to the
/// same value.
pub fn render_registry(declared: &[DeclaredSchema]) -> Result<String, GraphError> {
    let mut definitions = Vec::with_capacity(declared.len());
    for schema in declared {
        definitions.push(render_definition(schema)?);
    }
    Ok(canonicalize(&JsonValue::Object(vec![
        ("definitions".to_owned(), JsonValue::Array(definitions)),
        (
            "schema".to_owned(),
            JsonValue::String(REGISTRY_SCHEMA.to_owned()),
        ),
    ])))
}

fn parse_definition(value: &JsonValue, index: usize) -> Result<DeclaredSchema, GraphError> {
    let path = format!("definitions[{index}]");
    let definition = object(value, &path)?;
    let identity = string_field(definition, "identity", &path)?;
    let revision = string_field(definition, "revision", &path)?;
    if identity.contains('@') || identity.chars().any(char::is_whitespace) {
        return Err(invalid(&format!("{path}.identity")));
    }
    if revision.contains('@') || revision.chars().any(char::is_whitespace) {
        return Err(invalid(&format!("{path}.revision")));
    }
    let members = object(
        field(definition, "members", &path)?,
        &format!("{path}.members"),
    )?;
    if members.is_empty() {
        return Err(invalid(&format!("{path}.members")));
    }
    let mut declared_members = Vec::with_capacity(members.len());
    for (name, member) in members {
        declared_members.push(DeclaredMember {
            name: name.clone(),
            parameters: parse_parameters(member, &format!("{path}.members.{name}"))?,
        });
    }
    Ok(DeclaredSchema {
        reference: format!("{identity}@{revision}"),
        members: declared_members,
    })
}

fn parse_parameters(member: &JsonValue, path: &str) -> Result<Vec<(String, String)>, GraphError> {
    let member = object(member, path)?;
    let parameters = field(member, "params", path)?;
    let parameters = match parameters {
        JsonValue::Array(items) => items,
        _ => return Err(invalid(&format!("{path}.params"))),
    };
    let mut parsed = Vec::with_capacity(parameters.len());
    for (index, parameter) in parameters.iter().enumerate() {
        let parameter_path = format!("{path}.params[{index}]");
        let parameter = object(parameter, &parameter_path)?;
        parsed.push((
            string_field(parameter, "name", &parameter_path)?.to_owned(),
            string_field(parameter, "type", &parameter_path)?.to_owned(),
        ));
    }
    Ok(parsed)
}

fn render_definition(schema: &DeclaredSchema) -> Result<JsonValue, GraphError> {
    let Some((identity, revision)) = schema.reference.rsplit_once('@') else {
        return Err(invalid(&schema.reference));
    };
    let mut members = Vec::with_capacity(schema.members.len());
    for member in &schema.members {
        let parameters = member
            .parameters
            .iter()
            .map(|(name, type_name)| {
                JsonValue::Object(vec![
                    ("name".to_owned(), JsonValue::String(name.clone())),
                    ("type".to_owned(), JsonValue::String(type_name.clone())),
                ])
            })
            .collect();
        members.push((
            member.name.clone(),
            JsonValue::Object(vec![("params".to_owned(), JsonValue::Array(parameters))]),
        ));
    }
    Ok(JsonValue::Object(vec![
        (
            "identity".to_owned(),
            JsonValue::String(identity.to_owned()),
        ),
        ("members".to_owned(), JsonValue::Object(members)),
        (
            "revision".to_owned(),
            JsonValue::String(revision.to_owned()),
        ),
    ]))
}

fn object<'a>(value: &'a JsonValue, path: &str) -> Result<&'a [(String, JsonValue)], GraphError> {
    match value {
        JsonValue::Object(entries) => {
            let mut seen = std::collections::BTreeSet::new();
            for (key, _) in entries {
                if !seen.insert(key.as_str()) {
                    return Err(invalid(&format!("{path}.{key}")));
                }
            }
            Ok(entries)
        }
        _ => Err(invalid(path)),
    }
}

fn reject_unknown_keys(
    entries: &[(String, JsonValue)],
    known: &[&str],
    path: &str,
) -> Result<(), GraphError> {
    for (key, _) in entries {
        if !known.contains(&key.as_str()) {
            return Err(invalid(&format!("{path}.{key}")));
        }
    }
    Ok(())
}

fn field<'a>(
    entries: &'a [(String, JsonValue)],
    name: &str,
    path: &str,
) -> Result<&'a JsonValue, GraphError> {
    entries
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
        .ok_or_else(|| invalid(&format!("{path}.{name}")))
}

fn string_field<'a>(
    entries: &'a [(String, JsonValue)],
    name: &str,
    path: &str,
) -> Result<&'a str, GraphError> {
    match field(entries, name, path)? {
        JsonValue::String(value) if !value.is_empty() => Ok(value),
        _ => Err(invalid(&format!("{path}.{name}"))),
    }
}

fn invalid(path: &str) -> GraphError {
    GraphError::new(INVALID).with_actual(path.to_owned())
}
