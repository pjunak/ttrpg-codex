# P8 sheets action inventory

Temporary, local-only inventory. The sheets worktree started with 86 registered
actions in `entry.js`; the render graph and tests were traced before extraction.

## Domains and dependencies

- Base/navigation: `tab`, `tabKey`, `setField`, `setAbility`, `toggleSave`,
  `toggleSkill`, `setOverrideValue`, `clearOverride`, `uiLayoutSet`. Uses the
  host, sheet/model mutation, visible-tab calculation, layout keys, and one
  focus timer.
- Spells: `spellAdd`, `spellDel`, `learnCantrip`, `unlearnCantrip`,
  `prepSpell`, `unprepSpell`, `spellbookLearn`, `spellbookForget`,
  `spellMgrOpen`, `spellMgrClose`, `spellCopyPick`, `spellCopy`,
  `spellCustomAdd`, `spellSwapOpen`, `spellSwapClose`, `spellSwapApply`,
  `spellSwapForget`, `spellDragStart`, `spellDrop`, `grantPick`,
  `grantUnpick`, `spellSet`. Uses persistence, rules/provider lookup,
  hydration, inventory/currency for scroll copying, modal localStorage, DOM
  form reads, and one in-memory drag ref.
- Inventory/equipment: `invDel`, `invSet`, `invCycle`, `currencySet`,
  `invAttune`, `slotEquip`, `slotUnequip`, `slotAttune`, `slotUnattune`,
  `addItemOpen`, `addItemClose`, `addItemNav`, `addItemSearch`,
  `addItemStage`, `addItemStageCustom`, `addItemQty`, `addItemUnstage`,
  `addItemClear`, `addItemCommit`. Uses persistence, provider item lookup,
  wizard localStorage state, DOM search/custom fields, and a shared internal
  inventory-add operation.
- Resources/rest: `resourceAdd`, `resourceDel`, `resourceAdjust`,
  `resourceSet`, `resourceUseAdjust`, `resourceUseReset`, `restOpen`,
  `restClose`, `restSpendHitDie`, `restApply`. Uses persistence, hydration,
  override-aware max HP, resource recharge rules, and rest localStorage.
- Builder: `builderField`, `builderAbility`, `builderToggleManual`,
  `builderAbilitySet`, `builderClassSet`, `builderLevelSet`,
  `builderSubclassSet`, `builderAddClass`, `builderRemoveClass`, `builderTab`,
  `builderTabKey`, `builderToggleLevel`, `builderExtraFeatAdd`,
  `builderExtraFeatRemove`, `builderAsiSet`, `builderChoose`. Uses
  builderMutate/reconcile/builderModel, provider feat lookup, the per-character
  in-memory builder state, DOM extra-feat fields, announcements, and one focus
  timer.
- Import/export/print: `printSheet`, `exportSheet`, `importOpen`,
  `importClose`, `importApply`. Uses current characters, sheet normalization,
  hydration/print rendering, DOM/window/Blob/URL, import localStorage, and a
  URL-revocation timer.

## Dynamic render callers

- `panel.header.js` composes `slotEquip`/`slotAttune` and
  `slotUnequip`/`slotUnattune` through render-helper parameters.
- `panel.spellbook.js` composes `learnCantrip`/`prepSpell` and
  `unlearnCantrip`/`unprepSpell`, plus the `spellbookLearn` path, from the
  rendered spell group.
- `panel.settings.js` passes `printSheet`, `exportSheet`, and `importOpen`
  through its tool helper.
- Builder action names are template-generated with character/class/level
  arguments but the action identifiers themselves are static.
- No deferred action-name seam or documented external action API was found.
  The documented programmatic contract is the provided rules API, not UI
  actions.

## Verified dead seams

- `ui.statBox`: only its definition/style/export exist; no panel, test, or
  documentation caller. `miniStat` is the live Builder-summary helper.
- `copySpell`: test-only action; the live render uses `spellMgrOpen` plus
  `spellCopy` for scroll copying and `spellCustomAdd` for other sources.
- `invAdd`: no render, test, or documentation caller; the add-item wizard is
  the supported flow.
- `builderBgAsi`: test-only action; all Builder ASI markup uses
  `builderAsiSet`.
- `hp`: test-only action; the live HP stepper uses `setField`. Direct mutation
  coverage should target a pure HP helper.
- `invAddRef`: test-only action; current UI uses the add-item wizard. Its
  record construction belongs in the same internal inventory-add operation
  used by `addItemCommit`.

## Lifecycle resources

There are no installed DOM listeners. The spell drag ref, Builder state, and
focus/URL timers must be reset or cancelled by the returned addon disposer.
