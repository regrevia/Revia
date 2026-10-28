re 1.0 compact
module agent.expense.policy
import agent.expense.domain@sha256:63a55e339472c7a44d4032f79c328a78400703c169cde25264efebd38c901005 as domain
export decide
capability agent.expense.policy.db write db.write@0.1.0 uid bbbbbbbbbbbbbbbbbbbbbbbbbe
error agent.expense.policy.error uid 3333333333333333333333333e
state ready uid pppppppppppppppppppppppppe
task agent.expense.policy.task id sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
edge agent.expense.policy.input -> agent.expense.policy.output uid iiiiiiiiiiiiiiiiiiiiiiiiie
