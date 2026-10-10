$repo = 'C:\Users\junak\Documents\GitHub\dnd-character-sheets'
$entryPath = Join-Path $repo 'entry.js'
$lines = Get-Content -LiteralPath $entryPath

function Find-Line([string]$pattern, [int]$start = 0) {
  for ($i = $start; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Contains($pattern)) { return $i }
  }
  throw "Missing marker: $pattern"
}

function Write-Module([string]$name, [string[]]$header, [string[]]$body, [string[]]$footer = @('}')) {
  Set-Content -LiteralPath (Join-Path $repo $name) -Value @($header + $body + $footer) -Encoding utf8
}

$spellStart = Find-Line '  // Spellbook — manual/extra entries'
$spellEnd = Find-Line '  // Backpack.' $spellStart
$inventoryStart = $spellEnd
$inventoryEnd = Find-Line '  // ── Resource trackers' $inventoryStart
$resourceStart = $inventoryEnd
$builderStart = Find-Line '  // ── Builder (engine mode)' $resourceStart
$transferStart = Find-Line '  // Print / PDF' $builderStart
$legacyBgStart = Find-Line "  host.registerAction('builderBgAsi'" $transferStart
$asiStart = Find-Line '  // Distribute-N-points ASI picker' $legacyBgStart
$layoutStart = Find-Line '  // ── Sheet layout switch' $asiStart
$provideStart = Find-Line '  // ── Rules API for other addons' $layoutStart

$spellBody = $lines[$spellStart..($spellEnd - 1)]
$spellBody = $spellBody -replace 'host\.registerAction\(', 'register('
Write-Module 'actions.spells.js' @(
  "export const SPELL_ACTIONS = Object.freeze(['spellAdd','spellDel','learnCantrip','unlearnCantrip','prepSpell','unprepSpell','spellbookLearn','spellbookForget','spellMgrOpen','spellMgrClose','spellCopyPick','spellCopy','spellCustomAdd','spellSwapOpen','spellSwapClose','spellSwapApply','spellSwapForget','spellDragStart','spellDrop','grantPick','grantUnpick','spellSet']);",
  '',
  'export function registerSpellActions(deps) {',
  '  const { host, num, uid, mutate, getRules, safeHydrate, decisionsOf, scrollCopyCost } = deps;',
  '  const register = (name, fn) => host.registerAction(name, fn);',
  '  const hydrateFor = (sheet) => { const engine = getRules(); const result = engine ? safeHydrate(engine, decisionsOf(sheet, engine)) : null; return result && result.sheet; };'
) $spellBody @(
  '  return () => { _dragRef = null; };',
  '}'
)

$invAddStart = Find-Line "  host.registerAction('invAdd'" $inventoryStart
$invDelStart = Find-Line "  host.registerAction('invDel'" $invAddStart
$invAddRefStart = Find-Line "  host.registerAction('invAddRef'" $invDelStart
$invAttuneStart = Find-Line "  host.registerAction('invAttune'" $invAddRefStart
$inventoryBody = @(
  $lines[$inventoryStart..($invAddStart - 1)]
  $lines[$invDelStart..($invAddRefStart - 1)]
  $lines[$invAttuneStart..($inventoryEnd - 1)]
)
$inventoryBody = $inventoryBody -replace 'host\.registerAction\(', 'register('
Write-Module 'actions.inventory.js' @(
  "export const INVENTORY_ACTIONS = Object.freeze(['invDel','invSet','invCycle','currencySet','invAttune','slotEquip','slotUnequip','slotAttune','slotUnattune','addItemOpen','addItemClose','addItemNav','addItemSearch','addItemStage','addItemStageCustom','addItemQty','addItemUnstage','addItemClear','addItemCommit']);",
  '',
  'export function addInventoryItems(sheet, items, deps) {',
  '  const inventory = Array.isArray(sheet.inventory) ? sheet.inventory.slice() : [];',
  '  for (const item of items) {',
  "    const row = { id: deps.uid('item'), name: item.name, qty: Math.max(1, deps.num(item.qty, 1)), location: deps.location(item.kind), attuned: false };",
  '    if (item.ref) row.ref = item.ref;',
  '    if (item.kind) row.kind = item.kind;',
  '    inventory.push(row);',
  '  }',
  '  sheet.inventory = inventory;',
  '  return sheet;',
  '}',
  '',
  'export function registerInventoryActions(deps) {',
  '  const { host, num, uid, mutate, getRules, LOCATIONS } = deps;',
  '  const register = (name, fn) => host.registerAction(name, fn);'
) $inventoryBody

$builderBody = @($lines[$builderStart..($transferStart - 1)] + $lines[$asiStart..($layoutStart - 1)])
$builderBody = $builderBody -replace 'host\.registerAction\(', 'register(' -replace 'ctx\.builderState', 'builderState'
Write-Module 'actions.builder.js' @(
  "export const BUILDER_ACTIONS = Object.freeze(['builderField','builderAbility','builderToggleManual','builderAbilitySet','builderClassSet','builderLevelSet','builderSubclassSet','builderAddClass','builderRemoveClass','builderTab','builderTabKey','builderToggleLevel','builderExtraFeatAdd','builderExtraFeatRemove','builderAsiSet','builderChoose']);",
  '',
  'export function registerBuilderActions(deps) {',
  '  const { host, t, num, uid, ABILITIES, POINT_BUY, pointCost, pointsSpent, featAsiFrom, featAbilityCap, builderState, sheetOf, getRules } = deps;',
  '  const { builderMutate, reconcile, builderModel } = deps.engine;',
  '  const register = (name, fn) => host.registerAction(name, fn);',
  '  const timers = new Set();',
  '  const later = (fn) => { const id = setTimeout(() => { timers.delete(id); fn(); }, 0); timers.add(id); };'
) ($builderBody -replace 'setTimeout\(\(\) =>', 'later(() =>') @(
  '  return () => { for (const timer of timers) clearTimeout(timer); timers.clear(); for (const key of Object.keys(builderState)) delete builderState[key]; };',
  '}'
)

$transferBody = $lines[$transferStart..($legacyBgStart - 1)]
$transferBody = $transferBody -replace 'host\.registerAction\(', 'register('
Write-Module 'actions.transfer.js' @(
  "export const TRANSFER_ACTIONS = Object.freeze(['printSheet','exportSheet','importOpen','importClose','importApply']);",
  '',
  'export function registerTransferActions(deps) {',
  '  const { host, NS, sheetOf, getRules, safeHydrate, decisionsOf, buildPrintHtml, mutate } = deps;',
  '  const register = (name, fn) => host.registerAction(name, fn);',
  '  const timers = new Set();',
  '  const later = (fn, delay) => { const id = setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); };'
) ($transferBody -replace 'setTimeout\(\(\) =>', 'later(() =>') @(
  '  return () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };',
  '}'
)

$prefix = $lines[0..($spellStart - 1)]
$actionMarker = Find-Line '  //  Actions'
$prefix = $lines[0..($actionMarker - 2)]
$composition = @(
  '',
  '  const disposers = [',
  '    registerBaseActions({ host, ABILITIES, SKILLS, num, clampHp, sheetOf, mutate, effectiveMaxHp, getRules, safeHydrate, decisionsOf, visibleTabs, hasSpellsOf, tabKey, tabBtnId }),',
  '    registerSpellActions({ host, num, uid, mutate, getRules, safeHydrate, decisionsOf, scrollCopyCost }),',
  '    registerInventoryActions({ host, num, uid, mutate, getRules, LOCATIONS }),',
  '    registerResourceActions({ host, num, uid, mutate, getRules, safeHydrate, decisionsOf, effectiveMaxHp, hitDieAvg }),',
  '    registerBuilderActions({ host, t, num, uid, ABILITIES, POINT_BUY, pointCost, pointsSpent, featAsiFrom, featAbilityCap, builderState: ctx.builderState, sheetOf, getRules, engine: ctx.engine }),',
  '    registerTransferActions({ host, NS, sheetOf, getRules, safeHydrate, decisionsOf, buildPrintHtml, mutate }),',
  '  ].filter(Boolean);',
  '',
  '  host.provide(ctx.engine.rulesApi);',
  '  return () => { for (const dispose of disposers.slice().reverse()) dispose(); };',
  '}'
)
$newEntry = @($prefix + $composition)
$importAt = (Find-Line "import { makePrintPanel } from './panel.print.js';")
$actionImports = @(
  "import { registerBaseActions } from './actions.base.js';",
  "import { registerSpellActions } from './actions.spells.js';",
  "import { registerInventoryActions } from './actions.inventory.js';",
  "import { registerResourceActions } from './actions.resources.js';",
  "import { registerBuilderActions } from './actions.builder.js';",
  "import { registerTransferActions } from './actions.transfer.js';"
)
$newEntry = @($newEntry[0..$importAt] + $actionImports + $newEntry[($importAt + 1)..($newEntry.Count - 1)])
Set-Content -LiteralPath $entryPath -Value $newEntry -Encoding utf8
