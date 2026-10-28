#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

pub fn canonicalize(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null".to_owned(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Number(value) => value.clone(),
        JsonValue::String(value) => quote(value),
        JsonValue::Array(values) => {
            let items = values.iter().map(canonicalize).collect::<Vec<_>>();
            format!("[{}]", items.join(","))
        }
        JsonValue::Object(entries) => {
            let mut sorted = entries.iter().collect::<Vec<_>>();
            sorted.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            let items = sorted
                .into_iter()
                .map(|(key, value)| format!("{}:{}", quote(key), canonicalize(value)))
                .collect::<Vec<_>>();
            format!("{{{}}}", items.join(","))
        }
    }
}

pub fn quote(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            character if character.is_control() => {
                output.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => output.push(character),
        }
    }
    output.push('"');
    output
}
