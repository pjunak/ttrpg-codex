import { LitElement, html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import type { CampaignEnumCategory, CampaignEnumDeleteMutation } from "../core/campaign-mutations.js";
import {
  campaignEnumDescriptor,
  campaignEnumDescriptors,
  campaignEnumItems,
  campaignEnumRecord,
  campaignEnumUsageCount,
  CampaignSettingsEditError,
  type CampaignEnumItem,
  type CampaignEnumSaveDetail,
  type CampaignSettingField,
} from "./campaign-settings.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";
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
import type { BrowserNavigationEntry } from "../addons/navigation.js";

type SettingsCategory = "language" | "appearance" | "maps" | "playerParty" | "sidebar" | "addons" | "account" | CampaignEnumCategory;

export class CodexSettings extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    mapTarget: { attribute: false },
    canManageCampaign: { type: Boolean, attribute: false },
    saving: { type: Boolean },
    editCompletion: { type: Number },
    activeCategory: { state: true },
    addonPages: { attribute: false },
    csrfToken: { attribute: false },
    editingId: { state: true },
    deleteId: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare mapTarget: string | null | undefined;
  declare canManageCampaign: boolean;
  declare saving: boolean;
  declare editCompletion: number;
  declare private activeCategory: SettingsCategory;
  declare private editingId: string | null | "__new__";
  declare private deleteId: string | null;
  declare addonPages: readonly BrowserNavigationEntry[];
  declare csrfToken: string;
  readonly #ui = new UiLocalizationController(this);
  #dirty = false;
  #credentialsSaving = false;
  #brandingDirty = false;
  #editCampaign: CampaignDataset | undefined;

  constructor() {
    super();
    this.addonPages = [];
    this.campaign = undefined;
    this.mapTarget = undefined;
    this.canManageCampaign = false;
    this.saving = false;
    this.editCompletion = 0;
    this.activeCategory = "language";
    this.editingId = null;
    this.deleteId = null;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment { return this; }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if ((changed.has("mapTarget") || changed.has("canManageCampaign")) && this.mapTarget !== undefined && this.canManageCampaign) {
      this.activeCategory = "maps";
    }
    if (changed.has("canManageCampaign") && !this.canManageCampaign && this.activeCategory !== "language") {
      this.activeCategory = "language";
      this.editingId = null;
      this.deleteId = null;
      this.#editCampaign = undefined;
      this.#setDirty(false);
    }
    if (changed.has("editCompletion")) {
      this.editingId = null;
      this.deleteId = null;
      this.#editCampaign = this.activeCategory === "appearance" ? this.campaign : undefined;
      this.#setDirty(false);
    }
  }

  protected override render() {
    if (this.campaign === undefined) return nothing;
    const campaign = this.#editCampaign ?? this.campaign;
    if (this.activeCategory === "language") return this.#shell(this.#languagePanel());
    if (this.activeCategory === "appearance") return this.#shell(this.#appearancePanel());
    if (!this.canManageCampaign) return this.#shell(this.#languagePanel());
    if (this.activeCategory === "account") return this.#shell(html`<codex-credential-settings .csrfToken=${this.csrfToken}
      @campaign-edit-dirty=${(event: CustomEvent<{ dirty: boolean; saving?: boolean }>) => {
        this.#dirty = event.detail.dirty; this.#credentialsSaving = event.detail.saving === true; this.requestUpdate();
      }}></codex-credential-settings>`);
    if (this.activeCategory === "addons") return this.#shell(html`<codex-addon-manager .csrfToken=${this.csrfToken}></codex-addon-manager>`);
    if (this.activeCategory === "sidebar") return this.#shell(html`<codex-sidebar-settings .campaign=${this.campaign} .addonPages=${this.addonPages} .saving=${this.saving} .editCompletion=${this.editCompletion}
      @campaign-edit-dirty=${(event: CustomEvent<{ dirty: boolean }>) => { this.#dirty = event.detail.dirty; }}></codex-sidebar-settings>`);
    if (this.activeCategory === "playerParty") return this.#shell(html`<codex-party-settings
      .campaign=${this.campaign} .saving=${this.saving} .editCompletion=${this.editCompletion}
      @campaign-edit-dirty=${(event: CustomEvent<{ dirty: boolean }>) => { this.#dirty = event.detail.dirty; }}
    ></codex-party-settings>`);
    if (this.activeCategory === "maps") return this.#shell(html`<codex-map-settings .campaign=${this.campaign}
      .initialParentId=${this.mapTarget ?? null} .saving=${this.saving} .editCompletion=${this.editCompletion}
      @campaign-edit-dirty=${(event: CustomEvent<{ dirty: boolean }>) => { this.#dirty = event.detail.dirty; }}></codex-map-settings>`);
    const descriptor = campaignEnumDescriptor(this.activeCategory);
    let items: readonly CampaignEnumItem[];
    try {
      items = campaignEnumItems(campaign, descriptor.category);
    } catch (cause: unknown) {
      const message = cause instanceof CampaignSettingsEditError
        ? "This category has an invalid stored shape and was left untouched."
        : "This category could not be opened.";
      return this.#shell(html`<section class="settings-invalid" role="alert"><h2>${descriptor.label}</h2><p>${message}</p></section>`);
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
          <button type="button" @click=${this.#startCreate} ?disabled=${this.saving || this.editingId !== null}>
            Add ${descriptor.singular}
          </button>
        </header>
        ${this.editingId === "__new__" ? this.#editForm(undefined, record?.revision ?? 0) : nothing}
        ${items.length === 0 && this.editingId !== "__new__"
          ? html`<p class="settings-empty">No ${descriptor.label.toLocaleLowerCase()} are defined yet.</p>`
          : html`<div class="settings-definition-list">
              ${items.map((item) => this.editingId === item.id
                ? this.#editForm(item, record?.revision ?? 0)
                : this.#definitionRow(item, record?.revision ?? 0, items))}
            </div>`}
      </section>
    `);
  }

  #shell(content: unknown) {
    const categories: readonly { readonly id: SettingsCategory; readonly label: string; readonly icon: string }[] = [
      { id: "language", label: this.#ui.t("settings.language"), icon: "文" },
      ...(this.canManageCampaign ? [
        { id: "appearance" as const, label: this.#ui.t("settings.appearance"), icon: "◐" },
        { id: "maps" as const, label: this.#ui.t("map.settings"), icon: "🗺" },
        { id: "playerParty" as const, label: this.#ui.t("settings.playerParty"), icon: "🛡" },
        { id: "sidebar" as const, label: this.#ui.t("sidebar.title"), icon: "🧭" },
        { id: "addons" as const, label: this.#ui.t("addons.title"), icon: "🧩" },
        { id: "account" as const, label: this.#ui.t("credentials.title"), icon: "🖥" },
        ...campaignEnumDescriptors.map((descriptor) => ({
          id: descriptor.category as SettingsCategory,
          label: descriptor.label,
          icon: descriptor.icon,
        })),
      ] : []),
    ];
    return html`
      <section class="settings-page">
        <header class="settings-page-heading">
          <p class="page-kicker">${this.#ui.t("settings.kicker")}</p>
          <h1>${this.#ui.t("settings.title")}</h1>
          <p>${this.#ui.t("settings.intro")}</p>
        </header>
        <div class="settings-workspace">
          <nav class="settings-index" aria-label=${this.#ui.t("settings.categories")}>
            ${categories.map((category) => html`
              <button type="button" data-category=${category.id}
                aria-current=${category.id === this.activeCategory ? "page" : nothing}
                @click=${this.#selectCategory} ?disabled=${this.saving || this.#credentialsSaving}>
                <span aria-hidden="true">${category.icon}</span>
                <span>${category.label}</span>
              </button>
            `)}
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
            ${availableUiLocales.map((locale) => html`
              <option value=${locale.id} ?selected=${locale.id === this.#ui.locale}>${locale.endonym}</option>`)}
          </select>
        </label>
        <p class="settings-progress-note">${this.#ui.t("settings.languageProgress")}</p>
      </section>`;
  }

  #appearancePanel() {
    if (this.campaign === undefined || !this.canManageCampaign) return nothing;
    const campaign = this.#editCampaign ?? this.campaign;
    const record = campaignAppearanceRecord(campaign);
    const current = campaignTheme(campaign);
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
        <form class="settings-theme-form" @submit=${this.#saveAppearance} @input=${this.#markDirty}>
          <fieldset ?disabled=${this.saving || this.#brandingDirty}>
            <legend>${this.#ui.t("settings.appearanceLabel")}</legend>
            <div class="settings-theme-list">
              ${campaignThemes.map((theme) => html`
                <label class=${`settings-theme-choice theme-sample-${theme.id}`}>
                  <input type="radio" name="theme" value=${theme.id} .checked=${theme.id === current} />
                  <span class="settings-theme-sample" aria-hidden="true"><i></i><b></b><em></em></span>
                  <span><strong>${this.#ui.t(theme.labelKey)}</strong><small>${this.#ui.t(theme.hintKey)}</small></span>
                </label>`)}
            </div>
          </fieldset>
          <input type="hidden" name="expectedRevision" value=${String(record?.revision ?? 0)} />
          <div class="settings-edit-actions">
            <button class="primary" type="submit" ?disabled=${this.saving || this.#brandingDirty}>
              ${this.saving ? this.#ui.t("settings.saving") : this.#ui.t("settings.saveAppearance")}
            </button>
          </div>
        </form>
        <codex-branding-settings .campaign=${this.campaign} .saving=${this.saving} .blocked=${this.#dirty && !this.#brandingDirty} .editCompletion=${this.editCompletion}
          @campaign-edit-dirty=${(event: CustomEvent<{ dirty: boolean }>) => {
            event.stopPropagation();
            if (this.#brandingDirty || event.detail.dirty) this.#setDirty(event.detail.dirty);
            this.#brandingDirty = event.detail.dirty; this.requestUpdate();
          }}></codex-branding-settings>
      </section>`;
  }

  #definitionRow(item: CampaignEnumItem, revision: number, items: readonly CampaignEnumItem[]) {
    const descriptor = campaignEnumDescriptor(this.#activeEnumCategory());
    const usage = campaignEnumUsageCount(this.#editCampaign ?? this.campaign!, descriptor.category, item.id);
    const color = firstColor(item.value);
    return html`
      <article class="settings-definition">
        <div class="settings-definition-identity">
          ${color === undefined ? html`<span class="settings-definition-glyph" aria-hidden="true">${itemIcon(item)}</span>` : html`
            <span class="settings-definition-swatch" style=${`--setting-color: ${color}`} aria-hidden="true"></span>`}
          <div><h3>${item.label || item.id}</h3><code>${item.id}</code></div>
        </div>
        <p class="settings-definition-usage">${usage === 0 ? "Not used" : `Used by ${usage} record${usage === 1 ? "" : "s"}`}</p>
        <div class="settings-definition-actions">
          <button type="button" data-id=${item.id} @click=${this.#startEdit} ?disabled=${this.saving || this.editingId !== null}>Edit</button>
          <button class="danger-text" type="button" data-id=${item.id} @click=${this.#requestDelete}
            ?disabled=${this.saving || this.editingId !== null}>Delete</button>
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
            <h3>${item === undefined ? `New ${descriptor.singular}` : `Edit ${item.label || item.id}`}</h3>
            <p>${item === undefined
              ? "Choose a permanent ID before saving. It becomes the value stored on campaign records."
              : html`Stored ID: <code>${item.id}</code>`}</p>
          </div>
        </header>
        <div class="settings-edit-grid">
          ${item === undefined ? html`
            <label><span>Permanent ID</span><input name="id" maxlength="200" required
              autocomplete="off" placeholder="short-stable-id" /></label>
          ` : nothing}
          ${descriptor.fields.map((definition) => this.#settingField(definition, values))}
        </div>
        <div class="settings-edit-actions">
          <button type="button" @click=${this.#cancelEdit} ?disabled=${this.saving}>Cancel</button>
          <button class="primary" type="submit" ?disabled=${this.saving}>${this.saving ? "Saving…" : "Save definition"}</button>
        </div>
        <input type="hidden" name="expectedRevision" value=${String(expectedRevision)} />
      </form>`;
  }

  #settingField(definition: CampaignSettingField, values: Readonly<Record<string, unknown>>) {
    const raw = values[definition.key];
    if (definition.kind === "select") return html`
      <label><span>${definition.label}</span><select name=${definition.key} ?required=${definition.required === true}>
        ${definition.options?.map((option) => html`
          <option value=${option.value} ?selected=${option.value === text(raw)}>${option.label}</option>`)}
      </select>${fieldHelp(definition)}</label>`;
    if (definition.kind === "directions") {
      const selected = new Set(Array.isArray(raw) ? raw.filter((candidate): candidate is string => typeof candidate === "string") : []);
      return html`
        <fieldset class="settings-direction-field"><legend>${definition.label}</legend>
          ${directionOptions.map((option) => html`<label><input type="checkbox" name=${definition.key}
            value=${option.value} .checked=${selected.has(option.value)} /><span>${option.label}</span></label>`)}
          ${fieldHelp(definition)}
        </fieldset>`;
    }
    const numeric = definition.kind === "integer" || definition.kind === "decimal";
    const color = definition.kind === "color" ? normalizedColor(raw) : undefined;
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
    return html`
      <section class="settings-delete-panel" aria-labelledby=${`delete-${item.id}`}>
        <div><h3 id=${`delete-${item.id}`}>Delete ${item.label || item.id}?</h3>
          <p>${usage === 0
            ? "The definition is not used by any campaign record."
            : `${usage} campaign record${usage === 1 ? " uses" : "s use"} this definition. Choose how those records should change.`}</p></div>
        ${usage === 0 ? html`
          <div class="settings-delete-actions">
            <button type="button" @click=${this.#cancelDelete}>Keep it</button>
            <button class="danger" type="button" data-id=${item.id} data-revision=${String(expectedRevision)}
              data-mode="reject-if-used" @click=${this.#delete}>Delete definition</button>
          </div>
        ` : html`
          <label class="settings-replacement"><span>Replacement</span>
            <select id=${`replacement-${item.id}`} ?disabled=${replacements.length === 0}>
              ${replacements.map((replacement) => html`<option value=${replacement.id}>${replacement.label || replacement.id}</option>`)}
            </select>
          </label>
          <div class="settings-delete-actions split">
            <button type="button" @click=${this.#cancelDelete}>Cancel</button>
            <button type="button" data-id=${item.id} data-revision=${String(expectedRevision)} data-mode="replace"
              @click=${this.#delete} ?disabled=${replacements.length === 0}>Replace uses and delete</button>
            <button class="danger" type="button" data-id=${item.id} data-revision=${String(expectedRevision)}
              data-mode="clear" @click=${this.#delete}>Clear uses and delete</button>
          </div>
        `}
      </section>`;
  }

  readonly #selectCategory = (event: Event): void => {
    const category = (event.currentTarget as HTMLButtonElement).dataset["category"] as SettingsCategory | undefined;
    if (category === undefined || category === this.activeCategory || !this.#visibleCategory(category) ||
      !this.#confirmDiscard()) return;
    this.activeCategory = category;
    this.#editCampaign = category === "appearance" ? this.campaign : undefined;
    this.editingId = null;
    this.deleteId = null;
  };

  readonly #startCreate = (): void => {
    if (this.saving || this.editingId !== null) return;
    this.#editCampaign = this.campaign;
    this.deleteId = null;
    this.editingId = "__new__";
  };

  readonly #startEdit = (event: Event): void => {
    if (this.saving || this.editingId !== null) return;
    this.#editCampaign = this.campaign;
    this.deleteId = null;
    this.editingId = (event.currentTarget as HTMLButtonElement).dataset["id"] ?? null;
  };

  readonly #cancelEdit = (): void => {
    if (this.saving || !this.#confirmDiscard()) return;
    this.editingId = null;
    this.#editCampaign = undefined;
  };

  readonly #requestDelete = (event: Event): void => {
    if (this.saving || this.editingId !== null) return;
    this.#editCampaign = this.campaign;
    this.deleteId = (event.currentTarget as HTMLButtonElement).dataset["id"] ?? null;
  };

  readonly #cancelDelete = (): void => {
    if (!this.saving) {
      this.deleteId = null;
      this.#editCampaign = undefined;
    }
  };

  readonly #save = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.saving || this.campaign === undefined || this.editingId === null ||
      !isEnumCategory(this.activeCategory)) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const descriptor = campaignEnumDescriptor(this.activeCategory);
    const fields: Record<string, unknown> = {};
    if (this.editingId === "__new__") fields["id"] = String(data.get("id") ?? "");
    for (const definition of descriptor.fields) {
      fields[definition.key] = definition.kind === "directions"
        ? data.getAll(definition.key).map(String)
        : String(data.get(definition.key) ?? "");
    }
    const detail: CampaignEnumSaveDetail = Object.freeze({
      category: descriptor.category,
      originalId: this.editingId === "__new__" ? null : this.editingId,
      expectedRevision: Number(data.get("expectedRevision")),
      fields: Object.freeze(fields),
    });
    this.dispatchEvent(new CustomEvent<CampaignEnumSaveDetail>("campaign-enum-save", {
      detail, bubbles: true, composed: true,
    }));
  };

  readonly #delete = (event: Event): void => {
    if (this.saving || this.campaign === undefined || !isEnumCategory(this.activeCategory)) return;
    const button = event.currentTarget as HTMLButtonElement;
    const itemId = button.dataset["id"];
    const mode = button.dataset["mode"];
    if (itemId === undefined || (mode !== "reject-if-used" && mode !== "replace" && mode !== "clear")) return;
    let detail: CampaignEnumDeleteMutation;
    if (mode === "replace") {
      const replacementId = this.querySelector<HTMLSelectElement>(`#replacement-${CSS.escape(itemId)}`)?.value ?? "";
      if (replacementId === "") return;
      detail = { category: this.activeCategory, itemId,
        expectedRevision: Number(button.dataset["revision"]), mode, replacementId };
    } else {
      detail = { category: this.activeCategory, itemId,
        expectedRevision: Number(button.dataset["revision"]), mode };
    }
    this.dispatchEvent(new CustomEvent<CampaignEnumDeleteMutation>("campaign-enum-delete", {
      detail: Object.freeze(detail), bubbles: true, composed: true,
    }));
  };

  readonly #markDirty = (): void => { this.#setDirty(true); };

  readonly #changeLocale = (event: Event): void => {
    const locale = (event.currentTarget as HTMLSelectElement).value;
    if (locale === "en" || locale === "cs") this.#ui.setLocale(locale);
  };

  readonly #saveAppearance = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.saving || this.#brandingDirty || this.campaign === undefined || !this.canManageCampaign) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const theme = String(data.get("theme") ?? "") as CampaignThemeID;
    if (!campaignThemes.some(({ id }) => id === theme)) return;
    const detail: CampaignAppearanceSaveDetail = Object.freeze({
      theme,
      expectedRevision: Number(data.get("expectedRevision")),
    });
    this.dispatchEvent(new CustomEvent<CampaignAppearanceSaveDetail>("campaign-appearance-save", {
      detail, bubbles: true, composed: true,
    }));
  };

  #visibleCategory(category: SettingsCategory): boolean {
    return category === "language" || this.canManageCampaign &&
      (category === "appearance" || category === "maps" || category === "playerParty" || category === "sidebar" || category === "addons" || category === "account" || isEnumCategory(category));
  }

  #activeEnumCategory(): CampaignEnumCategory {
    if (!isEnumCategory(this.activeCategory)) {
      throw new CampaignSettingsEditError("campaign enum category is not active");
    }
    return this.activeCategory;
  }

  #confirmDiscard(): boolean {
    if (this.#credentialsSaving) return false;
    if (!confirmDiscardUnsavedEdit(this.#dirty, (message) => window.confirm(message))) return false;
    this.#setDirty(false);
    return true;
  }

  #setDirty(dirty: boolean): void {
    if (!dirty) this.#brandingDirty = false;
    if (dirty === this.#dirty) return;
    this.#dirty = dirty;
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent("campaign-edit-dirty", {
      detail: Object.freeze({ dirty }), bubbles: true, composed: true,
    }));
  }
}

function isEnumCategory(category: SettingsCategory): category is CampaignEnumCategory {
  return campaignEnumDescriptors.some(descriptor => descriptor.category === category);
}

const directionOptions = Object.freeze([
  Object.freeze({ value: "from", label: "Character → target" }),
  Object.freeze({ value: "to", label: "Target → character" }),
  Object.freeze({ value: "both", label: "Both directions" }),
]);

function newItemDefaults(category: CampaignEnumCategory): Readonly<Record<string, unknown>> {
  switch (category) {
    case "relationshipTypes": return Object.freeze({ label: "", color: "#555555", style: "solid", target: "character", dirs: ["from", "to", "both"] });
    case "genders": return Object.freeze({ label: "" });
    case "pinTypes": return Object.freeze({ label: "", defaultIconId: "", size: 28 });
    case "characterStatuses": return Object.freeze({ label: "", icon: "●", color: "#555555" });
    case "eventPriorities": return Object.freeze({ label: "", color: "#555555" });
    case "attitudes": return Object.freeze({ label: "", bg: "#555555", fg: "#ffffff", labelColor: "#777777", strength: 1 });
  }
}

function firstColor(value: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["labelColor", "color", "bg"]) {
    const color = normalizedColor(value[key]);
    if (color !== undefined) return color;
  }
  return undefined;
}

function itemIcon(item: CampaignEnumItem): string {
  const icon = text(item.value["icon"]);
  return icon === "" ? (item.label || item.id)[0]?.toLocaleUpperCase() ?? "·" : icon;
}

function normalizedColor(value: unknown): string | undefined {
  const candidate = text(value).toLowerCase();
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/u.test(candidate) ? candidate : undefined;
}

function fieldHelp(field: CampaignSettingField) {
  return field.help === undefined ? nothing : html`<small>${field.help}</small>`;
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function inputValue(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }

if (!customElements.get("codex-settings")) customElements.define("codex-settings", CodexSettings);
