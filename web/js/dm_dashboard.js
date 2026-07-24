// Core-owned, DM-guarded shell for the stable #/dm route.
//
// Workflow content is contributed through the additive dm:dashboard slot.
// With no successful contribution, core retains a small diagnostic fallback
// so addon failure never removes the DM's recovery route.

import { Store } from './store.js';
import { Role } from './role.js';
import { Addons } from './addons.js';
import { esc, dataAction } from './utils.js';
import { I18n } from './i18n.js';

export const DmDashboard = (() => {
  function html() {
    // Authorization precedes slot enumeration: an effective player,
    // anonymous visitor, or DM viewing as player never invokes addon code.
    if (!Role.isDM()) {
      return `
        <div class="dm-panel">
          <h1>🛡 ${esc(I18n.t('nav.dmPanel'))}</h1>
          <p class="dm-stub">${esc(I18n.t('dm.refusal'))}</p>
        </div>
      `;
    }

    const contributions = Addons.slotContent('dm:dashboard', {
      role: { isDM: true },
    });
    if (contributions.length) {
      return `
        <main class="dm-panel" aria-labelledby="dm-dashboard-title">
          <h1 id="dm-dashboard-title">🛡 ${esc(I18n.t('nav.dmPanel'))}</h1>
          <div id="dm-dashboard-contributions">
            ${contributions.map(item => `
              <div data-addon-id="${esc(item.addonId)}">${item.html}</div>
            `).join('')}
          </div>
        </main>
      `;
    }

    return _fallbackHtml();
  }

  function render() {
    const main = document.getElementById('main-content');
    if (!main) return;
    main.innerHTML = html();
  }

  function _fallbackHtml() {
    const counts = _dmOnlyCounts();
    const totalDm = counts.reduce((acc, count) => acc + count.dmOnly, 0);
    const addons = Addons.list();
    return `
      <main class="dm-panel" aria-labelledby="dm-dashboard-title">
        <h1 id="dm-dashboard-title">🛡 ${esc(I18n.t('nav.dmPanel'))}</h1>
        <p class="dm-stub">${esc(I18n.t('dm.fallbackIntro'))}</p>

        <section class="dm-section" aria-labelledby="dm-addon-health-title">
          <h2 id="dm-addon-health-title">${esc(I18n.t('dm.addonHealth'))}</h2>
          <p class="dm-section-hint">${esc(I18n.t('dm.addonHealthHint'))}</p>
          ${_addonDiagnosticsHtml(addons)}
          <a class="inline-create-btn" href="#/nastaveni"
            ${dataAction('Settings.selectCategory', 'addons')}>${esc(I18n.t('dm.openAddonManager'))}</a>
        </section>

        <section class="dm-section" aria-labelledby="dm-hidden-content-title">
          <h2 id="dm-hidden-content-title">${esc(I18n.t('dm.hiddenContent'))}</h2>
          <p class="dm-section-hint">
            ${totalDm === 0
              ? esc(I18n.t('dm.hiddenContentEmpty'))
              : esc(I18n.plural('dm.hiddenContentCount', totalDm))}
          </p>
          <div class="dm-grid">
            ${counts.map(_renderCountCard).join('')}
          </div>
        </section>
      </main>
    `;
  }

  function _addonDiagnosticsHtml(addons) {
    if (!addons.length) {
      return `<p class="settings-hint">${esc(I18n.t('dm.noAddons'))}</p>`;
    }
    return `<ul class="dm-addon-diagnostics">${addons.map(addon => {
      const slotFailure = Array.isArray(addon.slotFailures) ? addon.slotFailures[0] : null;
      const detail = addon.error || slotFailure?.message || '';
      return `<li>
        <strong>${esc(addon.name || addon.id || I18n.t('dm.unknownAddon'))}</strong>
        <span class="codex-badge${addon.state === 'ok' && !slotFailure ? ' codex-badge-accent' : ''}">${esc(_addonStateLabel(addon.state))}</span>
        ${detail ? `<span>${esc(detail)}</span>` : ''}
      </li>`;
    }).join('')}</ul>`;
  }

  function _addonStateLabel(state) {
    if (state === 'ok') return I18n.t('dm.addonStateOk');
    if (state === 'blocked') return I18n.t('dm.addonStateBlocked');
    if (state === 'error') return I18n.t('dm.addonStateError');
    return I18n.t('dm.addonStateUnknown');
  }

  function _dmOnlyCounts() {
    const out = [];
    const lists = [
      { key: 'characters', label: I18n.t('nav.characters'), route: '#/postavy', getter: Store.getCharacters },
      { key: 'locations', label: I18n.t('nav.locations'), route: '#/mista', getter: Store.getLocations },
      { key: 'events', label: I18n.t('dm.collEvents'), route: '#/casova-osa', getter: Store.getEvents },
      { key: 'mysteries', label: I18n.t('nav.mysteries'), route: '#/zahady', getter: Store.getMysteries },
      { key: 'pantheon', label: I18n.t('nav.pantheon'), route: '#/panteon', getter: Store.getPantheon },
      { key: 'artifacts', label: I18n.t('nav.artifacts'), route: '#/artefakty', getter: Store.getArtifacts },
      {
        key: 'historicalEvents',
        label: I18n.t('dm.collHistoricalEvents'),
        route: '#/historie',
        getter: Store.getHistoricalEvents,
      },
    ];
    for (const collection of lists) {
      let total = 0;
      let dmOnly = 0;
      const records = collection.getter ? collection.getter() : [];
      for (const record of records || []) {
        total++;
        if (record && record.visibility === 'dm') dmOnly++;
      }
      out.push({ ...collection, total, dmOnly });
    }

    const factions = Store.getFactions ? Store.getFactions() : {};
    let factionTotal = 0;
    let factionDmOnly = 0;
    for (const faction of Object.values(factions || {})) {
      factionTotal++;
      if (faction && faction.visibility === 'dm') factionDmOnly++;
    }
    out.push({
      key: 'factions',
      label: I18n.t('nav.factions'),
      route: '#/frakce',
      total: factionTotal,
      dmOnly: factionDmOnly,
    });
    return out;
  }

  function _renderCountCard(count) {
    const hasDm = count.dmOnly > 0;
    return `
      <a class="dm-count-card${hasDm ? ' has-dm' : ''}" href="${esc(count.route)}">
        <span class="dm-count-label">${esc(count.label)}</span>
        <span class="dm-count-numbers">
          <strong>${esc(I18n.formatNumber(count.dmOnly))}</strong> / ${esc(I18n.formatNumber(count.total))}
        </span>
        <span class="dm-count-meta">${esc(I18n.t('dm.onlyDmMeta'))}</span>
      </a>
    `;
  }

  return { render, html };
})();
