re 1.0 compact
module agent.expense.api
import agent.expense.approval@sha256:065612927ac2a2fb067f27955f13e8d2ed5d3b22b041aa49317570079aab4277 as approval
export serve
capability agent.expense.api.db write db.write@0.1.0 uid fffffffffffffffffffffffffe
error agent.expense.api.error uid 7777777777777777777777777e
state ready uid ttttttttttttttttttttttttte
task agent.expense.api.task id sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
edge agent.expense.api.input -> agent.expense.api.output uid mmmmmmmmmmmmmmmmmmmmmmmmme
