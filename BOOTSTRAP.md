# BOOTSTRAP.md — Active Work Quick Reference

Run `Task { action: "status" }` to check active plans. Use `lcm_grep` / `lcm_expand_query` to recall past context.

---

## Active Projects

### PolyOracle [ALL OBJECTIVES COMPLETE — 2026-03-18]
**MC Project ID:** `polyoracle-5c7f`
**Repo:** `~/Projects/jaksa/polyoracle`
**Telegram topic:** thread 2141
**Tests:** 370 passing across 29 files
**Status:** All 4 objectives done. Full pipeline wired (Scanner → Analyst → Pricing → Executor). TUI working.
**Next:** LLM integration for intelligent agent decisions (currently event-driven functions)

### Mission Control UI
**MC Project ID:** `mission-control-ui-4e7e`
**Repo:** `~/Projects/jaksa/mission-control-ui/`
**Plugin repo:** `~/Projects/jaksa/mission-control-tools/`
**Data dir:** `~/.mission-control/jaksa/`
**Status:** UI polish round 1 complete. All objectives done.

### TurboTenant [ACTIVE]
**Role:** Full-stack AI developer, AI team
**Memory:** `memory/projects/turbotenant/`

### Fuck It Stack
**MC Project ID:** `fuck-it-stack-7616`
**Repo:** `~/Projects/jaksa/fuck-it-stack/`

### DOO — PSK Accounting
- Files: `memory/projects/doo/`

### Lossless Claw (LCM) [INSTALLED]
- v0.2.2 on all 3 gateways (jaksa, aleksa, danijela)

---

## Completed Today (2026-03-08)

- ✅ OpenClaw 2026.3.2 → 2026.3.7
- ✅ Lossless Claw v0.2.2 installed all gateways
- ✅ Gmail cleanup: 2 auto-trash filters (47 sender domains), 31+ unsubscribed, 400+ trashed
- ✅ Mailbox Tidy cron: `db4a65f7` at 7:30 AM Belgrade daily
- ✅ MC UI: react-arborist tree view (commit `33dce81`)
- ✅ MC UI: polish round 1 — headers, progress bars, tree width, ObjectiveDetailPanel (commit `4bcf639`)
- ✅ Velocity bug: 8 tasks had Unix epoch timestamps → now handled

---

## Backlog

- [ ] Image edit: Vučić cat on window — blocked on Gemini API enablement (project `1052409012800`)
- [ ] Fix `plugins.entries.mission-control` config warning on all 3 gateways
- [ ] Set explicit `plugins.allow` trusted IDs
- [ ] Morning brief feedback ("osim par sekcija malo govno")
- [ ] Brainstorm: memory DAG × multi-agent MC architecture

---

## Key References

- **MC implementation plan:** `memory/projects/mission-control/implementation-plan.md`
- **MC v2 spec:** `memory/projects/mission-control/v2-spec.md`
- **Agent network spec:** `memory/projects/mission-control/agent-network-spec.md`
- **Mailbox Tidy spec:** `memory/reference/mailbox-tidy.md`
- **Morning brief spec:** `memory/reference/morning-brief-system.md`
- **Today's notes:** `memory/2026-03-08.md`
- **Pipeline lessons:** `memory/be-better/2026-03-08-team-process.md`

---

## Standing Notes

- **LCM tools:** `lcm_grep`, `lcm_describe`, `lcm_expand` for searching compacted history
- **L-1 Lifeline** at `~/.openclaw/lifeline/` — monitors cooldown death spirals
- **Stall detector:** `~/.openclaw/lifeline/mc-stall-detector.sh` (launchd every 2min)
- **Agent workspaces:** `~/.openclaw/workspace-{developer,designer,qa,researcher,radar}/`
