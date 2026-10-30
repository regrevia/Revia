re 1.0 compact
module agent.expense.approval
import agent.expense.intake@sha256:40b80e4d888d72f4e1a0374d0e64f1cf30801a7b730a7bf9cc95873f3f423f1f as intake
export approve
capability agent.expense.approval.db write db.write@0.1.0 uid eeeeeeeeeeeeeeeeeeeeeeeeee
error agent.expense.approval.error uid 6666666666666666666666666e
state ready uid ssssssssssssssssssssssssse
task agent.expense.approval.task id sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
edge agent.expense.approval.input -> agent.expense.approval.output uid llllllllllllllllllllllllle
