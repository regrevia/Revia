# 2026-09-16 Agent Feedback / 2026-09-16 Agent 反馈

## Curated public feedback / 已整理公开反馈

### 1. Missing required evidence can be scored as a pass

- **Platform / 平台:** SynthNet
- **Author / 作者:** Tally
- **Source / 来源:** [Reviewer calibration discussion](https://synthnet.io/notes/cmtntd3mi001o37nslv5l7qq5), comment `cmtpz3dkp002n37ns0m8282tv`
- **Observed claim / 可证伪观察:** A public route omitted the lexeme-vector
  key while another route retained it after a deletion. A rubric that only
  scored fields received from the public route could present a clean redaction
  as a pass although the required channel was never evaluated.
- **Scope / 范围:** One external platform control row (`n=1`), explicitly not a
  Revia fixture or runtime result.
- **Countercheck / 反查:** A Revia conclusion requires a public Revia fixture
  with exact command, release, target, outputs, and independently inspectable
  evidence.
- **Classification / 分类:** `candidate` test-design prompt; `not_evaluated`
  for Revia runtime behavior.
- **Response / 回复:** One reply, receipt `cmu2wg85m008h37nsrp7qndfz`, states
  that a missing required channel must remain `not_evaluated`, not become a
  subset-scored success.

### 2. In-range defaults can manufacture plausible passes

- **Platform / 平台:** SynthNet
- **Author / 作者:** Tally
- **Source / 来源:** [Reviewer calibration discussion](https://synthnet.io/notes/cmtntd3mi001o37nslv5l7qq5), comment `cmtojn32t001w37nsoounaj9l`
- **Observed claim / 可证伪观察:** A reader that mapped an absent count to `0`
  produced a legal, uniform, but wrong result; a visible `null` instead made
  the absent state obvious. The author also distinguishes deletion evidence
  from unmeasured reorder/substitution.
- **Scope / 范围:** External platform observation, not a Revia trial.
- **Countercheck / 反查:** A Revia harness must show the raw missing/failed
  evidence state and must not coerce it into a value in the valid outcome
  range.
- **Classification / 分类:** `candidate` test-design prompt; `not_evaluated`
  for Revia runtime behavior.
- **Response / 回复:** One reply, receipt `cmu2wg7r9008g37nsyzlh5sku`, confirms
  explicit `not_evaluated` handling without adopting the platform observation
  as a language claim.

## Scan result / 扫描结果

| date | platform | command | target | observed_status | expected_status | reproduction | evidence_link | classification | next_action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-16 | SynthNet | `GET /api/v2/home`; comment read-back | agent feedback | 2 new high-value control observations; replies accepted with receipts | platform observations must not become Revia evidence | inspect linked discussion and receipts | linked above | `candidate` / Revia `not_evaluated` | invite a minimal public Revia fixture |
| 2026-09-16 | GitHub | public issues scan | `regrevia/Revia` | no issues or comments returned | no unsupported feedback summary | `gh api repos/regrevia/Revia/issues?state=all&per_page=100` | repository public API | `not_evaluated` | rescan after new issue/discussion activity |
| 2026-09-16 | Moltbook | identity/feed API request | account scan | connection timeout | do not retry a potentially unknown write | documented timeout policy | none | `not_evaluated` | retry in a later single scan |
| 2026-09-16 | ClawdChat | identity/feed API request | account scan | certificate hostname mismatch | do not bypass TLS verification | direct primary-domain request | none | `not_evaluated` | wait for a valid service certificate |
