use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Barrier,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};

use revia_core::approval::{ApprovalAuthorityStore, ApprovalRecord, ApprovalState};

static COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn approval_consumption_is_persistent_and_one_time() {
    let state_dir = temp_dir("consume");
    let record = ApprovalRecord::new(
        "approval-1",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "operator",
        "execution-1",
    );
    let store = ApprovalAuthorityStore::open(&state_dir).unwrap();
    store.approve(&record).unwrap();
    let reserved = store.consume("approval-1").unwrap();
    assert_eq!(reserved.state, ApprovalState::Reserved);
    assert!(state_dir.join(".approval-1.reserved").is_file());
    assert_eq!(
        store.consume("approval-1").unwrap_err(),
        "approval-already-consumed"
    );
    drop(store);

    let reopened = ApprovalAuthorityStore::open(&state_dir).unwrap();
    assert_eq!(
        reopened.state("approval-1").unwrap(),
        ApprovalState::Reserved
    );
    assert_eq!(
        reopened.consume("approval-1").unwrap_err(),
        "approval-already-consumed"
    );
    reopened
        .finish("approval-1", ApprovalState::Succeeded)
        .unwrap();
    assert_eq!(
        reopened.consume("approval-1").unwrap_err(),
        "approval-already-consumed"
    );
    fs::remove_dir_all(state_dir).unwrap();
}

#[test]
fn unknown_result_is_terminal_and_cannot_be_replayed() {
    let state_dir = temp_dir("unknown");
    let store = ApprovalAuthorityStore::open(&state_dir).unwrap();
    store
        .approve(&ApprovalRecord::new(
            "approval-2",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "operator",
            "execution-2",
        ))
        .unwrap();
    store.consume("approval-2").unwrap();
    store.finish("approval-2", ApprovalState::Unknown).unwrap();
    assert_eq!(store.state("approval-2").unwrap(), ApprovalState::Unknown);
    assert_eq!(
        store.consume("approval-2").unwrap_err(),
        "approval-already-consumed"
    );
    fs::remove_dir_all(state_dir).unwrap();
}

#[test]
fn concurrent_consumers_receive_exactly_one_reservation() {
    let state_dir = temp_dir("concurrent");
    let store = ApprovalAuthorityStore::open(&state_dir).unwrap();
    store
        .approve(&ApprovalRecord::new(
            "approval-race",
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "operator",
            "execution-race",
        ))
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let workers = (0..2)
        .map(|_| {
            let path = state_dir.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let store = ApprovalAuthorityStore::open(path).unwrap();
                barrier.wait();
                store.consume("approval-race")
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let successes = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .filter(Result::is_ok)
        .count();
    assert_eq!(successes, 1);
    fs::remove_dir_all(state_dir).unwrap();
}

#[test]
fn missing_or_extra_approval_evidence_is_not_coerced_to_a_valid_state() {
    let state_dir = temp_dir("missing-evidence");
    let store = ApprovalAuthorityStore::open(&state_dir).unwrap();
    store
        .approve(&ApprovalRecord::new(
            "approval-missing",
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "operator",
            "execution-missing",
        ))
        .unwrap();
    let record = state_dir.join("approval-missing.json");
    fs::write(
        &record,
        "{\"approval_id\":\"approval-missing\",\"approver_id\":\"operator\",\"bundle_digest\":\"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"execution_id\":\"execution-missing\",\"schema\":\"re.native-task-approval@0.1.0\",\"state_revision\":0}\n",
    )
    .unwrap();
    assert_eq!(
        store.state("approval-missing").unwrap_err(),
        "approval-record-field-invalid"
    );

    fs::write(
        &record,
        "{\"approval_id\":\"approval-missing\",\"approver_id\":\"operator\",\"bundle_digest\":\"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"execution_id\":\"execution-missing\",\"schema\":\"re.native-task-approval@0.1.0\",\"state\":\"approved\",\"state_revision\":0,\"unmeasured\":0}\n",
    )
    .unwrap();
    assert_eq!(
        store.state("approval-missing").unwrap_err(),
        "approval-record-noncanonical"
    );
    fs::remove_dir_all(state_dir).unwrap();
}

#[test]
fn execution_id_cannot_authorize_two_distinct_approvals() {
    let state_dir = temp_dir("execution-id");
    let store = ApprovalAuthorityStore::open(&state_dir).unwrap();
    store
        .approve(&ApprovalRecord::new(
            "approval-execution-a",
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "operator",
            "execution-shared",
        ))
        .unwrap();

    assert_eq!(
        store
            .approve(&ApprovalRecord::new(
                "approval-execution-b",
                "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                "operator",
                "execution-shared",
            ))
            .unwrap_err(),
        "approval-execution-id-conflict"
    );
    assert_eq!(
        store.state("approval-execution-b").unwrap_err(),
        "approval-not-found"
    );
    fs::remove_dir_all(state_dir).unwrap();
}

fn temp_dir(label: &str) -> PathBuf {
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "revia-wp313-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}
