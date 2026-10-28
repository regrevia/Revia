re 1.0 compact
module agent.expense.approval
import agent.expense.intake@sha256:32cf7bbb15a48c1677520e314a6e9d911c3c1e3e5f3f6417fdceb731d76d8d9e as intake
export approve
capability agent.expense.approval.db write db.write@0.1.0 uid eeeeeeeeeeeeeeeeeeeeeeeeee
error agent.expense.approval.error uid 6666666666666666666666666e
state ready uid ssssssssssssssssssssssssse
task agent.expense.approval.task id sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
edge agent.expense.approval.input -> agent.expense.approval.output uid llllllllllllllllllllllllle
