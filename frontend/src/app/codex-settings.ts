import { cssHexColor } from "./campaign-projection.js";
import { formText, formTextValues } from "../core/forms.js";
import { uiText } from "./ui-localization.js";
import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import type {
  CampaignEnumCategory,
  CampaignEnumDeleteMutation,
} from "../core/campaign-mutations.js";
import {
  campaignEnumDescriptor,
  campaignEnumDescriptors,
  campaignEnumItems,
  campaignEnumRecord,
  campaignEnumStarter,
  campaignEnumUsageCount,
  CampaignSettingsEditError,
  type CampaignEnumItem,
  type CampaignEnumSaveDetail,
  type CampaignSettingField,
} from "./campaign-settings.js";
import { saveCampaign, type CampaignWriteKind, type CampaignWrites } from "./campaign-writes.js";
import { saveFailure } from "./save-failure.js";
import { confirmDiscardUnsavedEdit, reportEditState } from "./unsaved-edit.js";
import {
  campaignAppearanceRecord,
  campaignTheme,
  campaignThemes,
  type CampaignAppearanceSaveDetail,
  type CampaignThemeID,
} from "./campaign-appearance.js";
import { UiLocalizationController, availableUiLocales } from "./ui-localization.js";
import "./codex-map-settings.js";
import "./codex-party-settings.js";
import "./codex-branding-settings.js";
import "./codex-sidebar-settings.js";
import "./codex-addon-manager.js";
import "./codex-credential-settings.js";
import "./codex-recovery-settings.js";
import type { BrowserNavigationEntry } from "../addons/navigation.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { AddonContributionsController } from "./addon-contributions-controller.js";
import { UIControlsController } from "../ui/controller.js";
import { mapSettingsHash, settingsHash, type SettingsSlug } from "./routes.js";

type SettingsCategory =
  | "language"
  | "appearance"
  | "maps"
  | "playerParty"
  | "sidebar"
  | "addons"
  | "account"
  | "backup"
  | CampaignEnumCategory;

const categorySlugs: Record<Exclude<SettingsCategory, "addons" | "maps">, SettingsSlug> = {
  language: "language",
  appearance: "appearance",
  playerParty: "party",
  sidebar: "sidebar",
  relationshipTypes: "relationships",
  genders: "genders",
  pinTypes: "map-markers",
  characterStatuses: "character-statuses",
  eventPriorities: "event-priorities",
  attitudes: "attitudes",
  account: "access",
  backup: "backup",
};

function categoryHash(category: SettingsCategory): string {
  if (category === "addons") return "#/settings/addons";
  if (category === "maps") return mapSettingsHash(null);
  return settingsHash(categorySlugs[category]);
}

function slugCategory(slug: SettingsSlug): SettingsCategory {
  return (Object.keys(categorySlugs) as (keyof typeof categorySlugs)[]).find(
    (category) => categorySlugs[category] === slug,
  )!;
}

export class CodexSettings extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    mapTarget: { attribute: false },
    canManageCampaign: { type: Boolean, attribute: false },
    busy: { type: Boolean },
    activeCategory: { state: true },
    writing: { state: true },
    writeError: { state: true },
    addonPages: { attribute: false },
    csrfToken: { attribute: false },
    editingId: { state: true },
    deleteId: { state: true },
    registry: { attribute: false },
    actorRole: { attribute: false },
    addonTarget: { attribute: false },
    category: { attribute: false },
  };

  declare campaign: CampaignDataset | undefined;
  declare mapTarget: string | null | undefined;
  declare canManageCampaign: boolean;
  /** The app is saving or otherwise busy, so no write may start. */
  declare busy: boolean;
  declare private activeCategory: SettingsCategory;
  /** This view's own definition or theme save is running. */
  declare private writing: boolean;
  declare private writeError: string;
  declare private editingId: string | null;
  declare private deleteId: string | null;
  declare addonPages: readonly BrowserNavigationEntry[];
  declare csrfToken: string;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  declare addonTarget: string | null | undefined;
  /** The category named by the route; maps and add-ons use their own route targets. */
  declare category: SettingsSlug | undefined;
  readonly #contributions = new AddonContributionsController(this, () => ({
    registry: this.registry,
    role: this.actorRole,
  }));
  readonly #ui = new UiLocalizationController(this);
  #dirty = false;
  #credentialsSaving = false;
  /** The theme being saved, shown until that save finishes or fails. */
  #pendingTheme: CampaignThemeID | undefined;
  #editCampaign: CampaignDataset | undefined;

  constructor() {
    super();
    new UIControlsController(this);
    this.addonPages = [];
    this.campaign = undefined;
    this.mapTarget = undefined;
    this.canManageCampaign = false;
    this.busy = false;
    this.writing = false;
    this.writeError = "";
    this.activeCategory = "language";
    this.editingId = null;
    this.deleteId = null;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (
      changed.has("category") ||
      changed.has("mapTarget") ||
      changed.has("addonTarget") ||
      changed.has("canManageCampaign")
    ) {
      const requested: SettingsCategory =
        this.mapTarget !== undefined && this.canManageCampaign
          ? "maps"
          : this.addonTarget !== undefined
            ? "addons"
            : this.category !== undefined
              ? slugCategory(this.category)
              : "language";
      const next = this.#visibleCategory(requested) ? requested : "language";
      if (next !== this.activeCategory) {
        this.activeCategory = next;
        this.#editCampaign = next === "appearance" ? this.campaign : undefined;
        this.editingId = null;
        this.deleteId = null;
        this.writeError = "";
        this.#setDirty(false);
      }
    }
    if (
      changed.has("canManageCampaign") &&
      !this.canManageCampaign &&
      this.activeCategory !== "language" &&
      this.activeCategory !== "addons"
    ) {
      this.activeCategory = "language";
      this.editingId = null;
      this.deleteId = null;
      this.#editCampaign = undefined;
      this.#setDirty(false);
    }
  }

  protected override render() {
    if (this.campaign === undefined) return nothing;
    const campaign = this.#editCampaign ?? this.campaign;
    if (this.activeCategory === "language") return this.#shell(this.#languagePanel());
    if (this.activeCategory === "appearance") return this.#shell(this.#appearancePanel());
    if (this.activeCategory === "addons")
      return this.#shell(html`<codex-addon-manager .csrfToken=${this.csrfToken}
      .registry=${this.registry} .actorRole=${this.actorRole} .canManage=${this.canManageCampaign}
      .addonTarget=${this.addonTarget}></codex-addon-manager>`);
    if (!this.canManageCampaign) return this.#shell(this.#languagePanel());
    if (this.activeCategory === "account")
      return this.#shell(html`<codex-credential-settings .csrfToken=${this.csrfToken}
      @campaign-edit-dirty=${this.#onSystemSaving}></codex-credential-settings>`);
    if (this.activeCategory === "backup")
      return this.#shell(html`<codex-recovery-settings .csrfToken=${this.csrfToken}
      @campaign-edit-dirty=${this.#onSystemSaving}></codex-recovery-settings>`);
    if (this.activeCategory === "sidebar")
      return this.#shell(
        html`<codex-sidebar-settings .campaign=${this.campaign} .addonPages=${this.addonPages} .busy=${this.busy}></codex-sidebar-settings>`,
      );
    if (this.activeCategory === "playerParty")
      return this.#shell(
        html`<codex-party-settings .campaign=${this.campaign} .busy=${this.busy}></codex-party-settings>`,
      );
    if (this.activeCategory === "maps")
      return this.#shell(html`<codex-map-settings .campaign=${this.campaign}
      .initialParentId=${this.mapTarget ?? null} .busy=${this.busy}></codex-map-settings>`);
    const descriptor = campaignEnumDescriptor(this.activeCategory);
    let items: readonly CampaignEnumItem[];
    try {
      items = campaignEnumItems(campaign, descriptor.category);
    } catch (cause: unknown) {
      const message =
        cause instanceof CampaignSettingsEditError
          ? uiText("This category has an invalid stored shape and was left untouched.")
          : uiText("This category could not be opened.");
      return this.#shell(
        html`<section class="settings-invalid" role="alert"><h2>${descriptor.label}</h2><p>${message}</p></section>`,
      );
    }
    const record = campaignEnumRecord(campaign, descriptor.category);
    return this.#shell(html`
      <section class="settings-ledger" aria-labelledby="settings-category-title">
        <header class="settings-ledger-heading">
          <div>
            <span class="settings-category-mark" aria-hidden="true">${descriptor.icon}</span>
            <div>
              <h2 id="settings-category-title">${descriptor.label}</h2>
              <p>${descriptor.summary}</p>
            </div>
          </div>
          <button type="button" @click=${this.#startCreate} ?disabled=${this.#locked || this.editingId !== null}>
            ${uiText("Add {0}", { "0": descriptor.singular })}
          </button>
        </header>
        ${this.editingId === null && this.deleteId === null ? saveFailure(this.writeError) : nothing}
        ${this.editingId === "__new__" ? this.#editForm(undefined, record?.revision ?? 0) : nothing}
        ${
          items.length === 0 && this.editingId !== "__new__"
            ? html`<div class="settings-empty">
                <p>${uiText("No {0} are defined yet.", { "0": descriptor.label.toLocaleLowerCase() })}</p>
                <p class="settings-hint">${uiText("Adds {0} common entries that you can edit or delete afterwards.", { "0": campaignEnumStarter(descriptor.category).length })}</p>
                <button type="button" ?disabled=${this.#locked} @click=${() => this.#addStarter(descriptor.category, record?.revision ?? 0)}>${uiText("Add a starter set")}</button>
              </div>`
            : html`<div class="settings-definition-list">
              ${items.map((item) =>
                this.editingId === item.id
                  ? this.#editForm(item, record?.revision ?? 0)
                  : this.#definitionRow(item, record?.revision ?? 0, items),
              )}
            </div>`
        }
      </section>
    `);
  }

  #shell(content: unknown) {
    type Group = "personal" | "campaign" | "vocabulary" | "system";
    const categories: readonly {
      readonly id: SettingsCategory;
      readonly label: string;
      readonly icon: string;
      readonly group: Group;
    }[] = [
      { id: "language", label: this.#ui.t("settings.language"), icon: "文", group: "personal" },
      ...(!this.canManageCampaign &&
      (this.#contributions.list("settings").length > 0 || this.activeCategory === "addons")
        ? [
            {
              id: "addons" as const,
              label: this.#ui.t("addons.title"),
              icon: "🧩",
              group: "system" as const,
            },
          ]
        : []),
      ...(this.canManageCampaign
        ? [
            {
              id: "appearance" as const,
              label: this.#ui.t("settings.appearance"),
              icon: "◐",
              group: "campaign" as const,
            },
            {
              id: "maps" as const,
              label: this.#ui.t("map.settings"),
              icon: "🗺",
              group: "campaign" as const,
            },
            {
              id: "playerParty" as const,
              label: this.#ui.t("settings.playerParty"),
              icon: "🛡",
              group: "campaign" as const,
            },
            {
              id: "sidebar" as const,
              label: this.#ui.t("sidebar.title"),
              icon: "🧭",
              group: "campaign" as const,
            },
            ...campaignEnumDescriptors.map((descriptor) => ({
              id: descriptor.category as SettingsCategory,
              label: descriptor.label,
              icon: descriptor.icon,
              group: "vocabulary" as const,
            })),
            {
              id: "addons" as const,
              label: this.#ui.t("addons.title"),
              icon: "🧩",
              group: "system" as const,
            },
            {
              id: "account" as const,
              label: this.#ui.t("credentials.title"),
              icon: "🖥",
              group: "system" as const,
            },
            {
              id: "backup" as const,
              label: this.#ui.t("recovery.title"),
              icon: "💾",
              group: "system" as const,
            },
          ]
        : []),
    ];
    const groups = (["personal", "campaign", "vocabulary", "system"] as const)
      .map((group) => ({ group, items: categories.filter((category) => category.group === group) }))
      .filter(({ items }) => items.length);
    const groupLabels = {
      personal: "settings.groupPersonal",
      campaign: "settings.groupCampaign",
      vocabulary: "settings.groupVocabulary",
      system: "settings.groupSystem",
    } as const;
    const busy = this.#locked || this.#credentialsSaving;
    const detail =
      this.category !== undefined || this.addonTarget !== undefined || this.mapTarget !== undefined;
    return html`
      <section class=${`settings-page ${detail ? "is-detail" : "is-index"}`}>
        <header class="settings-page-heading">
          <p class="page-kicker">${this.#ui.t("settings.kicker")}</p>
          <h1>${this.#ui.t("settings.title")}</h1>
          <p>${this.#ui.t(this.canManageCampaign ? "settings.intro" : "settings.introPlayer")}</p>
        </header>
        <a class="settings-back" href="#/settings">← ${this.#ui.t("settings.allSettings")}</a>
        <div class="settings-workspace">
          <nav class="settings-index" aria-label=${this.#ui.t("settings.categories")}>
            ${groups.map(
              ({ group, items }) => html`
              ${groups.length > 1 ? html`<p class="settings-index-group" aria-hidden="true">${this.#ui.t(groupLabels[group])}</p>` : nothing}
              ${items.map(
                (category) => html`
                <a href=${categoryHash(category.id)} data-category=${category.id}
                  aria-current=${category.id === this.activeCategory ? "page" : nothing}
                  aria-disabled=${busy ? "true" : nothing}
                  @click=${(event: Event) => {
                    if (busy) event.preventDefault();
                  }}>
                  <span aria-hidden="true">${category.icon}</span>
                  <span>${category.label}</span>
                </a>
              `,
              )}`,
            )}
          </nav>
          ${content}
        </div>
      </section>`;
  }

  #languagePanel() {
    return html`
      <section class="settings-ledger settings-personal-panel" aria-labelledby="settings-language-title">
        <header class="settings-ledger-heading">
          <div>
            <span class="settings-category-mark" aria-hidden="true">文</span>
            <div>
              <h2 id="settings-language-title">${this.#ui.t("settings.language")}</h2>
              <p>${this.#ui.t("settings.languageIntro")}</p>
            </div>
          </div>
        </header>
        <label class="settings-preference-field">
          <span>${this.#ui.t("settings.languageLabel")}</span>
          <select @change=${this.#changeLocale}>
            ${availableUiLocales.map(
              (locale) => html`
              <option value=${locale.id} ?selected=${locale.id === this.#ui.locale}>${locale.endonym}</option>`,
            )}
          </select>
        </label>
        <p class="settings-progress-note">${this.#ui.t("settings.languageProgress")}</p>
      </section>`;
  }

  #appearancePanel() {
    if (this.campaign === undefined || !this.canManageCampaign) return nothing;
    const current = this.#pendingTheme ?? campaignTheme(this.campaign);
    return html`
      <section class="settings-ledger settings-personal-panel" aria-labelledby="settings-appearance-title">
        <header class="settings-ledger-heading">
          <div>
            <span class="settings-category-mark" aria-hidden="true">◐</span>
            <div>
              <h2 id="settings-appearance-title">${this.#ui.t("settings.appearance")}</h2>
              <p>${this.#ui.t("settings.appearanceIntro")}</p>
            </div>
          </div>
        </header>
        <form class="settings-theme-form" @submit=${(event: Event) => event.preventDefault()}>
          <fieldset ?disabled=${this.#locked}>
            <legend>${this.#ui.t("settings.appearanceLabel")}</legend>
            <div class="settings-theme-list">
              ${campaignThemes.map(
                (theme) => html`
                <label class=${`settings-theme-choice theme-sample-${theme.id}`}>
                  <input type="radio" name="theme" value=${theme.id} .checked=${live(theme.id === current)}
                    @change=${() => void this.#applyTheme(theme.id)} />
                  <span class="settings-theme-sample" aria-hidden="true"><i></i><b></b><em></em></span>
                  <span><strong>${this.#ui.t(theme.labelKey)}</strong><small>${this.#ui.t(theme.hintKey)}</small></span>
                </label>`,
              )}
            </div>
          </fieldset>
          <p class="settings-hint" role="status">${this.writing ? this.#ui.t("settings.saving") : this.#ui.t("settings.themeApplies")}</p>
          ${saveFailure(this.writeError)}
        </form>
        <codex-branding-settings .campaign=${this.campaign} .busy=${this.busy}></codex-branding-settings>
      </section>`;
  }

  #definitionRow(item: CampaignEnumItem, revision: number, items: readonly CampaignEnumItem[]) {
    const descriptor = campaignEnumDescriptor(this.#activeEnumCategory());
    const usage = campaignEnumUsageCount(
      this.#editCampaign ?? this.campaign!,
      descriptor.category,
      item.id,
    );
    const color = firstColor(item.value);
    return html`
      <article class="settings-definition">
        <div class="settings-definition-identity">
          ${
            color === undefined
              ? html`<span class="settings-definition-glyph" aria-hidden="true">${itemIcon(item)}</span>`
              : html`
            <span class="settings-definition-swatch" style=${`--setting-color: ${color}`} aria-hidden="true"></span>`
          }
          <div><h3>${item.label || item.id}</h3><code>${item.id}</code></div>
        </div>
        <p class="settings-definition-usage">${usage === 0 ? uiText("Not used") : this.#ui.plural("settings.usedRecords", usage)}</p>
        <div class="settings-definition-actions">
          <button type="button" data-id=${item.id} @click=${this.#startEdit} ?disabled=${this.#locked || this.editingId !== null}>${uiText("Edit")}</button>
          <button class="danger-text" type="button" data-id=${item.id} @click=${this.#requestDelete}
            ?disabled=${this.#locked || this.editingId !== null}>${uiText("Delete")}</button>
        </div>
      </article>
      ${this.deleteId === item.id ? this.#deletePanel(item, revision, items, usage) : nothing}
    `;
  }

  #editForm(item: CampaignEnumItem | undefined, expectedRevision: number) {
    const descriptor = campaignEnumDescriptor(this.#activeEnumCategory());
    const values = item?.value ?? newItemDefaults(descriptor.category);
    return html`
      <form class="settings-edit-form" @submit=${this.#save} @input=${this.#markDirty}>
        <header>
          <div>
            <h3>${item === undefined ? uiText("New {0}", { "0": descriptor.singular }) : uiText("Edit {0}", { "0": item.label || item.id })}</h3>
            <p>${
              item === undefined
                ? uiText(
                    "Choose a permanent ID before saving. It becomes the value stored on campaign records.",
                  )
                : html`${uiText("Stored ID:")} <code>${item.id}</code>`
            }</p>
          </div>
        </header>
        <div class="settings-edit-grid">
          ${
            item === undefined
              ? html`
            <label><span>${uiText("Permanent ID")}</span><input name="id" maxlength="200" required
              autocomplete="off" placeholder=${uiText("short-stable-id")} /></label>
          `
              : nothing
          }
          ${descriptor.fields.map((definition) => this.#settingField(definition, values))}
        </div>
        ${saveFailure(this.writeError)}
        <div class="settings-edit-actions">
          <button type="button" @click=${this.#cancelEdit} ?disabled=${this.#locked}>${uiText("Cancel")}</button>
          <button class="primary" type="submit" ?disabled=${this.#locked}>${this.writing ? uiText("Saving…") : uiText("Save definition")}</button>
        </div>
        <input type="hidden" name="expectedRevision" value=${String(expectedRevision)} />
      </form>`;
  }

  #settingField(definition: CampaignSettingField, values: Readonly<Record<string, unknown>>) {
    const raw = values[definition.key];
    if (definition.kind === "select")
      return html`
      <label><span>${definition.label}</span><select name=${definition.key} ?required=${definition.required === true}>
        ${definition.options?.map(
          (option) => html`
          <option value=${option.value} ?selected=${option.value === text(raw)}>${option.label}</option>`,
        )}
      </select>${fieldHelp(definition)}</label>`;
    if (definition.kind === "directions") {
      const selected = new Set(
        Array.isArray(raw)
          ? raw.filter((candidate): candidate is string => typeof candidate === "string")
          : [],
      );
      return html`
        <fieldset class="settings-direction-field"><legend>${definition.label}</legend>
          ${directionOptions.map(
            (option) => html`<label><input type="checkbox" name=${definition.key}
            value=${option.value} .checked=${selected.has(option.value)} /><span>${option.label}</span></label>`,
          )}
          ${fieldHelp(definition)}
        </fieldset>`;
    }
    const numeric = definition.kind === "integer" || definition.kind === "decimal";
    const color = definition.kind === "color" ? cssHexColor(raw) : undefined;
    return html`
      <label class=${definition.kind === "color" ? "settings-color-field" : ""}>
        <span>${definition.label}</span>
        ${color === undefined ? nothing : html`<i style=${`--setting-color: ${color}`} aria-hidden="true"></i>`}
        <input name=${definition.key} type=${numeric ? "number" : "text"}
          step=${definition.kind === "decimal" ? "0.05" : definition.kind === "integer" ? "1" : nothing}
          min=${definition.minimum ?? nothing} max=${definition.maximum ?? nothing}
          maxlength=${numeric ? nothing : definition.key === "icon" ? 16 : 200}
          .value=${inputValue(raw)} ?required=${definition.required === true}
          pattern=${definition.kind === "color" ? "#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?" : nothing} />
        ${fieldHelp(definition)}
      </label>`;
  }

  #deletePanel(
    item: CampaignEnumItem,
    expectedRevision: number,
    items: readonly CampaignEnumItem[],
    usage: number,
  ) {
    const replacements = items.filter(({ id }) => id !== item.id);
    // A relationship's type is part of its identity, so its uses are deleted
    // with the type rather than re-pointed.
    const relationships = this.activeCategory === "relationshipTypes";
    return html`
      <section class="settings-delete-panel" aria-labelledby=${`delete-${item.id}`}>
        ${saveFailure(this.writeError)}
        <div><h3 id=${`delete-${item.id}`}>${uiText("Delete {0}?", { "0": item.label || item.id })}</h3>
          <p>${
            usage === 0
              ? uiText("The definition is not used by any campaign record.")
              : this.#ui.plural(
                  relationships ? "settings.deleteRelationships" : "settings.replaceRecords",
                  usage,
                )
          }</p></div>
        ${
          usage === 0
            ? html`
          <div class="settings-delete-actions">
            <button type="button" @click=${this.#cancelDelete}>${uiText("Keep it")}</button>
            <button class="danger" type="button" data-id=${item.id} data-revision=${String(expectedRevision)}
              data-mode="reject-if-used" @click=${this.#delete}>${uiText("Delete definition")}</button>
          </div>
        `
            : relationships
              ? html`
          <div class="settings-delete-actions">
            <button type="button" @click=${this.#cancelDelete}>${uiText("Keep it")}</button>
            <button class="danger" type="button" data-id=${item.id} data-revision=${String(expectedRevision)}
              data-mode="clear" @click=${this.#delete}>${uiText("Delete type and relationships")}</button>
          </div>
        `
              : html`
          <label class="settings-replacement"><span>${uiText("Replacement")}</span>
            <select id=${`replacement-${item.id}`} ?disabled=${replacements.length === 0}>
              ${replacements.map((replacement) => html`<option value=${replacement.id}>${replacement.label || replacement.id}</option>`)}
            </select>
          </label>
          <div class="settings-delete-actions split">
            <button type="button" @click=${this.#cancelDelete}>${uiText("Cancel")}</button>
            <button type="button" data-id=${item.id} data-revision=${String(expectedRevision)} data-mode="replace"
              @click=${this.#delete} ?disabled=${replacements.length === 0}>${uiText("Replace uses and delete")}</button>
            <button class="danger" type="button" data-id=${item.id} data-revision=${String(expectedRevision)}
              data-mode="clear" @click=${this.#delete}>${uiText("Clear uses and delete")}</button>
          </div>
        `
        }
      </section>`;
  }

  /** Account and backup requests keep the other categories closed while they save. */
  readonly #onSystemSaving = (event: CustomEvent<{ saving?: boolean }>): void => {
    this.#credentialsSaving = event.detail.saving === true;
    this.requestUpdate();
  };

  /** No new write starts while any write runs, this view's own included. */
  get #locked(): boolean {
    return this.busy || this.writing;
  }

  readonly #startCreate = (): void => {
    if (this.#locked || this.editingId !== null) return;
    this.#editCampaign = this.campaign;
    this.deleteId = null;
    this.writeError = "";
    this.editingId = "__new__";
  };

  readonly #startEdit = (event: Event): void => {
    if (this.#locked || this.editingId !== null) return;
    this.#editCampaign = this.campaign;
    this.deleteId = null;
    this.writeError = "";
    this.editingId = (event.currentTarget as HTMLButtonElement).dataset["id"] ?? null;
  };

  readonly #cancelEdit = (): void => {
    if (this.#locked || !this.#confirmDiscard()) return;
    this.editingId = null;
    this.writeError = "";
    this.#editCampaign = undefined;
  };

  readonly #requestDelete = (event: Event): void => {
    if (this.#locked || this.editingId !== null) return;
    this.#editCampaign = this.campaign;
    this.writeError = "";
    this.deleteId = (event.currentTarget as HTMLButtonElement).dataset["id"] ?? null;
  };

  readonly #cancelDelete = (): void => {
    if (!this.#locked) {
      this.deleteId = null;
      this.writeError = "";
      this.#editCampaign = undefined;
    }
  };

  /** Saves for this view and reports whether the write was confirmed. */
  async #write<K extends CampaignWriteKind>(kind: K, detail: CampaignWrites[K]): Promise<boolean> {
    const category = this.activeCategory;
    this.writing = true;
    this.writeError = "";
    const result = await saveCampaign(this, kind, detail);
    this.writing = false;
    if (!this.isConnected || this.activeCategory !== category) return false;
    if (!result.ok) this.writeError = result.message;
    return result.ok;
  }

  readonly #save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (
      this.#locked ||
      this.campaign === undefined ||
      this.editingId === null ||
      !isEnumCategory(this.activeCategory)
    )
      return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const descriptor = campaignEnumDescriptor(this.activeCategory);
    const fields: Record<string, unknown> = {};
    if (this.editingId === "__new__") fields["id"] = formText(data, "id");
    for (const definition of descriptor.fields) {
      fields[definition.key] =
        definition.kind === "directions"
          ? formTextValues(data, definition.key)
          : formText(data, definition.key);
    }
    const detail: CampaignEnumSaveDetail = Object.freeze({
      category: descriptor.category,
      originalId: this.editingId === "__new__" ? null : this.editingId,
      expectedRevision: Number(data.get("expectedRevision")),
      fields: Object.freeze(fields),
    });
    const editing = this.editingId;
    if ((await this.#write("enum", detail)) && this.editingId === editing) {
      this.editingId = null;
      this.#editCampaign = undefined;
      this.#setDirty(false);
    }
  };

  readonly #delete = async (event: Event): Promise<void> => {
    if (this.#locked || this.campaign === undefined || !isEnumCategory(this.activeCategory)) return;
    const button = event.currentTarget as HTMLButtonElement;
    const itemId = button.dataset["id"];
    const mode = button.dataset["mode"];
    if (
      itemId === undefined ||
      (mode !== "reject-if-used" && mode !== "replace" && mode !== "clear")
    )
      return;
    let detail: CampaignEnumDeleteMutation;
    if (mode === "replace") {
      const replacementId =
        this.querySelector<HTMLSelectElement>(`#replacement-${CSS.escape(itemId)}`)?.value ?? "";
      if (replacementId === "") return;
      detail = {
        category: this.activeCategory,
        itemId,
        expectedRevision: Number(button.dataset["revision"]),
        mode,
        replacementId,
      };
    } else {
      detail = {
        category: this.activeCategory,
        itemId,
        expectedRevision: Number(button.dataset["revision"]),
        mode,
      };
    }
    if (await this.#write("enum-delete", Object.freeze(detail))) {
      this.deleteId = null;
      this.#editCampaign = undefined;
    }
  };

  readonly #markDirty = (): void => {
    this.#setDirty(true);
  };

  readonly #changeLocale = (event: Event): void => {
    const locale = (event.currentTarget as HTMLSelectElement).value;
    if (locale === "en" || locale === "cs") this.#ui.setLocale(locale);
  };

  #addStarter(category: CampaignEnumCategory, expectedRevision: number): void {
    if (this.#locked || !this.canManageCampaign) return;
    void this.#write("enum-starter", Object.freeze({ category, expectedRevision }));
  }

  /** A theme is a reversible shared choice, so it saves as soon as it is picked. */
  async #applyTheme(theme: CampaignThemeID): Promise<void> {
    if (this.#locked || this.campaign === undefined || !this.canManageCampaign) return;
    if (theme === campaignTheme(this.campaign)) return;
    this.#pendingTheme = theme;
    const detail: CampaignAppearanceSaveDetail = Object.freeze({
      theme,
      expectedRevision: campaignAppearanceRecord(this.campaign)?.revision ?? 0,
    });
    await this.#write("appearance", detail);
    this.#pendingTheme = undefined;
    this.requestUpdate();
  }

  #visibleCategory(category: SettingsCategory): boolean {
    return (
      category === "language" ||
      (category === "addons" && this.#contributions.list("settings").length > 0) ||
      (this.canManageCampaign &&
        (category === "appearance" ||
          category === "maps" ||
          category === "playerParty" ||
          category === "sidebar" ||
          category === "addons" ||
          category === "account" ||
          category === "backup" ||
          isEnumCategory(category)))
    );
  }

  #activeEnumCategory(): CampaignEnumCategory {
    if (!isEnumCategory(this.activeCategory)) {
      throw new CampaignSettingsEditError("campaign enum category is not active");
    }
    return this.activeCategory;
  }

  #confirmDiscard(): boolean {
    const edits = this.registry?.edits.state();
    if (this.#locked || this.#credentialsSaving || edits?.saving) return false;
    if (
      !confirmDiscardUnsavedEdit(this.#dirty || edits?.dirty === true, (message) =>
        window.confirm(message),
      )
    )
      return false;
    this.#setDirty(false);
    return true;
  }

  #setDirty(dirty: boolean): void {
    if (dirty === this.#dirty) return;
    this.#dirty = dirty;
    this.requestUpdate();
    reportEditState(this, { dirty });
  }
}

function isEnumCategory(category: SettingsCategory): category is CampaignEnumCategory {
  return campaignEnumDescriptors.some((descriptor) => descriptor.category === category);
}

const directionOptions = Object.freeze([
  Object.freeze({
    value: "from",
    get label() {
      return uiText("Character → target");
    },
  }),
  Object.freeze({
    value: "to",
    get label() {
      return uiText("Target → character");
    },
  }),
  Object.freeze({
    value: "both",
    get label() {
      return uiText("Both directions");
    },
  }),
]);

function newItemDefaults(category: CampaignEnumCategory): Readonly<Record<string, unknown>> {
  switch (category) {
    case "relationshipTypes":
      return Object.freeze({
        label: "",
        color: "#555555",
        style: "solid",
        target: "character",
        dirs: ["from", "to", "both"],
      });
    case "genders":
      return Object.freeze({ label: "" });
    case "pinTypes":
      return Object.freeze({ label: "", defaultIconId: "", size: 28 });
    case "characterStatuses":
      return Object.freeze({ label: "", icon: "●", color: "#555555" });
    case "eventPriorities":
      return Object.freeze({ label: "", color: "#555555" });
    case "attitudes":
      return Object.freeze({
        label: "",
        bg: "#555555",
        fg: "#ffffff",
        labelColor: "#777777",
        strength: 1,
      });
  }
}

function firstColor(value: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["labelColor", "color", "bg"]) {
    const color = cssHexColor(value[key]);
    if (color !== undefined) return color;
  }
  return undefined;
}

function itemIcon(item: CampaignEnumItem): string {
  const icon = text(item.value["icon"]);
  return icon === "" ? ((item.label || item.id)[0]?.toLocaleUpperCase() ?? "·") : icon;
}

function fieldHelp(field: CampaignSettingField) {
  return field.help === undefined ? nothing : html`<small>${field.help}</small>`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function inputValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

if (!customElements.get("codex-settings")) customElements.define("codex-settings", CodexSettings);
