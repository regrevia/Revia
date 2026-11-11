use std::{
    collections::BTreeSet,
    process::{Command, Output},
};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

fn legend_codes(help: &str) -> BTreeSet<u32> {
    let mut codes = BTreeSet::new();
    let mut in_legend = false;
    for line in help.lines() {
        if line.starts_with("Exit codes:") {
            in_legend = true;
            continue;
        }
        if !in_legend {
            continue;
        }
        let mut parts = line.trim_start().splitn(2, ' ');
        let (Some(number), Some(rest)) = (parts.next(), parts.next()) else {
            continue;
        };
        if rest.trim().is_empty() {
            continue;
        }
        if let Ok(code) = number.parse::<u32>() {
            codes.insert(code);
        }
    }
    codes
}

fn listed_commands(help: &str) -> Vec<String> {
    let mut commands = Vec::new();
    for line in help.lines() {
        if line.starts_with("Exit codes:") {
            break;
        }
        let Some(rest) = line.strip_prefix("  ") else {
            continue;
        };
        let Some((token, tail)) = rest.split_once(' ') else {
            continue;
        };
        if token == "revia" || tail.trim().is_empty() || token.parse::<u32>().is_ok() {
            continue;
        }
        if !token
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            continue;
        }
        commands.push(token.to_string());
    }
    commands
}

fn referenced_codes(text: &str) -> BTreeSet<u32> {
    let mut codes = BTreeSet::new();
    let bytes = text.as_bytes();
    let needle = b"exit ";
    let mut index = 0;
    while let Some(offset) = text[index..].find("exit ") {
        let start = index + offset + needle.len();
        let digits: String = text[start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(code) = digits.parse::<u32>() {
            codes.insert(code);
        }
        index = start;
        if index >= bytes.len() {
            break;
        }
    }
    codes
}

#[test]
fn native_command_help_only_names_exit_codes_the_legend_explains() {
    let top_level = run(&["--help"]);
    assert_eq!(top_level.status.code(), Some(0));
    let help_text = String::from_utf8_lossy(&top_level.stdout).into_owned();

    let legend = legend_codes(&help_text);
    assert!(legend.contains(&0), "the legend lost the success code");
    assert!(
        legend.len() >= 5,
        "the legend shrank to {} codes",
        legend.len()
    );

    let commands = listed_commands(&help_text);
    let unique: BTreeSet<&String> = commands.iter().collect();
    assert_eq!(
        commands.len(),
        unique.len(),
        "the top-level help lists a command twice"
    );
    assert!(
        commands.len() >= 50,
        "the top-level help lists only {} commands",
        commands.len()
    );

    for command in &commands {
        let page = run(&["help", command]);
        assert_eq!(
            page.status.code(),
            Some(0),
            "`help {command}` does not exist although `--help` lists it"
        );
        let page_text = String::from_utf8_lossy(&page.stdout).into_owned();
        assert!(
            page_text.contains(command.as_str()),
            "the help page for {command} never names the command"
        );
        for code in referenced_codes(&page_text) {
            assert!(
                legend.contains(&code),
                "`help {command}` documents exit code {code}, which the legend does not list"
            );
        }
    }
}
