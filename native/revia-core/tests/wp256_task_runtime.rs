use std::collections::BTreeMap;

use revia_core::{
    bytecode::{serialize_bytecode_artifact, translate_graph},
    graph::{Graph, check_graph, graph_revision, parse_compact_graph},
    task_runtime::{
        CancelAt, CancelReason, EffectRecord, LifecyclePlan, PerformerAuthority, SignalPlan,
        TaskCheckpoint, TaskContract, TaskEffect, TaskError, TaskExecution, TaskLifecycleState,
        TaskPerformInput, TaskPerformer, TaskPerformerFault, TaskPerformerOutcome, TaskRequest,
        TaskRuntimeLimits, TaskValue, TimerPlan, execute_task, task_request_digest,
    },
    vm::{CapabilityBridge, CapabilityResponse, VmLimits, VmRequest, VmValue, execute_bytecode},
};

const HELLO: &str = include_str!("../../../examples/hello.re");
const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn object(entries: &[(&str, TaskValue)]) -> TaskValue {
    TaskValue::Object(
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
    )
}

fn contract() -> TaskContract {
    TaskContract {
        schema: "re.task-contract@0.1.0".to_owned(),
        agent: "agent.expense.intake".to_owned(),
        module: "agent.expense.intake".to_owned(),
        node_uid: "aaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        max_attempts: 3,
        backoff_ms: vec![10, 20],
        retryable_errors: vec!["conflict".to_owned(), "timeout".to_owned()],
        checkpoint_fields: vec![
            "revision".to_owned(),
            "input_digest".to_owned(),
            "cursor".to_owned(),
        ],
    }
}

fn authority() -> PerformerAuthority {
    PerformerAuthority {
        executor: "test.performer@0.1.0".to_owned(),
        graph_revision: DIGEST_A.to_owned(),
        artifact_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .to_owned(),
        profile: "re.native-vm@0.1.0".to_owned(),
    }
}

fn request(authority: PerformerAuthority) -> TaskRequest {
    TaskRequest::new(
        "agent.expense.intake",
        "agent.expense.intake",
        "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        "project-rev-1",
        "expense-001",
        object(&[
            ("amount", TaskValue::Number("1200".to_owned())),
            ("currency", TaskValue::String("CNY".to_owned())),
        ]),
        authority,
    )
}

fn success(effect_key: &str) -> TaskPerformerOutcome {
    TaskPerformerOutcome::Success {
        effect: Some(TaskEffect {
            key: effect_key.to_owned(),
            payload: object(&[("posted", TaskValue::Bool(true))]),
        }),
        output: object(&[("approved", TaskValue::Bool(true))]),
    }
}

struct ScriptedPerformer {
    authority: PerformerAuthority,
    outcomes: Vec<Result<TaskPerformerOutcome, TaskPerformerFault>>,
    calls: Vec<u8>,
    cancellations: Vec<Vec<CancelReason>>,
}

impl ScriptedPerformer {
    fn new(outcomes: Vec<Result<TaskPerformerOutcome, TaskPerformerFault>>) -> Self {
        Self {
            authority: authority(),
            outcomes,
            calls: Vec::new(),
            cancellations: Vec::new(),
        }
    }
}

impl TaskPerformer for ScriptedPerformer {
    fn authority(&self) -> &PerformerAuthority {
        &self.authority
    }

    fn perform(
        &mut self,
        input: TaskPerformInput<'_>,
        lifecycle: &mut TaskLifecycleState,
    ) -> Result<TaskPerformerOutcome, TaskPerformerFault> {
        self.calls.push(input.attempt);
        if let Some(reasons) = self.cancellations.get(input.attempt as usize - 1) {
            for reason in reasons {
                lifecycle.cancel(reason.clone());
            }
        }
        self.outcomes.remove(0)
    }
}

fn retry_error(cursor: u8) -> TaskPerformerOutcome {
    TaskPerformerOutcome::Error {
        checkpoint: object(&[("cursor", TaskValue::Number(cursor.to_string()))]),
        error: TaskError {
            code: "timeout".to_owned(),
            message: "temporary".to_owned(),
        },
    }
}

fn execute(
    performer: &mut dyn TaskPerformer,
    effects: &mut BTreeMap<String, EffectRecord>,
    lifecycle: LifecyclePlan,
    checkpoint: Option<TaskCheckpoint>,
) -> TaskExecution {
    execute_task(
        &contract(),
        &request(performer.authority().clone()),
        checkpoint.as_ref(),
        effects,
        performer,
        lifecycle,
        TaskRuntimeLimits::default(),
    )
}

#[test]
fn native_task_runtime_matches_success_retry_error_and_replay_facts() {
    let mut effects = BTreeMap::new();
    let mut success_performer = ScriptedPerformer::new(vec![Ok(success("success-effect"))]);
    let success_result = execute(
        &mut success_performer,
        &mut effects,
        LifecyclePlan::resource(),
        None,
    );
    assert_eq!(success_result.terminal, "succeeded");
    assert_eq!(success_result.receipt.attempts, 1);
    assert_eq!(success_result.receipt.performer_calls, 1);
    assert_eq!(success_result.receipt.effect_count, 1);
    assert_eq!(
        success_result.receipt.trace_kinds(),
        vec!["attempt-start", "success", "resource-close"]
    );

    let mut retry_effects = BTreeMap::new();
    let mut retry_performer = ScriptedPerformer::new(vec![
        Ok(retry_error(1)),
        Ok(retry_error(2)),
        Ok(success("retry-effect")),
    ]);
    let retry = execute(
        &mut retry_performer,
        &mut retry_effects,
        LifecyclePlan::resource(),
        None,
    );
    assert_eq!(retry.terminal, "succeeded");
    assert_eq!(retry.receipt.attempts, 3);
    assert_eq!(retry_performer.calls, vec![1, 2, 3]);
    assert_eq!(
        retry.receipt.trace_kinds(),
        vec![
            "attempt-start",
            "attempt-error",
            "retry",
            "attempt-start",
            "attempt-error",
            "retry",
            "attempt-start",
            "success",
            "resource-close",
        ]
    );
    assert_eq!(retry.receipt.attempt_backoffs(), vec![0, 10, 20]);

    let mut failed_effects = BTreeMap::new();
    let mut failed_performer = ScriptedPerformer::new(vec![Ok(TaskPerformerOutcome::Error {
        checkpoint: TaskValue::Object(BTreeMap::new()),
        error: TaskError {
            code: "validation".to_owned(),
            message: "permanent".to_owned(),
        },
    })]);
    let failed = execute(
        &mut failed_performer,
        &mut failed_effects,
        LifecyclePlan::resource(),
        None,
    );
    assert_eq!(failed.terminal, "failed");
    assert_eq!(failed.receipt.performer_calls, 1);
    assert_eq!(
        failed.receipt.trace_kinds(),
        vec!["attempt-start", "attempt-error", "resource-close"]
    );

    let replay_request = request(authority());
    let task_id = replay_request.task_id();
    let mut replay_effects = BTreeMap::from([(
        "replay-effect".to_owned(),
        EffectRecord {
            attempt: 2,
            effect_key: "replay-effect".to_owned(),
            output: object(&[("approved", TaskValue::Bool(true))]),
            payload: object(&[("posted", TaskValue::Bool(true))]),
            task_id: task_id.clone(),
        },
    )]);
    let mut replay_performer = ScriptedPerformer::new(vec![Ok(success("must-not-run"))]);
    let replay = execute(
        &mut replay_performer,
        &mut replay_effects,
        LifecyclePlan::resource(),
        None,
    );
    assert_eq!(replay.terminal, "succeeded");
    assert!(replay.receipt.replayed);
    assert_eq!(replay.receipt.performer_calls, 0);
    assert_eq!(
        replay.receipt.trace_kinds(),
        vec!["replay", "resource-close"]
    );
}

#[test]
fn cancellation_is_first_reason_wins_and_late_effects_do_not_commit() {
    let mut before_effects = BTreeMap::new();
    let mut before_performer = ScriptedPerformer::new(vec![Ok(success("must-not-run"))]);
    let before = execute(
        &mut before_performer,
        &mut before_effects,
        LifecyclePlan {
            cancel_at: Some(CancelAt::BeforeStart),
            resource: true,
            ..LifecyclePlan::default()
        },
        None,
    );
    assert_eq!(before.terminal, "cancelled");
    assert_eq!(
        before.receipt.cancel_reason,
        Some(CancelReason::BeforeStart)
    );
    assert_eq!(before.receipt.performer_calls, 0);

    let mut parent_effects = BTreeMap::new();
    let mut parent_performer = ScriptedPerformer::new(vec![Ok(success("must-not-run"))]);
    let parent = execute(
        &mut parent_performer,
        &mut parent_effects,
        LifecyclePlan {
            signal: Some(SignalPlan {
                initially_aborted: true,
                ..SignalPlan::default()
            }),
            resource: true,
            ..LifecyclePlan::default()
        },
        None,
    );
    assert_eq!(parent.terminal, "cancelled");
    assert_eq!(parent.receipt.cancel_reason, Some(CancelReason::Parent));
    assert_eq!(parent.receipt.performer_calls, 0);
    assert_eq!(
        parent.receipt.cleanup_events,
        vec!["signal-remove", "resource-close"]
    );

    let mut timeout_effects = BTreeMap::new();
    let mut timeout_performer = ScriptedPerformer::new(vec![Ok(success("late-effect"))]);
    timeout_performer.cancellations = vec![vec![CancelReason::Timeout]];
    let timeout = execute(
        &mut timeout_performer,
        &mut timeout_effects,
        LifecyclePlan {
            signal: Some(SignalPlan::default()),
            timer: Some(TimerPlan::default()),
            resource: true,
            ..LifecyclePlan::default()
        },
        None,
    );
    assert_eq!(timeout.terminal, "cancelled");
    assert_eq!(timeout.receipt.cancel_reason, Some(CancelReason::Timeout));
    assert!(timeout_effects.is_empty());

    let mut race_effects = BTreeMap::new();
    let mut race_performer = ScriptedPerformer::new(vec![Ok(success("late-effect"))]);
    race_performer.cancellations = vec![vec![CancelReason::Parent, CancelReason::Timeout]];
    let race = execute(
        &mut race_performer,
        &mut race_effects,
        LifecyclePlan {
            signal: Some(SignalPlan::default()),
            timer: Some(TimerPlan::default()),
            resource: true,
            ..LifecyclePlan::default()
        },
        None,
    );
    assert_eq!(race.receipt.cancel_reason, Some(CancelReason::Parent));
    assert!(race_effects.is_empty());
}

#[test]
fn checkpoint_and_effect_authority_fail_closed_before_new_effects() {
    let request = request(authority());
    let stale = TaskCheckpoint {
        attempt: 1,
        data: TaskValue::Object(BTreeMap::new()),
        input_digest: DIGEST_A.to_owned(),
        revision: "stale".to_owned(),
        state: "retrying".to_owned(),
        task_id: DIGEST_A.to_owned(),
    };
    let mut effects = BTreeMap::new();
    let mut performer = ScriptedPerformer::new(vec![Ok(success("must-not-run"))]);
    let rejected = execute_task(
        &contract(),
        &request,
        Some(&stale),
        &mut effects,
        &mut performer,
        LifecyclePlan {
            timer: Some(TimerPlan::default()),
            resource: true,
            ..LifecyclePlan::default()
        },
        TaskRuntimeLimits::default(),
    );
    assert_eq!(rejected.error_code(), Some("stale-task-checkpoint"));
    assert_eq!(rejected.receipt.performer_calls, 0);
    assert_eq!(
        rejected.receipt.cleanup_events,
        vec!["timer-clear", "resource-close"]
    );

    let other_task = TaskRequest::new(
        "agent.expense.intake",
        "agent.expense.intake",
        "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        "project-rev-1",
        "other",
        object(&[("amount", TaskValue::Number("1200".to_owned()))]),
        authority(),
    );
    effects.insert(
        "duplicate".to_owned(),
        EffectRecord {
            attempt: 1,
            effect_key: "duplicate".to_owned(),
            output: TaskValue::Null,
            payload: TaskValue::Null,
            task_id: other_task.task_id(),
        },
    );
    let mut duplicate = ScriptedPerformer::new(vec![Ok(success("duplicate"))]);
    let conflict = execute_task(
        &contract(),
        &request,
        None,
        &mut effects,
        &mut duplicate,
        LifecyclePlan::default(),
        TaskRuntimeLimits::default(),
    );
    assert_eq!(conflict.error_code(), Some("duplicate-effect-key"));
    assert_eq!(effects.len(), 1);
}

#[test]
fn setup_and_cleanup_faults_preserve_precedence_and_rollback_new_effects() {
    let mut listener_effects = BTreeMap::new();
    let mut listener_performer = ScriptedPerformer::new(vec![Ok(success("must-not-run"))]);
    let listener = execute(
        &mut listener_performer,
        &mut listener_effects,
        LifecyclePlan {
            signal: Some(SignalPlan {
                setup_fault: true,
                ..SignalPlan::default()
            }),
            timer: Some(TimerPlan::default()),
            resource: true,
            ..LifecyclePlan::default()
        },
        None,
    );
    assert_eq!(listener.error_code(), Some("invalid-task-signal"));
    assert_eq!(
        listener.receipt.cleanup_events,
        vec!["signal-remove", "resource-close"]
    );

    let mut timer_effects = BTreeMap::new();
    let mut timer_performer = ScriptedPerformer::new(vec![Ok(success("must-not-run"))]);
    let timer = execute(
        &mut timer_performer,
        &mut timer_effects,
        LifecyclePlan {
            signal: Some(SignalPlan::default()),
            timer: Some(TimerPlan {
                setup_fault: true,
                ..TimerPlan::default()
            }),
            resource: true,
            ..LifecyclePlan::default()
        },
        None,
    );
    assert_eq!(timer.error_code(), Some("invalid-task-timeout"));
    assert_eq!(
        timer.receipt.cleanup_events,
        vec!["signal-remove", "resource-close"]
    );

    let mut close_effects = BTreeMap::new();
    let mut close_performer = ScriptedPerformer::new(vec![Ok(success("rollback-effect"))]);
    let close = execute(
        &mut close_performer,
        &mut close_effects,
        LifecyclePlan {
            resource: true,
            resource_close_fault: true,
            ..LifecyclePlan::default()
        },
        None,
    );
    assert_eq!(close.error_code(), Some("task-resource-close-failure"));
    assert!(close_effects.is_empty());

    let mut cleanup_effects = BTreeMap::new();
    let mut cleanup_performer = ScriptedPerformer::new(vec![Ok(success("cleanup-rollback"))]);
    let cleanup = execute(
        &mut cleanup_performer,
        &mut cleanup_effects,
        LifecyclePlan {
            signal: Some(SignalPlan {
                cleanup_fault: true,
                ..SignalPlan::default()
            }),
            timer: Some(TimerPlan {
                cleanup_fault: true,
                ..TimerPlan::default()
            }),
            resource: true,
            resource_close_fault: true,
            ..LifecyclePlan::default()
        },
        None,
    );
    assert_eq!(cleanup.error_code(), Some("invalid-task-timeout"));
    assert_eq!(
        cleanup.receipt.cleanup_events,
        vec!["timer-clear", "signal-remove", "resource-close"]
    );
    assert!(cleanup_effects.is_empty());

    let mut primary_effects = BTreeMap::new();
    let mut primary_performer = ScriptedPerformer::new(vec![Err(TaskPerformerFault)]);
    let primary = execute(
        &mut primary_performer,
        &mut primary_effects,
        LifecyclePlan {
            timer: Some(TimerPlan {
                cleanup_fault: true,
                ..TimerPlan::default()
            }),
            resource: true,
            resource_close_fault: true,
            ..LifecyclePlan::default()
        },
        None,
    );
    assert_eq!(primary.error_code(), Some("task-runtime-failure"));
    assert_eq!(
        primary.receipt.cleanup_events,
        vec!["timer-clear", "resource-close"]
    );
}

#[test]
fn task_and_performer_authority_and_limits_are_checked_before_performing() {
    let mut drift_request = request(authority());
    drift_request.artifact_digest = DIGEST_A.to_owned();
    drift_request.request_digest = task_request_digest(&drift_request);
    let mut effects = BTreeMap::new();
    let mut performer = ScriptedPerformer::new(vec![Ok(success("must-not-run"))]);
    let drift = execute_task(
        &contract(),
        &drift_request,
        None,
        &mut effects,
        &mut performer,
        LifecyclePlan::default(),
        TaskRuntimeLimits::default(),
    );
    assert_eq!(
        drift.error_code(),
        Some("native-task-performer-authority-mismatch")
    );
    assert_eq!(performer.calls, Vec::<u8>::new());

    let mut invalid_digest = request(authority());
    invalid_digest.request_digest = DIGEST_A.to_owned();
    let invalid = execute_task(
        &contract(),
        &invalid_digest,
        None,
        &mut effects,
        &mut performer,
        LifecyclePlan::default(),
        TaskRuntimeLimits::default(),
    );
    assert_eq!(
        invalid.error_code(),
        Some("native-task-request-digest-mismatch")
    );

    let mut limited = ScriptedPerformer::new(vec![Ok(retry_error(1)), Ok(success("never"))]);
    let limited_result = execute_task(
        &contract(),
        &request(authority()),
        None,
        &mut effects,
        &mut limited,
        LifecyclePlan::default(),
        TaskRuntimeLimits {
            max_effects: 8,
            max_trace_entries: 2,
        },
    );
    assert_eq!(
        limited_result.error_code(),
        Some("native-task-trace-limit-exceeded")
    );
}

#[test]
fn malformed_performer_values_fail_closed_without_committing_effects() {
    let cases = [
        TaskPerformerOutcome::Success {
            effect: Some(TaskEffect {
                key: "invalid-output".to_owned(),
                payload: TaskValue::Null,
            }),
            output: TaskValue::Number("01".to_owned()),
        },
        TaskPerformerOutcome::Success {
            effect: Some(TaskEffect {
                key: "invalid-payload".to_owned(),
                payload: TaskValue::Number("-0".to_owned()),
            }),
            output: TaskValue::Null,
        },
        TaskPerformerOutcome::Error {
            checkpoint: object(&[("cursor", TaskValue::Number("1.0".to_owned()))]),
            error: TaskError {
                code: "timeout".to_owned(),
                message: "temporary".to_owned(),
            },
        },
    ];

    for outcome in cases {
        let mut effects = BTreeMap::new();
        let mut performer = ScriptedPerformer::new(vec![Ok(outcome)]);
        let result = execute(&mut performer, &mut effects, LifecyclePlan::default(), None);
        assert_eq!(result.error_code(), Some("invalid-task-value"));
        assert!(effects.is_empty());
    }
}

struct UnitBridge;

impl CapabilityBridge for UnitBridge {
    fn invoke(
        &mut self,
        _instance: &str,
        _member: &str,
        _arguments: &BTreeMap<String, VmValue>,
        _invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        Ok(CapabilityResponse::ok(VmValue::Unit))
    }
}

struct VmPerformer {
    authority: PerformerAuthority,
    graph: Graph,
    artifact: String,
    request: VmRequest,
    bridge: UnitBridge,
}

impl TaskPerformer for VmPerformer {
    fn authority(&self) -> &PerformerAuthority {
        &self.authority
    }

    fn perform(
        &mut self,
        _input: TaskPerformInput<'_>,
        _lifecycle: &mut TaskLifecycleState,
    ) -> Result<TaskPerformerOutcome, TaskPerformerFault> {
        let result = execute_bytecode(
            &self.graph,
            &self.artifact,
            &self.request,
            &mut self.bridge,
            VmLimits::default(),
        )
        .map_err(|_| TaskPerformerFault)?;
        Ok(TaskPerformerOutcome::Success {
            effect: Some(TaskEffect {
                key: "vm-effect".to_owned(),
                payload: object(&[("receipt", TaskValue::String(result.receipt.receipt_digest))]),
            }),
            output: object(&[("status", TaskValue::Number(result.outcome.code.to_string()))]),
        })
    }
}

#[test]
fn controlled_task_performer_can_execute_the_wp255_vm() {
    let graph = check_graph(parse_compact_graph(HELLO, "hello.re").unwrap()).unwrap();
    let artifact = translate_graph(&graph).unwrap();
    let artifact_source = serialize_bytecode_artifact(&artifact).unwrap();
    let vm_request = VmRequest::new(
        graph_revision(&graph).unwrap(),
        artifact.artifact_digest.clone(),
        artifact.profile.clone(),
        DIGEST_A,
    );
    let performer_authority = PerformerAuthority {
        executor: "re.native-vm@0.1.0".to_owned(),
        graph_revision: vm_request.graph_revision.clone(),
        artifact_digest: vm_request.artifact_digest.clone(),
        profile: vm_request.profile.clone(),
    };
    let task_request = request(performer_authority.clone());
    let mut performer = VmPerformer {
        authority: performer_authority,
        graph,
        artifact: artifact_source,
        request: vm_request,
        bridge: UnitBridge,
    };
    let mut effects = BTreeMap::new();
    let result = execute_task(
        &contract(),
        &task_request,
        None,
        &mut effects,
        &mut performer,
        LifecyclePlan::default(),
        TaskRuntimeLimits::default(),
    );

    assert_eq!(result.terminal, "succeeded");
    assert_eq!(
        result.output,
        Some(object(&[("status", TaskValue::Number("0".to_owned()))]))
    );
    assert_eq!(result.receipt.performer_calls, 1);
    assert_eq!(effects.len(), 1);
}

#[derive(Debug)]
struct OracleFacts {
    id: &'static str,
    terminal: &'static str,
    error: Option<&'static str>,
    attempts: u8,
    performer_calls: u8,
    cancel_reason: Option<CancelReason>,
    cleanup: &'static [&'static str],
    effect_count: usize,
    replayed: bool,
    trace: &'static [&'static str],
}

fn assert_oracle(result: &TaskExecution, facts: &OracleFacts) {
    assert_eq!(result.terminal, facts.terminal, "{}", facts.id);
    assert_eq!(result.error_code(), facts.error, "{}", facts.id);
    assert_eq!(result.receipt.attempts, facts.attempts, "{}", facts.id);
    assert_eq!(
        result.receipt.performer_calls, facts.performer_calls,
        "{}",
        facts.id
    );
    assert_eq!(
        result.receipt.cancel_reason, facts.cancel_reason,
        "{}",
        facts.id
    );
    assert_eq!(
        result.receipt.cleanup_events,
        facts
            .cleanup
            .iter()
            .map(|event| (*event).to_owned())
            .collect::<Vec<_>>(),
        "{}",
        facts.id
    );
    assert_eq!(
        result.receipt.effect_count, facts.effect_count,
        "{}",
        facts.id
    );
    assert_eq!(result.receipt.replayed, facts.replayed, "{}", facts.id);
    assert_eq!(result.receipt.trace_kinds(), facts.trace, "{}", facts.id);
}

#[test]
fn native_lifecycle_corpus_matches_all_fourteen_node_oracle_scenarios() {
    let cases = [
        OracleFacts {
            id: "success-resource-close",
            terminal: "succeeded",
            error: None,
            attempts: 1,
            performer_calls: 1,
            cancel_reason: None,
            cleanup: &["resource-close"],
            effect_count: 1,
            replayed: false,
            trace: &["attempt-start", "success", "resource-close"],
        },
        OracleFacts {
            id: "retry-transient-success",
            terminal: "succeeded",
            error: None,
            attempts: 3,
            performer_calls: 3,
            cancel_reason: None,
            cleanup: &["resource-close"],
            effect_count: 1,
            replayed: false,
            trace: &[
                "attempt-start",
                "attempt-error",
                "retry",
                "attempt-start",
                "attempt-error",
                "retry",
                "attempt-start",
                "success",
                "resource-close",
            ],
        },
        OracleFacts {
            id: "permanent-error",
            terminal: "failed",
            error: None,
            attempts: 1,
            performer_calls: 1,
            cancel_reason: None,
            cleanup: &["resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &["attempt-start", "attempt-error", "resource-close"],
        },
        OracleFacts {
            id: "replay-existing-effect",
            terminal: "succeeded",
            error: None,
            attempts: 2,
            performer_calls: 0,
            cancel_reason: None,
            cleanup: &["resource-close"],
            effect_count: 1,
            replayed: true,
            trace: &["replay", "resource-close"],
        },
        OracleFacts {
            id: "cancel-before-start",
            terminal: "cancelled",
            error: None,
            attempts: 0,
            performer_calls: 0,
            cancel_reason: Some(CancelReason::BeforeStart),
            cleanup: &["resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &["cancel-before-start", "resource-close"],
        },
        OracleFacts {
            id: "parent-already-aborted",
            terminal: "cancelled",
            error: None,
            attempts: 0,
            performer_calls: 0,
            cancel_reason: Some(CancelReason::Parent),
            cleanup: &["signal-remove", "resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &["cancel-before-start", "resource-close"],
        },
        OracleFacts {
            id: "timeout-late-effect",
            terminal: "cancelled",
            error: None,
            attempts: 1,
            performer_calls: 1,
            cancel_reason: Some(CancelReason::Timeout),
            cleanup: &["timer-clear", "signal-remove", "resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &["attempt-start", "cancel-after-start", "resource-close"],
        },
        OracleFacts {
            id: "parent-wins-timeout",
            terminal: "cancelled",
            error: None,
            attempts: 1,
            performer_calls: 1,
            cancel_reason: Some(CancelReason::Parent),
            cleanup: &["timer-clear", "signal-remove", "resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &["attempt-start", "cancel-after-start", "resource-close"],
        },
        OracleFacts {
            id: "performer-host-fault",
            terminal: "rejected",
            error: Some("task-runtime-failure"),
            attempts: 1,
            performer_calls: 1,
            cancel_reason: None,
            cleanup: &["timer-clear", "resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &[],
        },
        OracleFacts {
            id: "stale-checkpoint",
            terminal: "rejected",
            error: Some("stale-task-checkpoint"),
            attempts: 0,
            performer_calls: 0,
            cancel_reason: None,
            cleanup: &["timer-clear", "resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &[],
        },
        OracleFacts {
            id: "resource-close-fault",
            terminal: "rejected",
            error: Some("task-resource-close-failure"),
            attempts: 1,
            performer_calls: 1,
            cancel_reason: None,
            cleanup: &["resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &[],
        },
        OracleFacts {
            id: "cleanup-first-fault",
            terminal: "rejected",
            error: Some("invalid-task-timeout"),
            attempts: 1,
            performer_calls: 1,
            cancel_reason: None,
            cleanup: &["timer-clear", "signal-remove", "resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &[],
        },
        OracleFacts {
            id: "listener-setup-fault",
            terminal: "rejected",
            error: Some("invalid-task-signal"),
            attempts: 0,
            performer_calls: 0,
            cancel_reason: None,
            cleanup: &["signal-remove", "resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &[],
        },
        OracleFacts {
            id: "timer-setup-fault",
            terminal: "rejected",
            error: Some("invalid-task-timeout"),
            attempts: 0,
            performer_calls: 0,
            cancel_reason: None,
            cleanup: &["signal-remove", "resource-close"],
            effect_count: 0,
            replayed: false,
            trace: &[],
        },
    ];

    for facts in &cases {
        let mut effects = BTreeMap::new();
        let mut performer = match facts.id {
            "retry-transient-success" => ScriptedPerformer::new(vec![
                Ok(retry_error(1)),
                Ok(retry_error(2)),
                Ok(success("retry-effect")),
            ]),
            "permanent-error" => ScriptedPerformer::new(vec![Ok(TaskPerformerOutcome::Error {
                checkpoint: TaskValue::Object(BTreeMap::new()),
                error: TaskError {
                    code: "validation".to_owned(),
                    message: "permanent".to_owned(),
                },
            })]),
            "performer-host-fault" => ScriptedPerformer::new(vec![Err(TaskPerformerFault)]),
            _ => ScriptedPerformer::new(vec![Ok(success(match facts.id {
                "success-resource-close" => "success-effect",
                "resource-close-fault" => "rollback-effect",
                "cleanup-first-fault" => "cleanup-rollback",
                _ => "late-effect",
            }))]),
        };
        let mut checkpoint = None;
        let mut plan = LifecyclePlan {
            resource: true,
            ..LifecyclePlan::default()
        };
        match facts.id {
            "replay-existing-effect" => {
                let task_id = request(authority()).task_id();
                effects.insert(
                    "replay-effect".to_owned(),
                    EffectRecord {
                        attempt: 2,
                        effect_key: "replay-effect".to_owned(),
                        output: object(&[("approved", TaskValue::Bool(true))]),
                        payload: object(&[("posted", TaskValue::Bool(true))]),
                        task_id,
                    },
                );
            }
            "cancel-before-start" => plan.cancel_at = Some(CancelAt::BeforeStart),
            "parent-already-aborted" => {
                plan.signal = Some(SignalPlan {
                    initially_aborted: true,
                    ..SignalPlan::default()
                });
            }
            "timeout-late-effect" => {
                plan.signal = Some(SignalPlan::default());
                plan.timer = Some(TimerPlan::default());
                performer.cancellations = vec![vec![CancelReason::Timeout]];
            }
            "parent-wins-timeout" => {
                plan.signal = Some(SignalPlan::default());
                plan.timer = Some(TimerPlan::default());
                performer.cancellations = vec![vec![CancelReason::Parent, CancelReason::Timeout]];
            }
            "performer-host-fault" => plan.timer = Some(TimerPlan::default()),
            "stale-checkpoint" => {
                plan.timer = Some(TimerPlan::default());
                checkpoint = Some(TaskCheckpoint {
                    attempt: 1,
                    data: TaskValue::Object(BTreeMap::new()),
                    input_digest: DIGEST_A.to_owned(),
                    revision: "stale".to_owned(),
                    state: "retrying".to_owned(),
                    task_id: DIGEST_A.to_owned(),
                });
            }
            "resource-close-fault" => plan.resource_close_fault = true,
            "cleanup-first-fault" => {
                plan.signal = Some(SignalPlan {
                    cleanup_fault: true,
                    ..SignalPlan::default()
                });
                plan.timer = Some(TimerPlan {
                    cleanup_fault: true,
                    ..TimerPlan::default()
                });
                plan.resource_close_fault = true;
            }
            "listener-setup-fault" => {
                plan.signal = Some(SignalPlan {
                    setup_fault: true,
                    ..SignalPlan::default()
                });
                plan.timer = Some(TimerPlan::default());
            }
            "timer-setup-fault" => {
                plan.signal = Some(SignalPlan::default());
                plan.timer = Some(TimerPlan {
                    setup_fault: true,
                    ..TimerPlan::default()
                });
            }
            _ => {}
        }
        let result = execute(&mut performer, &mut effects, plan, checkpoint);
        assert_oracle(&result, facts);
    }
}
