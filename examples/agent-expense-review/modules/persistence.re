re 1.0 compact
module agent.expense.persistence
import agent.expense.policy@sha256:151064aa4524d1159b35797aea42f8aca77ba7f13f1d18cc7a7869820fcbc7ec as policy
export save
capability agent.expense.persistence.db write db.write@0.1.0 uid ccccccccccccccccccccccccce
error agent.expense.persistence.error uid 4444444444444444444444444e
state ready uid qqqqqqqqqqqqqqqqqqqqqqqqqe
task agent.expense.persistence.task id sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
edge agent.expense.persistence.input -> agent.expense.persistence.output uid jjjjjjjjjjjjjjjjjjjjjjjjje
