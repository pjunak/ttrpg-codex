import { createAddonImportClient } from './addon-imports.js';
import { I18n } from './i18n.js';
import { applyLocationAdjustments, buildStoryReview } from './import-review.js';
import { PinTypes } from './pin-types.js';
import { Role } from './role.js';
import { Store } from './store.js';
import { announce, dataAction, dataOn, esc, safeColor } from './utils.js';

const PROVIDER_ID = 'campaign-bundle';
const WORLD_MAP_IMAGE = '/maps/swordcoast/sword_coast.jpg';

export const ImportCenter = (() => {
  let _file = null;
  let _preview = null;
  let _result = null;
  let _error = null;
  let _busy = '';
  let _confirmed = false;
  let _jobId = '';
  let _generation = 0;
  let _storyGraph = null;
  let _storyReview = null;
  let _dragCleanup = null;
  const _mapAdjustments = new Map();

  const _client = createAddonImportClient({
    addonId: 'core',
    enabled: true,
    isDM: () => Role.isDM(),
  });

  function _main() {
    return document.getElementById('main-content');
  }

  function _json(value) {
    return esc(JSON.stringify(value, null, 2));
  }

  function _button(label, action, className = 'inline-create-btn', disabled = false, id = '') {
    return `<button type="button" class="${className}"${id ? ` id="${id}"` : ''}${dataAction(action)}${disabled ? ' disabled' : ''}>${label}</button>`;
  }

  function _severityLabel(severity) {
    if (severity === 'error') return I18n.t('import.severity.error');
    if (severity === 'warning') return I18n.t('import.severity.warning');
    return I18n.t('import.severity.info');
  }

  function _diagnosticsHtml(diagnostics = []) {
    if (!diagnostics.length) {
      return `<p class="import-empty">${esc(I18n.t('import.noDiagnostics'))}</p>`;
    }
    return `<ul class="import-diagnostics">${diagnostics.map(item => `
      <li class="is-${['error', 'warning', 'info'].includes(item.severity) ? item.severity : 'info'}">
        <div class="import-diagnostic-head">
          <span aria-hidden="true">${item.severity === 'error' ? '×' : item.severity === 'warning' ? '!' : 'i'}</span>
          <strong>${esc(_severityLabel(item.severity))}</strong>
          ${item.code ? `<code>${esc(item.code)}</code>` : ''}
        </div>
        <p>${esc(item.message || '')}</p>
        ${Array.isArray(item.path) && item.path.length
          ? `<code class="import-diagnostic-path">${esc(item.path.join('.'))}</code>`
          : ''}
      </li>`).join('')}</ul>`;
  }

  function _referencesHtml(references = []) {
    if (!references.length) return `<p class="import-empty">${esc(I18n.t('import.none'))}</p>`;
    return `
      <div class="import-table-wrap">
        <table class="import-table">
          <thead><tr>
            <th>${esc(I18n.t('import.localRef'))}</th>
            <th>${esc(I18n.t('import.collection'))}</th>
            <th>${esc(I18n.t('import.reservedId'))}</th>
          </tr></thead>
          <tbody>${references.map(item => `
            <tr>
              <td><code>${esc(item.ref)}</code></td>
              <td>${esc(item.collection)}</td>
              <td><code>${esc(item.id)}</code></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  function _changeHtml(change) {
    const label = change.after?.name || change.after?.label || change.sourceRef || change.id;
    const statusKey = change.status === 'update' ? 'import.update' : 'import.create';
    return `
      <details class="import-change">
        <summary>
          <span class="import-change-kind">${esc(change.collection)}</span>
          <strong>${esc(label)}</strong>
          <span class="codex-badge">${esc(I18n.t(statusKey))}</span>
          ${change.derived ? `<span class="codex-badge is-warning">${esc(I18n.t('import.derived'))}</span>` : ''}
        </summary>
        <div class="import-change-body">
          ${change.sourceRef ? `<p><span>${esc(I18n.t('import.localRef'))}</span> <code>${esc(change.sourceRef)}</code></p>` : ''}
          <div class="import-diff">
            <section>
              <h4>${esc(I18n.t('import.before'))}</h4>
              <pre>${_json(change.before)}</pre>
            </section>
            <section>
              <h4>${esc(I18n.t('import.after'))}</h4>
              <pre>${_json(change.after)}</pre>
            </section>
          </div>
        </div>
      </details>`;
  }

  function _changesHtml(changes = []) {
    if (!changes.length) return `<p class="import-empty">${esc(I18n.t('import.none'))}</p>`;
    return `<div class="import-change-list">${changes.map(_changeHtml).join('')}</div>`;
  }

  function _mapGroups(changes = []) {
    const changedLocations = new Map(
      changes
        .filter(change => change.collection === 'locations' && change.after)
        .map(change => [change.id, {
          ...change.after,
          sourceRef: change.sourceRef || '',
        }]),
    );
    const groups = new Map();
    for (const [id, location] of changedLocations) {
      if (!Number.isFinite(location.x) || !Number.isFinite(location.y)) continue;
      const parentId = typeof location.parentId === 'string' ? location.parentId : '';
      if (!groups.has(parentId)) groups.set(parentId, []);
      groups.get(parentId).push({ id, ...location });
    }
    return [...groups].map(([parentId, changedPins]) => {
      const parent = parentId
        ? (changedLocations.get(parentId) || Store.getLocation(parentId))
        : null;
      const pins = new Map(
        (Store.getLocationsOnMap(parentId || null) || [])
          .filter(location => Number.isFinite(location.x) && Number.isFinite(location.y))
          .map(location => [location.id, { ...location, changed: false }]),
      );
      for (const pin of changedPins) pins.set(pin.id, { ...pin, changed: true });
      return {
        parentId,
        label: parent?.name || I18n.t('import.worldMap'),
        image: parentId ? parent?.localMap : WORLD_MAP_IMAGE,
        changedCount: changedPins.length,
        pins: [...pins.values()],
      };
    });
  }

  function _mapPreviewHtml(changes = []) {
    const pinTypes = Store.getEnum('pinTypes') || [];
    const groups = _mapGroups(changes);
    if (!groups.length) return `<p class="import-empty">${esc(I18n.t('import.noMapChanges'))}</p>`;
    return `<div class="import-map-list">${groups.map(group => `
      <figure class="import-map-card">
        <figcaption>
          <strong>${esc(group.label)}</strong>
          <span>${esc(I18n.t('import.changedPins', { count: group.changedCount }))}</span>
        </figcaption>
        <div class="import-map-stage${group.image ? '' : ' has-no-image'}">
          ${group.image
            ? `<img src="${esc(group.image)}" alt="" loading="lazy">`
            : `<p>${esc(I18n.t('import.mapUnavailable'))}</p>`}
          ${group.pins.map(pin => {
            const definition = PinTypes.resolve(pinTypes, pin.pinType);
            const size = Math.max(
              PinTypes.sizeMin,
              Math.min(PinTypes.sizeMax, Number(pin.size) || Number(definition.size) || PinTypes.sizeDefault),
            );
            const adjustment = pin.sourceRef ? _mapAdjustments.get(pin.sourceRef) : null;
            const x = Math.max(0, Math.min(1, adjustment?.x ?? pin.x));
            const y = Math.max(0, Math.min(1, adjustment?.y ?? pin.y));
            const adjustable = !!(pin.changed && pin.sourceRef && group.image);
            const tag = adjustable ? 'button' : 'span';
            const attributes = adjustable
              ? ` type="button" data-source-ref="${esc(pin.sourceRef)}" data-map-x="${x}" data-map-y="${y}" aria-label="${esc(I18n.t('import.movePin', { name: pin.name || pin.id }))}"`
              : '';
            return `<${tag} class="import-map-pin${pin.changed ? ' is-changed' : ' is-existing'}${adjustable ? ' is-adjustable' : ''}"
              ${attributes}
              style="--import-pin-x:${(x * 100).toFixed(4)}%;--import-pin-y:${(y * 100).toFixed(4)}%;--import-pin-size:${size}px;--import-pin-color:${safeColor(definition.color)}"
              title="${esc(pin.name || pin.id)}">
                <span aria-hidden="true">${esc(definition.icon || '📌')}</span>
                <b>${esc(pin.name || pin.id)}</b>
              </${tag}>`;
          }).join('')}
        </div>
      </figure>`).join('')}</div>`;
  }

  function _coreRecord(collection, id) {
    if (collection === 'characters') return Store.getCharacter(id);
    if (collection === 'locations') return Store.getLocation(id);
    if (collection === 'factions') return Store.getFaction(id);
    if (collection === 'mysteries') return Store.getMystery(id);
    if (collection === 'artifacts') return Store.getArtifact(id);
    if (collection === 'events') return Store.getEvent(id);
    return null;
  }

  function _storyKindLabel(kind) {
    if (kind === 'thread') return I18n.t('import.storyKind.thread');
    if (kind === 'quest') return I18n.t('import.storyKind.quest');
    if (kind === 'scenario') return I18n.t('import.storyKind.scenario');
    if (kind === 'encounter') return I18n.t('import.storyKind.encounter');
    return I18n.t('import.storyKind.note');
  }

  function _storyModel(changes = []) {
    const changedCore = new Map(changes
      .filter(change => ['characters', 'locations', 'factions', 'mysteries', 'artifacts', 'events']
        .includes(change.collection) && change.after)
      .map(change => [`${change.collection}:${change.id}`, change.after]));
    const relationshipTypes = new Map((Store.getEnum('relationshipTypes') || [])
      .map(type => [type.id, type.target === 'location' ? 'locations' : 'characters']));
    return buildStoryReview(changes, {
      coreLabel: (collection, id) => {
        const record = changedCore.get(`${collection}:${id}`) || _coreRecord(collection, id);
        return record?.name || record?.title || record?.label || id;
      },
      relationshipTarget: type => relationshipTypes.get(type) || 'characters',
    });
  }

  function _storyOutlineHtml(story) {
    if (!story.items.length) return '';
    return `<div class="import-story-cards">${story.items.map(item => {
      const sections = Array.isArray(item.sections) ? item.sections : [];
      return `
        <article class="import-story-card is-${esc(item.kind || 'note')}" data-story-id="${esc(item.id)}">
          <header>
            <span>${esc(_storyKindLabel(item.kind))}</span>
            ${item.state ? `<span class="codex-badge">${esc(item.state)}</span>` : ''}
          </header>
          <h4>${esc(item.title || item.id)}</h4>
          ${item.summary ? `<p class="import-story-summary">${esc(item.summary)}</p>` : ''}
          ${(item.body || sections.length) ? `
            <details>
              <summary>${esc(I18n.t('import.storyDetails', { count: sections.length }))}</summary>
              ${item.body ? `<div class="import-story-body">${esc(item.body)}</div>` : ''}
              ${sections.length ? `<ol>${sections.map(section => `
                <li>
                  <strong>${esc(section.title || section.id)}</strong>
                  ${section.body ? `<p>${esc(section.body)}</p>` : ''}
                </li>`).join('')}</ol>` : ''}
            </details>` : ''}
        </article>`;
    }).join('')}</div>`;
  }

  function _storyConnectionsHtml(story) {
    if (!story.edges.length) return '';
    const nodes = new Map(story.nodes.map(node => [node.id, node]));
    const items = new Map(story.items.map(item => [item.id, item]));
    const sectionLabel = (node, sectionId) => {
      if (!sectionId || node?.scope !== 'planning') return '';
      const section = (items.get(node.recordId)?.sections || [])
        .find(value => value.id === sectionId);
      return section?.title || sectionId;
    };
    return `
      <details class="import-story-connections">
        <summary>${esc(I18n.t('import.storyConnections', { count: story.edges.length }))}</summary>
        <ul>${story.edges.map(edge => {
          const source = nodes.get(edge.source);
          const target = nodes.get(edge.target);
          const sourceSection = sectionLabel(source, edge.sourceSectionId);
          const targetSection = sectionLabel(target, edge.targetSectionId);
          return `<li>
            <span>${esc(source?.label || edge.source)}${sourceSection ? ` · ${esc(sourceSection)}` : ''}</span>
            <strong>${esc(edge.label || edge.type)}</strong>
            <span>${esc(target?.label || edge.target)}${targetSection ? ` · ${esc(targetSection)}` : ''}</span>
            ${edge.notes ? `<p>${esc(edge.notes)}</p>` : ''}
          </li>`;
        }).join('')}</ul>
      </details>`;
  }

  function _storyPreviewHtml(changes = []) {
    _storyReview = _storyModel(changes);
    if (!_storyReview.nodes.length && !_storyReview.items.length) {
      return `<p class="import-empty">${esc(I18n.t('import.noStoryChanges'))}</p>`;
    }
    return `
      <div class="import-story-evidence">
        <div class="import-story-graph-shell">
          <div id="import-story-graph" class="import-story-graph"
            role="img" aria-label="${esc(I18n.t('import.storyGraphLabel'))}"></div>
          <p class="import-story-graph-fallback" hidden>${esc(I18n.t('import.graphUnavailable'))}</p>
        </div>
        ${_storyConnectionsHtml(_storyReview)}
        ${_storyOutlineHtml(_storyReview)}
      </div>`;
  }

  function _destroyStoryGraph() {
    if (!_storyGraph) return;
    try {
      _storyGraph.destroy();
    } catch {
      // The container may already have been replaced by route navigation.
    }
    _storyGraph = null;
  }

  function _mountStoryGraph(story) {
    const container = document.getElementById('import-story-graph');
    if (!container || !story?.nodes?.length) return;
    const cytoscapeFactory = globalThis.cytoscape;
    const fallback = container.parentElement?.querySelector('.import-story-graph-fallback');
    if (typeof cytoscapeFactory !== 'function') {
      container.hidden = true;
      if (fallback) fallback.hidden = false;
      return;
    }
    const style = getComputedStyle(container);
    const token = (name, fallbackValue) => style.getPropertyValue(name).trim() || fallbackValue;
    try {
      _storyGraph = cytoscapeFactory({
        container,
        elements: [
          ...story.nodes.map(node => ({ data: node })),
          ...story.edges.map(edge => ({ data: edge })),
        ],
        style: [
          {
            selector: 'node',
            style: {
              width: 148,
              height: 48,
              shape: 'round-rectangle',
              label: 'data(label)',
              color: token('--text-cream', '#f0e6d2'),
              'font-family': token('--font-ui', 'sans-serif'),
              'font-size': 11,
              'text-wrap': 'wrap',
              'text-max-width': 130,
              'text-valign': 'center',
              'text-halign': 'center',
              'background-color': token('--bg-raised', '#241c0d'),
              'border-width': 2,
              'border-color': token('--text-muted', '#9a8660'),
            },
          },
          {
            selector: 'node[scope = "core"]',
            style: {
              shape: 'ellipse',
              width: 116,
              height: 54,
              'border-color': token('--color-info', '#90caf9'),
            },
          },
          {
            selector: 'node[kind = "thread"]',
            style: { 'border-color': token('--color-mystery', '#ce93d8') },
          },
          {
            selector: 'node[kind = "quest"]',
            style: { 'border-color': token('--accent-gold', '#c8a040') },
          },
          {
            selector: 'node[kind = "scenario"]',
            style: { 'border-color': token('--color-info', '#90caf9') },
          },
          {
            selector: 'node[kind = "encounter"]',
            style: { 'border-color': token('--color-danger-bright', '#ff8888') },
          },
          {
            selector: 'edge',
            style: {
              width: 1.5,
              'curve-style': 'bezier',
              'line-color': token('--text-muted', '#9a8660'),
              'target-arrow-color': token('--text-muted', '#9a8660'),
              'target-arrow-shape': 'triangle',
              label: 'data(label)',
              color: token('--text-light', '#d4c49a'),
              'font-family': token('--font-ui', 'sans-serif'),
              'font-size': 9,
              'text-wrap': 'wrap',
              'text-max-width': 112,
              'text-background-color': token('--bg-deep', '#0e0a05'),
              'text-background-opacity': 0.88,
              'text-background-padding': 3,
              'text-rotation': 'autorotate',
            },
          },
        ],
        layout: globalThis.cytoscapeDagre
          ? { name: 'dagre', rankDir: 'LR', nodeSep: 42, rankSep: 105, edgeSep: 18, padding: 36 }
          : { name: 'cose', animate: false, fit: true, padding: 36 },
        minZoom: 0.35,
        maxZoom: 2.2,
        autoungrabify: true,
        boxSelectionEnabled: false,
        userPanningEnabled: true,
        userZoomingEnabled: true,
      });
      _storyGraph.on('tap', 'node[scope = "planning"]', event => {
        const recordId = event.target.data('recordId');
        const card = [...document.querySelectorAll('.import-story-card')]
          .find(element => element.dataset.storyId === recordId);
        card?.scrollIntoView({
          block: 'nearest',
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      });
    } catch (error) {
      console.warn('[import] story graph unavailable', error);
      _destroyStoryGraph();
      container.hidden = true;
      if (fallback) fallback.hidden = false;
    }
  }

  function _stopMapDrag() {
    if (!_dragCleanup) return;
    _dragCleanup();
    _dragCleanup = null;
  }

  function _updatePlacementControls() {
    const count = _mapAdjustments.size;
    const controls = document.getElementById('import-placement-controls');
    const message = document.getElementById('import-placement-count');
    if (controls) controls.hidden = count === 0;
    if (message) message.textContent = I18n.t('import.placementPending', { count });
    const confirm = document.getElementById('import-confirm-plan');
    if (confirm) {
      confirm.checked = count ? false : _confirmed;
      confirm.disabled = !!count || !!_busy;
    }
    const commit = document.getElementById('import-commit-button');
    if (commit) {
      commit.disabled = !_preview?.committable || !_confirmed || !!_busy || !!count;
    }
  }

  function _setMapAdjustment(pin, x, y) {
    const sourceRef = pin.dataset.sourceRef;
    if (!sourceRef) return;
    const next = {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
    _mapAdjustments.set(sourceRef, next);
    _confirmed = false;
    pin.dataset.mapX = String(next.x);
    pin.dataset.mapY = String(next.y);
    pin.style.setProperty('--import-pin-x', `${(next.x * 100).toFixed(4)}%`);
    pin.style.setProperty('--import-pin-y', `${(next.y * 100).toFixed(4)}%`);
    _updatePlacementControls();
  }

  function _wireMapEditors() {
    for (const pin of document.querySelectorAll('.import-map-pin.is-adjustable')) {
      pin.addEventListener('keydown', event => {
        const direction = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }[event.key];
        if (!direction) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.02 : 0.005;
        _setMapAdjustment(
          pin,
          Number(pin.dataset.mapX) + direction[0] * step,
          Number(pin.dataset.mapY) + direction[1] * step,
        );
      });
      pin.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const stage = pin.closest('.import-map-stage');
        const surface = stage?.querySelector(':scope > img');
        if (!surface) return;
        event.preventDefault();
        _stopMapDrag();
        pin.classList.add('is-dragging');
        const move = pointerEvent => {
          if (pointerEvent.pointerId !== event.pointerId) return;
          const rect = surface.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          _setMapAdjustment(
            pin,
            (pointerEvent.clientX - rect.left) / rect.width,
            (pointerEvent.clientY - rect.top) / rect.height,
          );
        };
        const finish = pointerEvent => {
          if (pointerEvent.pointerId !== event.pointerId) return;
          _stopMapDrag();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
        _dragCleanup = () => {
          pin.classList.remove('is-dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
        };
      });
    }
    _updatePlacementControls();
  }

  function discardMapAdjustments() {
    if (_busy || !_mapAdjustments.size) return;
    _mapAdjustments.clear();
    _confirmed = false;
    render();
  }

  async function applyMapAdjustments() {
    if (_busy || !_file || !_mapAdjustments.size) return;
    const generation = ++_generation;
    const previousJobId = _jobId;
    let nextJobId = '';
    _busy = 'adjust';
    _error = null;
    render();
    try {
      const source = JSON.parse(await _file.text());
      const adjusted = applyLocationAdjustments(source, _mapAdjustments);
      const nextFile = new File(
        [JSON.stringify(adjusted, null, 2)],
        _file.name || 'campaign-bundle.json',
        { type: 'application/json', lastModified: Date.now() },
      );
      const job = await _client.createJob({ providerId: PROVIDER_ID, file: nextFile });
      nextJobId = job.id;
      if (generation !== _generation) {
        await _client.cancel(job.id).catch(() => {});
        return;
      }
      const previewResult = await _client.preview(job.id);
      if (generation !== _generation) {
        await _client.cancel(job.id).catch(() => {});
        return;
      }
      _file = nextFile;
      _jobId = job.id;
      _preview = previewResult;
      _mapAdjustments.clear();
      _confirmed = false;
      if (previousJobId) _client.cancel(previousJobId).catch(() => {});
      announce(I18n.t(_preview.committable ? 'import.previewReady' : 'import.previewBlocked'));
    } catch (error) {
      if (nextJobId) await _client.cancel(nextJobId).catch(() => {});
      if (generation === _generation) {
        _error = error?.message || I18n.t('import.adjustFailed');
      }
    } finally {
      if (generation === _generation) {
        _busy = '';
        render();
      }
    }
  }

  function _reviewHtml() {
    const plan = _preview?.plan || {};
    const review = plan.review || {};
    const projection = review.playerProjection || {};
    const publicCount = Object.values(projection)
      .reduce((total, records) => total + (Array.isArray(records) ? records.length : 0), 0);
    const errorCount = (plan.diagnostics || []).filter(item => item.severity === 'error').length;
    return `
      <section class="import-ledger" aria-labelledby="import-review-title">
        <div class="import-ledger-head">
          <div>
            <p class="import-kicker">${esc(I18n.t('import.reviewKicker'))}</p>
            <h2 id="import-review-title">${esc(I18n.t('import.reviewTitle'))}</h2>
          </div>
          <span class="import-verdict ${_preview.committable ? 'is-ready' : 'is-blocked'}">
            ${esc(I18n.t(_preview.committable ? 'import.ready' : 'import.blocked'))}
          </span>
        </div>
        <div class="import-metrics">
          <div><strong>${Number(review.logicalRecordCount) || 0}</strong><span>${esc(I18n.t('import.records'))}</span></div>
          <div><strong>${Number(review.materializedWriteCount) || 0}</strong><span>${esc(I18n.t('import.writes'))}</span></div>
          <div><strong>${publicCount}</strong><span>${esc(I18n.t('import.playerVisible'))}</span></div>
          <div class="${errorCount ? 'is-danger' : ''}"><strong>${errorCount}</strong><span>${esc(I18n.t('import.errors'))}</span></div>
        </div>

        <section class="import-review-section">
          <h3>${esc(I18n.t('import.diagnostics'))}</h3>
          ${_diagnosticsHtml(plan.diagnostics)}
        </section>
        <section class="import-review-section import-story-section">
          <h3>${esc(I18n.t('import.storyPreview'))}</h3>
          <p class="import-section-copy">${esc(I18n.t('import.storyPreviewHint'))}</p>
          ${_storyPreviewHtml(review.changes)}
        </section>
        <section class="import-review-section">
          <h3>${esc(I18n.t('import.mapPreview'))}</h3>
          <p class="import-section-copy">${esc(I18n.t('import.mapPreviewHint'))}</p>
          <div class="import-placement-controls" id="import-placement-controls"
            aria-live="polite"${_mapAdjustments.size ? '' : ' hidden'}>
            <span id="import-placement-count">${esc(I18n.t('import.placementPending', {
              count: _mapAdjustments.size,
            }))}</span>
            <div>
              ${_button(
                _busy === 'adjust'
                  ? esc(I18n.t('import.applyingPlacements'))
                  : esc(I18n.t('import.applyPlacements')),
                'ImportCenter.applyMapAdjustments',
                'edit-save-btn',
                !!_busy,
              )}
              ${_button(
                esc(I18n.t('import.discardPlacements')),
                'ImportCenter.discardMapAdjustments',
                'inline-create-btn',
                !!_busy,
              )}
            </div>
          </div>
          ${_mapPreviewHtml(review.changes)}
        </section>
        <section class="import-review-section">
          <h3>${esc(I18n.t('import.references'))}</h3>
          ${_referencesHtml(review.references)}
        </section>
        <section class="import-review-section">
          <h3>${esc(I18n.t('import.changes'))}</h3>
          ${_changesHtml(review.changes)}
        </section>
        <div class="import-confirm">
          <label>
            <input type="checkbox" id="import-confirm-plan"${_confirmed ? ' checked' : ''}${_mapAdjustments.size || _busy ? ' disabled' : ''}${dataOn('change', 'ImportCenter.setConfirmed', '$checked')}>
            <span>${esc(I18n.t('import.confirmExactPlan'))}</span>
          </label>
          <div class="import-actions">
            ${_button(esc(I18n.t('import.startOver')), 'ImportCenter.reset')}
            ${_button(
              `✓ ${esc(I18n.t('import.commit'))}`,
              'ImportCenter.commit',
              'edit-save-btn',
              !_preview.committable || !_confirmed || !!_busy || !!_mapAdjustments.size,
              'import-commit-button',
            )}
          </div>
        </div>
      </section>`;
  }

  function _uploadHtml() {
    return `
      <section class="import-dropzone">
        <div class="import-drop-icon" aria-hidden="true">⌁</div>
        <div>
          <h2>${esc(I18n.t('import.chooseTitle'))}</h2>
          <p>${esc(I18n.t('import.chooseHint'))}</p>
        </div>
        <label class="inline-create-btn import-file-button">
          ${esc(I18n.t('import.chooseFile'))}
          <input type="file" accept=".json,application/json"${dataOn('change', 'ImportCenter.selectFile', '$el')}>
        </label>
        ${_file ? `
          <div class="import-file">
            <strong>${esc(_file.name || 'import.json')}</strong>
            <span>${esc(I18n.t('import.fileBytes', { count: _file.size }))}</span>
          </div>
          ${_button(
            _busy === 'preview' ? esc(I18n.t('import.reviewing')) : esc(I18n.t('import.preview')),
            'ImportCenter.preview',
            'edit-save-btn',
            !!_busy,
          )}` : ''}
      </section>`;
  }

  function _resultHtml() {
    return `
      <section class="import-complete" role="status">
        <span aria-hidden="true">✓</span>
        <div>
          <h2>${esc(I18n.t('import.completeTitle'))}</h2>
          <p>${esc(I18n.t('import.completeHint', {
            count: Number(_result?.operationCount) || 0,
          }))}</p>
          ${_result?.commitId ? `<code>${esc(_result.commitId)}</code>` : ''}
        </div>
        ${_button(esc(I18n.t('import.another')), 'ImportCenter.reset', 'edit-save-btn')}
      </section>`;
  }

  function render() {
    _stopMapDrag();
    _destroyStoryGraph();
    if (typeof window !== 'undefined') {
      const route = (window.location.hash || '#/').replace(/^#/, '') || '/';
      if (route !== '/import') return;
    }
    const main = _main();
    if (!main) return;
    if (!Role.isDM()) {
      main.innerHTML = `
        <div class="dm-panel">
          <h1>⌁ ${esc(I18n.t('import.title'))}</h1>
          <p class="dm-stub">${esc(I18n.t('import.dmOnly'))}</p>
        </div>`;
      return;
    }
    main.innerHTML = `
      <div class="import-center">
        <header class="page-header import-header">
          <div>
            <p class="import-kicker">${esc(I18n.t('import.kicker'))}</p>
            <h1>⌁ ${esc(I18n.t('import.title'))}</h1>
            <p class="subtitle">${esc(I18n.t('import.intro'))}</p>
          </div>
          <nav class="import-resources" aria-label="${esc(I18n.t('import.resources'))}">
            <a href="/api/content-import/schemas/campaign-bundle-v1" target="_blank" rel="noopener">${esc(I18n.t('import.schema'))}</a>
            <a href="/api/content-import/inventory?includeBodies=true" target="_blank" rel="noopener">${esc(I18n.t('import.inventory'))}</a>
          </nav>
        </header>
        ${_error ? `<div class="import-error" role="alert"><strong>${esc(I18n.t('import.error'))}</strong> ${esc(_error)}</div>` : ''}
        ${_result ? _resultHtml() : (_preview ? _reviewHtml() : _uploadHtml())}
      </div>`;
    if (_preview && !_result) {
      _wireMapEditors();
      _mountStoryGraph(_storyReview);
    }
  }

  function selectFile(input) {
    _file = input?.files?.[0] || null;
    _preview = null;
    _result = null;
    _error = null;
    _confirmed = false;
    _mapAdjustments.clear();
    render();
  }

  async function preview() {
    if (!_file || _busy) return;
    const generation = ++_generation;
    _busy = 'preview';
    _error = null;
    render();
    try {
      const providers = await _client.listProviders();
      if (!providers.providers.some(provider => provider.id === PROVIDER_ID)) {
        throw new Error(I18n.t('import.providerUnavailable'));
      }
      const job = await _client.createJob({ providerId: PROVIDER_ID, file: _file });
      if (generation !== _generation) {
        await _client.cancel(job.id).catch(() => {});
        return;
      }
      _jobId = job.id;
      _preview = await _client.preview(job.id);
      if (generation !== _generation) return;
      _confirmed = false;
      announce(I18n.t(_preview.committable ? 'import.previewReady' : 'import.previewBlocked'));
    } catch (error) {
      if (generation === _generation) {
        _error = error?.message || I18n.t('import.error');
      }
    } finally {
      if (generation === _generation) {
        _busy = '';
        render();
      }
    }
  }

  function setConfirmed(value) {
    if (_mapAdjustments.size || _busy) return;
    _confirmed = !!value;
    render();
  }

  async function commit() {
    if (!_jobId || !_preview?.previewToken || !_preview.committable
        || !_confirmed || _busy || _mapAdjustments.size) return;
    const generation = _generation;
    _busy = 'commit';
    _error = null;
    render();
    try {
      _result = await _client.commit(_jobId, _preview.previewToken);
      await Store.load();
      if (generation === _generation) announce(I18n.t('import.completeTitle'));
    } catch (error) {
      if (generation === _generation) {
        _error = error?.message || I18n.t('import.error');
      }
    } finally {
      if (generation === _generation) {
        _busy = '';
        render();
      }
    }
  }

  async function reset() {
    _generation++;
    if (_jobId && !_result) {
      await _client.cancel(_jobId).catch(() => {});
    }
    _file = null;
    _preview = null;
    _result = null;
    _error = null;
    _busy = '';
    _confirmed = false;
    _jobId = '';
    _mapAdjustments.clear();
    _storyReview = null;
    render();
  }

  function leave() {
    _generation++;
    _stopMapDrag();
    _destroyStoryGraph();
    const jobId = _jobId;
    const committing = _busy === 'commit';
    _file = null;
    _preview = null;
    _result = null;
    _error = null;
    _busy = '';
    _confirmed = false;
    _jobId = '';
    _mapAdjustments.clear();
    _storyReview = null;
    if (jobId && !committing) _client.cancel(jobId).catch(() => {});
  }

  return Object.freeze({
    applyMapAdjustments,
    commit,
    discardMapAdjustments,
    leave,
    preview,
    render,
    reset,
    selectFile,
    setConfirmed,
  });
})();
