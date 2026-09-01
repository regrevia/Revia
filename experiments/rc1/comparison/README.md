# Fair Comparison Track

Compare outcomes, not slogans. Use the same public task, input bytes, allowed effects, resource boundary, and success criterion. Record setup separately from measured execution, and distinguish functional evidence from performance evidence.

Required rules:

1. Identify language/runtime version, target OS/architecture, and exact asset or toolchain digest.
2. Publish the public task and input digests.
3. Record the exact command and exit status.
4. Hash stdout, stderr, structured result, and declared effect tree separately.
5. Label native, virtualized-native, or emulated execution accurately.
6. Do not compare performance across emulated and native targets as if equivalent.
7. Report failures and unsupported features without substituting a different task.

Validate records against [`record.schema.json`](record.schema.json).

中文：比较相同任务、输入、效果边界和成功标准；原生、虚拟化原生与模拟必须准确标注，不能把模拟性能当作原生性能。
