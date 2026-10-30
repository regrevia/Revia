re 1.0 compact
module agent.expense.api
import agent.expense.approval@sha256:7fa55f645c949a07d607778b68864016390c441abc60183b383f0e7b196f14d3 as approval
export serve
capability agent.expense.api.db write db.write@0.1.0 uid fffffffffffffffffffffffffe
error agent.expense.api.error uid 7777777777777777777777777e
state ready uid ttttttttttttttttttttttttte
task agent.expense.api.task id sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
edge agent.expense.api.input -> agent.expense.api.output uid mmmmmmmmmmmmmmmmmmmmmmmmme
