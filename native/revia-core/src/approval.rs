use std::{
    fs, io,
    path::{Path, PathBuf},
};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    project::parse_json,
};

pub const APPROVAL_SCHEMA: &str = "re.native-task-approval@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApprovalState {
    Approved,
    Reserved,
    Succeeded,
    FailedNoEffect,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalRecord {
    pub schema: String,
    pub approval_id: String,
    pub bundle_digest: String,
    pub approver_id: String,
    pub execution_id: String,
    pub state: ApprovalState,
    pub state_revision: u64,
}

impl ApprovalRecord {
    pub fn new(
        approval_id: &str,
        bundle_digest: &str,
        approver_id: &str,
        execution_id: &str,
    ) -> Self {
        Self {
            schema: APPROVAL_SCHEMA.to_owned(),
            approval_id: approval_id.to_owned(),
            bundle_digest: bundle_digest.to_owned(),
            approver_id: approver_id.to_owned(),
            execution_id: execution_id.to_owned(),
            state: ApprovalState::Approved,
            state_revision: 0,
        }
    }
}

pub struct ApprovalAuthorityStore {
    state_dir: PathBuf,
}

impl ApprovalAuthorityStore {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().to_owned();
        fs::create_dir_all(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self { state_dir: path })
    }

    pub fn approve(&self, record: &ApprovalRecord) -> Result<(), String> {
        if record.schema != APPROVAL_SCHEMA
            || !valid_id(&record.approval_id)
            || record.approver_id.is_empty()
            || !valid_id(&record.execution_id)
            || !valid_digest(&record.bundle_digest)
            || record.state != ApprovalState::Approved
        {
            return Err("approval-record-invalid".to_owned());
        }
        let execution_claim = self.execution_claim_path(&record.execution_id)?;
        let mut claim_options = fs::OpenOptions::new();
        claim_options.write(true).create_new(true);
        let mut claim = claim_options.open(&execution_claim).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                "approval-execution-id-conflict".to_owned()
            } else {
                "approval-state-write-failed".to_owned()
            }
        })?;
        io::Write::write_all(&mut claim, format!("{}\n", record.approval_id).as_bytes())
            .and_then(|_| claim.sync_all())
            .map_err(|_| "approval-state-write-failed".to_owned())?;

        let path = self.path(&record.approval_id)?;
        let bytes = serialize(record);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = options.open(path).map_err(|error| {
            let _ = fs::remove_file(&execution_claim);
            if error.kind() == io::ErrorKind::AlreadyExists {
                "approval-already-exists".to_owned()
            } else {
                "approval-state-write-failed".to_owned()
            }
        })?;
        io::Write::write_all(&mut file, bytes.as_bytes())
            .map_err(|_| "approval-state-write-failed".to_owned())
    }

    pub fn consume(&self, id: &str) -> Result<ApprovalRecord, String> {
        let reservation = self.reservation_path(id)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut marker = options.open(reservation).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                "approval-already-consumed".to_owned()
            } else {
                "approval-state-write-failed".to_owned()
            }
        })?;
        io::Write::write_all(&mut marker, b"reserved\n")
            .and_then(|_| marker.sync_all())
            .map_err(|_| "approval-state-write-failed".to_owned())?;
        let mut record = self.load(id)?;
        if record.state != ApprovalState::Approved {
            return Err("approval-already-consumed".to_owned());
        }
        record.state = ApprovalState::Reserved;
        record.state_revision += 1;
        self.replace(&record)?;
        Ok(record)
    }

    pub fn finish(&self, id: &str, state: ApprovalState) -> Result<(), String> {
        if !matches!(
            state,
            ApprovalState::Succeeded | ApprovalState::FailedNoEffect | ApprovalState::Unknown
        ) {
            return Err("approval-terminal-state-invalid".to_owned());
        }
        let mut record = self.load(id)?;
        if record.state != ApprovalState::Reserved {
            return Err("approval-not-reserved".to_owned());
        }
        record.state = state;
        record.state_revision += 1;
        self.replace(&record)
    }

    pub fn state(&self, id: &str) -> Result<ApprovalState, String> {
        Ok(self.load(id)?.state)
    }

    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("approval-id-invalid".to_owned());
        }
        Ok(self.state_dir.join(format!("{id}.json")))
    }

    fn reservation_path(&self, id: &str) -> Result<PathBuf, String> {
        self.path(id)?;
        Ok(self.state_dir.join(format!(".{id}.reserved")))
    }

    fn execution_claim_path(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("approval-record-invalid".to_owned());
        }
        Ok(self.state_dir.join(format!(".execution-{id}.claim")))
    }

    fn load(&self, id: &str) -> Result<ApprovalRecord, String> {
        let source = fs::read_to_string(self.path(id)?).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                "approval-not-found".to_owned()
            } else {
                "approval-state-read-failed".to_owned()
            }
        })?;
        parse(&source)
    }

    fn replace(&self, record: &ApprovalRecord) -> Result<(), String> {
        let path = self.path(&record.approval_id)?;
        let temporary = self.state_dir.join(format!(".{}.tmp", record.approval_id));
        fs::write(&temporary, serialize(record))
            .map_err(|_| "approval-state-write-failed".to_owned())?;
        fs::rename(temporary, path).map_err(|_| "approval-state-write-failed".to_owned())
    }
}

fn serialize(record: &ApprovalRecord) -> String {
    let state = match record.state {
        ApprovalState::Approved => "approved",
        ApprovalState::Reserved => "reserved",
        ApprovalState::Succeeded => "succeeded",
        ApprovalState::FailedNoEffect => "failed_no_effect",
        ApprovalState::Unknown => "unknown",
    };
    format!(
        "{}\n",
        canonicalize(&JsonValue::Object(vec![
            (
                "approval_id".into(),
                JsonValue::String(record.approval_id.clone())
            ),
            (
                "approver_id".into(),
                JsonValue::String(record.approver_id.clone())
            ),
            (
                "bundle_digest".into(),
                JsonValue::String(record.bundle_digest.clone())
            ),
            (
                "execution_id".into(),
                JsonValue::String(record.execution_id.clone())
            ),
            ("schema".into(), JsonValue::String(record.schema.clone())),
            ("state".into(), JsonValue::String(state.into())),
            (
                "state_revision".into(),
                JsonValue::Number(record.state_revision.to_string())
            )
        ]))
    )
}

fn parse(source: &str) -> Result<ApprovalRecord, String> {
    let JsonValue::Object(entries) =
        parse_json(source).map_err(|_| "approval-record-json-invalid")?
    else {
        return Err("approval-record-json-invalid".to_owned());
    };
    let string = |key: &str| {
        entries
            .iter()
            .find(|(name, _)| name == key)
            .and_then(|(_, value)| {
                if let JsonValue::String(value) = value {
                    Some(value.clone())
                } else {
                    None
                }
            })
            .ok_or_else(|| "approval-record-field-invalid".to_owned())
    };
    let revision = entries
        .iter()
        .find(|(name, _)| name == "state_revision")
        .and_then(|(_, value)| {
            if let JsonValue::Number(value) = value {
                value.parse().ok()
            } else {
                None
            }
        })
        .ok_or_else(|| "approval-record-field-invalid".to_owned())?;
    let state = match string("state")?.as_str() {
        "approved" => ApprovalState::Approved,
        "reserved" => ApprovalState::Reserved,
        "succeeded" => ApprovalState::Succeeded,
        "failed_no_effect" => ApprovalState::FailedNoEffect,
        "unknown" => ApprovalState::Unknown,
        _ => return Err("approval-state-invalid".to_owned()),
    };
    let record = ApprovalRecord {
        schema: string("schema")?,
        approval_id: string("approval_id")?,
        bundle_digest: string("bundle_digest")?,
        approver_id: string("approver_id")?,
        execution_id: string("execution_id")?,
        state,
        state_revision: revision,
    };
    if serialize(&record) != source {
        return Err("approval-record-noncanonical".to_owned());
    }
    Ok(record)
}

fn valid_digest(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .map(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
        .unwrap_or(false)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}
