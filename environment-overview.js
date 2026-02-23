/**
 * environment-overview — Facets Platform Web Component
 * Comprehensive Environment Overview with state-adaptive UI, pre/post-launch views,
 * legacy/blueprint project support, and optional Kubernetes sections.
 *
 * Attributes:
 *   cluster-id      — (preferred) the environment's cluster ID
 *   stack-name      — project/stack name (used with cluster-name as fallback)
 *   cluster-name    — environment name (used with stack-name as fallback)
 */

class EnvironmentOverview extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // ── Core state ──────────────────────────────────────────────────────────
    this.clusterId   = null;
    this.stackName   = null;
    this.clusterName = null;

    // API data
    this.overview        = null;   // /deployments/overview  → cluster + stats + inProgress
    this.env             = null;   // cluster object from overview.cluster
    this.resourceStats   = null;   // /resource-stats
    this.varCounts       = null;   // /variable-counts
    this.deployments     = null;   // /deployments (lazy)
    this.resources       = null;   // /dropdown/resources-info (lazy)
    this.ingresses       = null;   // /k8s-explorer/ingress-rules (lazy)
    this.schedule        = null;   // /availability-schedule (lazy)
    this.maintenanceWin  = null;   // /maintenance-window (lazy)
    this.costEnabled     = false;

    // UI state
    this.activeTab    = 'overview';
    this.isLoading    = true;
    this.error        = null;
    this.refreshTimer = null;

    this.render();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  connectedCallback() {
    this.clusterId   = this.getAttribute('cluster-id');
    this.stackName   = this.getAttribute('stack-name');
    this.clusterName = this.getAttribute('cluster-name');

    // 1. Attribute provided — use it directly
    if (this.clusterId || (this.stackName && this.clusterName)) {
      this._loadData();
      return;
    }

    // 2. Try to parse context from the current URL
    var ctx = this._tryUrlContext();
    if (ctx.clusterId) {
      this.clusterId = ctx.clusterId;
      this._loadData();
      return;
    }
    if (ctx.stackName && ctx.clusterName) {
      this.stackName   = ctx.stackName;
      this.clusterName = ctx.clusterName;
      this._loadData();
      return;
    }

    // 3. No context available — show project → environment picker
    this._showPicker();
  }

  // Try to extract env context from the page URL
  _tryUrlContext() {
    var result = { clusterId: null, stackName: null, clusterName: null };
    try {
      var search   = window.location.search  || '';
      var hash     = window.location.hash    || '';
      var pathname = window.location.pathname || '';
      var full     = pathname + hash + search;

      // Query param ?clusterId=xxx or ?cluster-id=xxx
      var qp = new URLSearchParams(search);
      if (qp.get('clusterId'))   { result.clusterId = qp.get('clusterId');   return result; }
      if (qp.get('cluster-id'))  { result.clusterId = qp.get('cluster-id');  return result; }

      // Path pattern: /projects/{stack}/environments/{cluster}
      var m = full.match(/\/projects\/([^\/\?#]+)\/environments\/([^\/\?#]+)/);
      if (m) {
        result.stackName   = decodeURIComponent(m[1]);
        result.clusterName = decodeURIComponent(m[2]);
        return result;
      }

      // Hash pattern: #/projects/{stack}/environments/{cluster}
      m = hash.match(/\/projects\/([^\/\?#]+)\/environments\/([^\/\?#]+)/);
      if (m) {
        result.stackName   = decodeURIComponent(m[1]);
        result.clusterName = decodeURIComponent(m[2]);
        return result;
      }
    } catch (e) { /* ignore */ }
    return result;
  }

  disconnectedCallback() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async _resolveClusterId() {
    if (this.clusterId) return this.clusterId;
    const r = await fetch(
      `/cc-ui/v1/clusters/stack/${encodeURIComponent(this.stackName)}/cluster/${encodeURIComponent(this.clusterName)}/info`
    );
    if (!r.ok) throw new Error('Could not resolve cluster ID from name');
    const d = await r.json();
    return d.id || d.clusterId;
  }

  async _api(path) {
    try {
      const r = await fetch(path);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async _loadData() {
    try {
      this.clusterId = await this._resolveClusterId();

      // Phase 1 — critical (parallel)
      const [overview, stats, vars] = await Promise.all([
        this._api(`/cc-ui/v1/clusters/${this.clusterId}/deployments/overview`),
        this._api(`/cc-ui/v1/clusters/${this.clusterId}/resource-stats`),
        this._api(`/cc-ui/v1/clusters/${this.clusterId}/variable-counts`)
      ]);

      this.overview      = overview;
      this.env           = overview && overview.cluster ? overview.cluster : null;
      this.resourceStats = stats;
      this.varCounts     = vars;
      this.isLoading     = false;

      this._renderAll();
      this._loadSecondary();
      this._maybeStartRefresh();

    } catch (err) {
      this.isLoading = false;
      this.error     = err.message;
      this._renderAll();
    }
  }

  async _loadSecondary() {
    const costData = await this._api('/cc-ui/v1/cost-explorer/aws/enabled');
    this.costEnabled = costData === true || (costData && costData.enabled === true);
    const cs = this.shadowRoot.getElementById('cost-section');
    if (cs) cs.style.display = this.costEnabled ? 'block' : 'none';
  }

  async _loadTabData(tab) {
    if (tab === 'releases' && !this.deployments) {
      this.deployments = await this._api(`/cc-ui/v1/clusters/${this.clusterId}/deployments?size=25&page=0`);
      if (this.activeTab === 'releases') this._renderTabContent('releases');
    }
    if (tab === 'resources' && !this.resources) {
      const [res, ing] = await Promise.all([
        this._api(`/cc-ui/v1/dropdown/cluster/${this.clusterId}/resources-info?includeContent=false`),
        this._hasKubernetes() ? this._api(`/cc-ui/v1/clusters/${this.clusterId}/k8s-explorer/ingress-rules`) : Promise.resolve(null)
      ]);
      this.resources = res;
      this.ingresses = ing;
      if (this.activeTab === 'resources') this._renderTabContent('resources');
    }
    if (tab === 'schedule' && !this.schedule) {
      const [sched, mw] = await Promise.all([
        this._api(`/cc-ui/v1/clusters/${this.clusterId}/availability-schedule`),
        this._api(`/cc-ui/v1/maintenance-window/${this.clusterId}`)
      ]);
      this.schedule       = sched;
      this.maintenanceWin = mw;
      if (this.activeTab === 'schedule') this._renderTabContent('schedule');
    }
  }

  _maybeStartRefresh() {
    const state      = this.env && this.env.clusterState;
    const inProgress = this.overview && this.overview.inProgressDeployments && this.overview.inProgressDeployments.length > 0;
    const activeStates = ['LAUNCHING','DESTROYING','SCALING_UP','SCALING_DOWN'];
    if (inProgress || activeStates.indexOf(state) !== -1) {
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = setInterval(() => this._refreshOverview(), 15000);
    }
  }

  async _refreshOverview() {
    const fresh = await this._api(`/cc-ui/v1/clusters/${this.clusterId}/deployments/overview`);
    if (!fresh) return;
    this.overview = fresh;
    this.env      = fresh.cluster || this.env;
    this._renderHeader();
    this._renderBanners();
    this._renderCards();

    const state      = this.env && this.env.clusterState;
    const inProgress = fresh.inProgressDeployments && fresh.inProgressDeployments.length > 0;
    const activeStates = ['LAUNCHING','DESTROYING','SCALING_UP','SCALING_DOWN'];
    if (!inProgress && activeStates.indexOf(state) === -1) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ── Root render ────────────────────────────────────────────────────────────

  render() {
    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="wrapper">
        <div id="header-section"></div>
        <div id="banners-section"></div>
        <div id="cards-section"></div>
        <div id="tabs-nav"></div>
        <div id="tab-content"></div>
        <div id="loading-overlay" class="loading-overlay">
          <div class="spinner"></div>
          <span>Loading environment…</span>
        </div>
      </div>`;
  }

  _renderAll() {
    const lo = this.shadowRoot.getElementById('loading-overlay');
    if (lo) lo.style.display = 'none';

    if (this.error && !this.env) {
      this.shadowRoot.getElementById('header-section').innerHTML =
        `<div class="boot-error">Failed to load environment: ${this.error}</div>`;
      return;
    }

    this._renderHeader();
    this._renderBanners();
    this._renderCards();
    this._renderTabsNav();
    this._renderTabContent(this.activeTab);
  }

  // ── Header ─────────────────────────────────────────────────────────────────

  _renderHeader() {
    const env   = this.env || {};
    const state = env.clusterState || 'UNKNOWN';
    const sc    = this._stateConf(state);
    const cloud = env.cloud || 'NO_CLOUD';
    const isLegacy = !(env.stack && env.stack.projectTypeId);

    const tags = [];
    if (env.isEphemeral)    tags.push('<span class="tag tag-eph">Ephemeral</span>');
    if (env.baseClusterId)  tags.push(`<span class="tag tag-base">Base: ${env.baseClusterName || 'env'}</span>`);
    if (env.pauseReleases)  tags.push('<span class="tag tag-warn">Releases Paused</span>');
    if (env.requireSignOff) tags.push('<span class="tag tag-info">Approval Required</span>');
    if (!isLegacy)          tags.push('<span class="tag tag-new">Blueprint</span>');

    const hasK8s = this._hasKubernetes();

    const el = this.shadowRoot.getElementById('header-section');
    el.innerHTML = `
      <div class="header">
        <div class="header-top">
          <div class="header-identity">
            <div class="breadcrumb">
              <span class="breadcrumb-proj">${env.stackName || '—'}</span>
              <span class="breadcrumb-sep">›</span>
              <span class="breadcrumb-env">${env.name || 'Environment'}</span>
            </div>
            <div class="header-badges">
              <span class="state-pill"
                style="background:${sc.bg};color:${sc.color};border-color:${sc.border}">
                <span class="state-dot"
                  style="background:${sc.dot}${sc.pulse?';animation:pulse 1.4s infinite':''}"></span>
                ${sc.label}
              </span>
              <span class="cloud-badge">${this._cloudIcon(cloud)} ${cloud}</span>
              ${env.namespace ? `<span class="cloud-badge ns-badge">NS: ${env.namespace}</span>` : ''}
              ${hasK8s ? '<span class="cloud-badge k8s-badge">⎈ K8s</span>' : ''}
            </div>
          </div>
          <div class="header-ctas">${this._headerCTAs(state, env)}</div>
        </div>
        <div class="header-meta">
          ${env.releaseStream ? `<span class="meta-item">Stream: <strong>${env.releaseStream}</strong></span>` : ''}
          ${env.branch        ? `<span class="meta-item">Branch: <strong>${env.branch}</strong></span>` : ''}
          ${env.tz            ? `<span class="meta-item">TZ: ${env.tz}</span>` : ''}
          ${env.createdBy     ? `<span class="meta-item">Created by <strong>${env.createdBy}</strong></span>` : ''}
          ${env.creationDate  ? `<span class="meta-item">${this._fmtDate(env.creationDate)}</span>` : ''}
          ${tags.join('')}
        </div>
      </div>`;

    el.querySelectorAll('.cta-btn[data-action]').forEach(b =>
      b.addEventListener('click', e => this._handleCTA(b.dataset.action, e)));
  }

  // ── Banners ────────────────────────────────────────────────────────────────

  _renderBanners() {
    const env      = this.env || {};
    const inProg   = (this.overview && this.overview.inProgressDeployments) || [];
    const queued   = (this.overview && this.overview.queuedReleases) || [];
    const latest   = this.overview && this.overview.latestDeployment;
    const paused   = env.pauseReleases || (this.overview && this.overview.isScheduledReleasesPaused);

    let html = '';

    inProg.forEach(dep => {
      html += `
        <div class="banner banner-info">
          <span class="banner-icon">⚡</span>
          <span><strong>${dep.releaseType}</strong> in progress
            · started ${this._fmtElapsed(dep.createdOn)}
            ${dep.triggeredBy ? '· by ' + dep.triggeredBy : ''}</span>
          <div class="banner-actions">
            <button class="banner-btn b-primary" data-href="/projects/${env.stackName}/environments/${env.name}/releases/${dep.id}">View Logs</button>
            <button class="banner-btn b-danger cta-btn" data-action="abort" data-dep="${dep.id}">Abort</button>
          </div>
        </div>`;
    });

    if (latest && latest.status === 'PENDING_APPROVAL') {
      html += `
        <div class="banner banner-warn">
          <span class="banner-icon">⏳</span>
          <span>Release <strong>${latest.releaseTraceId || latest.id || ''}</strong> awaiting approval</span>
          <div class="banner-actions">
            <button class="banner-btn b-success cta-btn" data-action="approve" data-dep="${latest.id}">Approve</button>
            <button class="banner-btn b-danger  cta-btn" data-action="reject"  data-dep="${latest.id}">Reject</button>
          </div>
        </div>`;
    }

    if (paused) {
      html += `
        <div class="banner banner-warn">
          <span class="banner-icon">⏸</span>
          <span>Releases are currently <strong>paused</strong> for this environment</span>
          <div class="banner-actions">
            <button class="banner-btn b-primary cta-btn" data-action="resume-releases">Resume Releases</button>
          </div>
        </div>`;
    }

    if (queued.length > 0) {
      html += `
        <div class="banner banner-subtle">
          <span class="banner-icon">⏱</span>
          <span><strong>${queued.length}</strong> release${queued.length > 1 ? 's' : ''} queued</span>
        </div>`;
    }

    const el = this.shadowRoot.getElementById('banners-section');
    el.innerHTML = html;
    el.querySelectorAll('.cta-btn[data-action]').forEach(b =>
      b.addEventListener('click', e => this._handleCTA(b.dataset.action, e)));
    el.querySelectorAll('.banner-btn[data-href]').forEach(b =>
      b.addEventListener('click', () => this._navigate(b.dataset.href)));
  }

  // ── Status Cards ───────────────────────────────────────────────────────────

  _renderCards() {
    const env    = this.env || {};
    const state  = env.clusterState || 'UNKNOWN';
    const sc     = this._stateConf(state);
    const stats  = this.resourceStats || {};
    const ds     = (this.overview && this.overview.deploymentsStats) || {};
    const latest = this.overview && this.overview.latestDeployment;
    const vc     = this.varCounts || {};

    const total    = (stats.totalCount || stats.total || 0);
    const enabled  = (stats.enabledCount || stats.activeCount || total);
    const varTotal = (vc.variableCount || vc.variables || 0) + (vc.secretCount || vc.secrets || 0);
    const depTotal = (ds.successReleases || 0) + (ds.failedReleases || 0) + (ds.noChangeReleases || 0);
    const succPct  = depTotal > 0 ? Math.round((ds.successReleases || 0) / depTotal * 100) : null;

    let lastRelHtml = '<span class="card-na">No releases yet</span>';
    if (latest) {
      const dc = this._depStatusConf(latest.status);
      lastRelHtml = `
        <div class="last-rel">
          <span class="rel-status" style="color:${dc.color}">${dc.icon} ${latest.status}</span>
          <div class="rel-meta">${latest.releaseType || ''} · ${this._fmtRel(latest.finishedOn || latest.createdOn)}</div>
          ${latest.triggeredBy ? `<div class="rel-by">by ${latest.triggeredBy}</div>` : ''}
        </div>`;
    }

    this.shadowRoot.getElementById('cards-section').innerHTML = `
      <div class="cards-row">
        <div class="scard">
          <div class="scard-label">State</div>
          <div class="scard-val">
            <span class="state-pill sm"
              style="background:${sc.bg};color:${sc.color};border-color:${sc.border}">
              <span class="state-dot" style="background:${sc.dot}${sc.pulse?';animation:pulse 1.4s infinite':''}"></span>
              ${sc.label}
            </span>
          </div>
          ${env.cloudAccountId ? `<div class="scard-sub">Acct: ${env.cloudAccountId}</div>` : ''}
        </div>

        <div class="scard">
          <div class="scard-label">Resources</div>
          <div class="scard-num">${total}</div>
          <div class="scard-sub">${enabled} active${total > enabled ? ` · ${total - enabled} disabled` : ''}</div>
        </div>

        <div class="scard">
          <div class="scard-label">Last Release</div>
          ${lastRelHtml}
        </div>

        <div class="scard">
          <div class="scard-label">Deploy Health</div>
          ${succPct !== null
            ? `<div class="scard-num" style="color:${succPct>=80?'#2e7d32':succPct>=50?'#e65100':'#c62828'}">${succPct}%</div>
               <div class="scard-sub">${ds.successReleases||0} ok · ${ds.failedReleases||0} failed · ${ds.noChangeReleases||0} no-change</div>`
            : '<span class="card-na">No data yet</span>'}
        </div>

        <div class="scard">
          <div class="scard-label">Variables &amp; Secrets</div>
          <div class="scard-num">${varTotal}</div>
          <div class="scard-sub">${vc.variableCount||vc.variables||0} vars · ${vc.secretCount||vc.secrets||0} secrets</div>
        </div>
      </div>`;
  }

  // ── Tabs Nav ───────────────────────────────────────────────────────────────

  _renderTabsNav() {
    const tabs = [
      { id: 'overview',  label: 'Overview'       },
      { id: 'releases',  label: 'Releases'        },
      { id: 'resources', label: 'Resources'       },
      { id: 'config',    label: 'Configuration'   },
      { id: 'schedule',  label: 'Schedule'        }
    ];

    this.shadowRoot.getElementById('tabs-nav').innerHTML = `
      <div class="tabs-bar">
        ${tabs.map(t => `
          <button class="tab-btn ${this.activeTab === t.id ? 'active' : ''}" data-tab="${t.id}">
            ${t.label}
          </button>`).join('')}
        <div class="tab-flex"></div>
        <button class="refresh-btn" id="refresh-btn">↺ Refresh</button>
      </div>`;

    this.shadowRoot.querySelectorAll('.tab-btn').forEach(b =>
      b.addEventListener('click', () => this._switchTab(b.dataset.tab)));

    const rb = this.shadowRoot.getElementById('refresh-btn');
    if (rb) rb.addEventListener('click', () => this._hardRefresh());
  }

  _switchTab(tab) {
    this.activeTab = tab;
    this.shadowRoot.querySelectorAll('.tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    this._renderTabContent(tab);
    this._loadTabData(tab);
  }

  _hardRefresh() {
    this.overview = null; this.env = null; this.resourceStats = null;
    this.varCounts = null; this.deployments = null; this.resources = null;
    this.ingresses = null; this.schedule = null; this.maintenanceWin = null;
    this.isLoading = true;
    const lo = this.shadowRoot.getElementById('loading-overlay');
    if (lo) lo.style.display = 'flex';
    this._loadData();
  }

  // ── Tab content dispatcher ─────────────────────────────────────────────────

  _renderTabContent(tab) {
    const container = this.shadowRoot.getElementById('tab-content');
    switch (tab) {
      case 'overview':  container.innerHTML = this._buildOverviewTab();  break;
      case 'releases':  container.innerHTML = this._buildReleasesTab();  break;
      case 'resources': container.innerHTML = this._buildResourcesTab(); break;
      case 'config':    container.innerHTML = this._buildConfigTab();    break;
      case 'schedule':  container.innerHTML = this._buildScheduleTab();  break;
    }
    this._attachTabListeners();
  }

  // ── Overview Tab ───────────────────────────────────────────────────────────

  _buildOverviewTab() {
    const env        = this.env || {};
    const state      = env.clusterState || 'UNKNOWN';
    const isLegacy   = !(env.stack && env.stack.projectTypeId);
    const hasK8s     = this._hasKubernetes();
    const downstream = (this.overview && this.overview.downStreamClusterNames) || [];

    const isNeverLaunched =
      (state === 'STOPPED' && this.overview && this.overview.deploymentsStats && this.overview.deploymentsStats.isFirstRelease) ||
      (state === 'STOPPED' && !this.overview);

    return `
      <div class="tab-panel">
        ${isNeverLaunched ? this._buildLaunchReadiness(env, isLegacy) : ''}
        ${this._buildInfraIdentity(env, isLegacy, hasK8s)}
        ${downstream.length > 0 ? this._buildDownstream(downstream, env.stackName) : ''}
        <div id="cost-section" style="display:${this.costEnabled ? 'block' : 'none'}">
          ${this._buildCostTeaser(env)}
        </div>
      </div>`;
  }

  _buildLaunchReadiness(env, isLegacy) {
    const hasK8s       = this._hasKubernetes();
    const hasCloudAcct = !!env.cloudAccountId;
    const hasVars      = (this.varCounts && ((this.varCounts.variableCount || 0) + (this.varCounts.secretCount || 0))) > 0;
    const isConfigured = !!env.configured;

    if (isLegacy) {
      const checks = [
        { label: 'Environment configured',   ok: isConfigured,   hint: 'Set cloud provider and credentials in environment settings' },
        { label: 'Cloud account linked',      ok: hasCloudAcct,   hint: `Link a ${env.cloud || 'cloud'} account to this environment` },
        { label: 'Kubernetes credentials',    ok: !hasK8s || !!env.hasK8sCredentials, hint: 'Configure K8s access credentials', skip: !hasK8s },
        { label: 'Variables populated',       ok: hasVars,        hint: 'Set required environment variables before launch' }
      ].filter(c => !c.skip);

      const allOk = checks.every(c => c.ok);
      return `
        <div class="readiness-card">
          <div class="readiness-header">
            <h3>Launch Readiness</h3>
            <p>This environment has not been launched yet. Complete the checklist before triggering a launch.</p>
          </div>
          <div class="readiness-checks">
            ${checks.map(c => `
              <div class="r-check ${c.ok ? 'ok' : 'todo'}">
                <span class="r-icon">${c.ok ? '✓' : '○'}</span>
                <div class="r-body">
                  <span class="r-label">${c.label}</span>
                  ${!c.ok ? `<span class="r-hint">${c.hint}</span>` : ''}
                </div>
              </div>`).join('')}
          </div>
          <div class="readiness-footer">
            <button class="cta-btn primary ${allOk ? '' : 'dim'}" data-action="launch"
              title="${allOk ? '' : 'Complete all checks first'}">Launch Environment</button>
            <button class="cta-btn secondary" data-action="plan">Run Plan (Dry Run)</button>
          </div>
        </div>`;
    }

    // Non-legacy / blueprint-based
    const stack = env.stack || {};
    const resCount = (this.resourceStats && this.resourceStats.totalCount) || 0;
    return `
      <div class="readiness-card">
        <div class="readiness-header">
          <h3>Launch Readiness — Blueprint Environment</h3>
          <p>Launch steps are determined dynamically by the resources defined in the blueprint.</p>
        </div>
        <div class="bp-info">
          <div class="bp-row"><span>Blueprint</span>     <strong>${stack.name || env.stackName || '—'}</strong></div>
          <div class="bp-row"><span>Branch</span>        <strong>${env.branch || stack.branch || 'main'}</strong></div>
          <div class="bp-row"><span>Project type</span>  <strong>${stack.projectTypeId || '—'}</strong></div>
          <div class="bp-row"><span>Resources defined</span> <strong>${resCount}</strong></div>
          <div class="bp-row"><span>Variables set</span>    <strong>${(this.varCounts && (this.varCounts.variableCount || 0)) || 0}</strong></div>
        </div>
        <div class="readiness-footer">
          <button class="cta-btn primary"    data-action="launch">Launch Environment</button>
          <button class="cta-btn secondary"  data-action="plan">Run Plan (Dry Run)</button>
        </div>
      </div>`;
  }

  _buildInfraIdentity(env, isLegacy, hasK8s) {
    const stack = env.stack || {};
    const cv    = env.componentVersions || {};
    const rows  = [];

    if (env.cloud && env.cloud !== 'NO_CLOUD')
      rows.push({ label: 'Cloud Provider', value: `${this._cloudIcon(env.cloud)} ${env.cloud}` });
    if (env.cloudAccountId)
      rows.push({ label: 'Cloud Account', value: env.cloudAccountId });

    if (isLegacy) {
      Object.entries(cv).forEach(([k, v]) =>
        rows.push({ label: this._humanize(k), value: v }));
    } else {
      if (stack.vcsUrl)       rows.push({ label: 'VCS', value: `<a href="${stack.vcsUrl}" target="_blank">${stack.vcsUrl}</a>` });
      if (stack.branch)       rows.push({ label: 'Blueprint Branch', value: stack.branch });
      if (stack.projectTypeId) rows.push({ label: 'Project Type', value: stack.projectTypeId });
      if (stack.primaryCloud) rows.push({ label: 'Primary Cloud', value: stack.primaryCloud });
      if (stack.allowedClouds && stack.allowedClouds.length)
        rows.push({ label: 'Allowed Clouds', value: stack.allowedClouds.join(', ') });
      Object.entries(cv).forEach(([k, v]) =>
        rows.push({ label: this._humanize(k), value: v }));
    }

    if (env.namespace)
      rows.push({ label: 'Namespace', value: env.namespace });

    if (hasK8s) {
      rows.push({ label: 'K8s Credentials', value: env.hasK8sCredentials ? '✓ Configured' : '✗ Not configured' });
      if (env.k8sRequestsToLimitsRatio != null)
        rows.push({ label: 'K8s Req/Limit Ratio', value: env.k8sRequestsToLimitsRatio });
    }

    if (env.baseClusterName)
      rows.push({ label: 'Base Environment', value: env.baseClusterName });
    if (env.cdPipelineParent)
      rows.push({ label: 'CD Pipeline Parent', value: env.cdPipelineParent });
    if (env.lastModifiedBy)
      rows.push({ label: 'Last Modified By', value: env.lastModifiedBy });
    if (env.lastModifiedDate)
      rows.push({ label: 'Last Modified', value: this._fmtDate(env.lastModifiedDate) });

    if (rows.length === 0) return '';

    return `
      <div class="sec-card">
        <div class="sec-title">Infrastructure Identity</div>
        <div class="info-grid">
          ${rows.map(r => `
            <div class="info-row">
              <span class="info-lbl">${r.label}</span>
              <span class="info-val">${r.value}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  _buildDownstream(names, stackName) {
    return `
      <div class="sec-card">
        <div class="sec-title">Downstream Environments (${names.length})</div>
        <div class="downstream-list">
          ${names.map(n => `
            <div class="downstream-item">
              <span>${n}</span>
              <button class="mini-btn nav-btn" data-href="/projects/${stackName}/environments/${n}">View</button>
            </div>`).join('')}
        </div>
        <div class="sec-note">⚠ This environment cannot be destroyed while downstream environments are running.</div>
      </div>`;
  }

  _buildCostTeaser(env) {
    return `
      <div class="sec-card">
        <div class="sec-title-row">
          <span class="sec-title">Cost Explorer</span>
          <button class="cta-btn secondary" data-action="open-cost">Open Cost Explorer</button>
        </div>
        <p style="font-size:13px;color:var(--muted)">View daily and service-wise cloud cost breakdown for this environment.</p>
      </div>`;
  }

  // ── Releases Tab ───────────────────────────────────────────────────────────

  _buildReleasesTab() {
    const ds    = (this.overview && this.overview.deploymentsStats) || {};
    const total = (ds.successReleases || 0) + (ds.failedReleases || 0) + (ds.noChangeReleases || 0);
    const sp    = total > 0 ? Math.round((ds.successReleases || 0) / total * 100) : 0;
    const fp    = total > 0 ? Math.round((ds.failedReleases  || 0) / total * 100) : 0;
    const np    = total > 0 ? Math.round((ds.noChangeReleases|| 0) / total * 100) : 0;

    const deps = this.deployments;
    let tableHtml;
    if (!deps) {
      tableHtml = '<div class="loading-inline">Loading release history…</div>';
    } else {
      const list = Array.isArray(deps) ? deps
        : (deps.content || deps.deployments || deps.items || []);
      if (!list.length) {
        tableHtml = '<div class="empty-state">No releases yet. Trigger your first release.</div>';
      } else {
        tableHtml = `
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Type</th><th>Status</th><th>Triggered By</th>
                  <th>Started</th><th>Duration</th><th>Changes</th><th></th>
                </tr>
              </thead>
              <tbody>
                ${list.slice(0, 25).map(d => {
                  const dc      = this._depStatusConf(d.status);
                  const dur     = d.timeTakenInSeconds ? this._fmtDur(d.timeTakenInSeconds) : '—';
                  const changes = (d.changesApplied && d.changesApplied.length) || 0;
                  const rt      = (d.releaseType || '').toLowerCase();
                  return `
                    <tr>
                      <td><span class="rt-badge ${rt}">${d.releaseType || '—'}</span></td>
                      <td><span style="color:${dc.color};font-weight:600;font-size:12px">${dc.icon} ${d.status}</span></td>
                      <td>${d.triggeredBy || '—'}</td>
                      <td title="${d.createdOn||''}">${this._fmtRel(d.createdOn)}</td>
                      <td>${dur}</td>
                      <td>${changes > 0 ? `<span class="change-pill">${changes}</span>` : '—'}</td>
                      <td>
                        <button class="mini-btn dep-logs-btn" data-dep-id="${d.id}">Logs</button>
                        ${d.status === 'PENDING_APPROVAL'
                          ? `<button class="mini-btn approve-btn cta-btn" data-action="approve" data-dep="${d.id}" style="margin-left:4px">Approve</button>`
                          : ''}
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`;
      }
    }

    return `
      <div class="tab-panel">
        <div class="sec-card">
          <div class="sec-title-row">
            <span class="sec-title">Release Statistics</span>
          </div>
          <div class="stats-row">
            <div class="stat-box"><div class="stat-n green">${ds.successReleases || 0}</div><div class="stat-lbl">Successful</div></div>
            <div class="stat-box"><div class="stat-n red">${ds.failedReleases || 0}</div><div class="stat-lbl">Failed</div></div>
            <div class="stat-box"><div class="stat-n grey">${ds.noChangeReleases || 0}</div><div class="stat-lbl">No Changes</div></div>
            <div class="stat-box"><div class="stat-n">${total}</div><div class="stat-lbl">Total</div></div>
          </div>
          ${total > 0 ? `
            <div class="bar-track">
              <div class="bar-seg green" style="width:${sp}%" title="${sp}% success"></div>
              <div class="bar-seg red"   style="width:${fp}%" title="${fp}% failed"></div>
              <div class="bar-seg grey"  style="width:${np}%" title="${np}% no change"></div>
            </div>` : ''}
        </div>

        <div class="sec-card">
          <div class="sec-title-row">
            <span class="sec-title">Release History</span>
            <div class="sec-actions">
              <button class="cta-btn primary"   data-action="trigger-release">Trigger Release</button>
              <button class="cta-btn secondary" data-action="trigger-hotfix">Hotfix</button>
              <button class="cta-btn secondary" data-action="run-plan">Run Plan</button>
            </div>
          </div>
          ${tableHtml}
        </div>
      </div>`;
  }

  // ── Resources Tab ──────────────────────────────────────────────────────────

  _buildResourcesTab() {
    const hasK8s = this._hasKubernetes();
    const resList = this.resources;
    const ingList = this.ingresses;

    let resourcesHtml;
    if (!resList) {
      resourcesHtml = '<div class="loading-inline">Loading resources…</div>';
    } else {
      const items = Array.isArray(resList) ? resList
        : (resList.content || resList.resources || resList.items || []);

      if (!items.length) {
        resourcesHtml = '<div class="empty-state">No resources configured in this environment.</div>';
      } else {
        // Group by type for tiles
        const byType = {};
        items.forEach(r => {
          const t = r.resourceType || r.type || 'unknown';
          byType[t] = (byType[t] || 0) + 1;
        });

        resourcesHtml = `
          <div class="type-tiles">
            ${Object.entries(byType).map(([type, count]) => `
              <div class="type-tile">
                <div class="type-n">${count}</div>
                <div class="type-lbl">${type}</div>
              </div>`).join('')}
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr><th>Type</th><th>Name</th><th>Status</th><th>Override</th><th></th></tr>
              </thead>
              <tbody>
                ${items.map(r => {
                  const name    = r.resourceName || r.name || '—';
                  const type    = r.resourceType  || r.type || '—';
                  const enabled = r.disabled === false || r.enabled === true || (!r.disabled && r.enabled !== false);
                  const hasOvr  = r.override || r.overrideExists || r.hasOverride;
                  return `
                    <tr>
                      <td><span class="type-badge">${type}</span></td>
                      <td>${name}</td>
                      <td><span class="dot-badge ${enabled ? 'active' : 'inactive'}">${enabled ? 'Active' : 'Disabled'}</span></td>
                      <td>${hasOvr ? '<span class="ovr-badge">Override</span>' : '—'}</td>
                      <td>
                        <button class="mini-btn view-res-btn"
                          data-rtype="${type}" data-rname="${name}">View</button>
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`;
      }
    }

    // Ingress / endpoints — only if K8s present
    let ingressSection = '';
    if (hasK8s) {
      let ingressHtml;
      if (!ingList) {
        ingressHtml = '<div class="loading-inline">Loading endpoints…</div>';
      } else {
        const rules = ingList.ingressRules || ingList.rules || (Array.isArray(ingList) ? ingList : []);
        if (!rules.length) {
          ingressHtml = '<div class="empty-state">No ingress rules found.</div>';
        } else {
          ingressHtml = `
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>Host</th><th>Path</th><th>Service</th><th>Port</th><th></th></tr>
                </thead>
                <tbody>
                  ${rules.map(r => {
                    const host = r.host || r.hostname || '';
                    const path = r.path || r.pathPrefix || '/';
                    const url  = host ? `https://${host}${path}` : null;
                    return `
                      <tr>
                        <td>${host || '—'}</td>
                        <td>${path}</td>
                        <td>${r.serviceName || r.service || '—'}</td>
                        <td>${r.port || r.servicePort || '—'}</td>
                        <td>
                          ${url ? `<button class="mini-btn copy-url-btn" data-url="${url}">Copy URL</button>` : ''}
                        </td>
                      </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>`;
        }
      }
      ingressSection = `
        <div class="sec-card">
          <div class="sec-title">Exposed Endpoints (Ingress)</div>
          ${ingressHtml}
        </div>`;
    }

    return `
      <div class="tab-panel">
        <div class="sec-card">
          <div class="sec-title-row">
            <span class="sec-title">Resources</span>
            <div class="sec-actions">
              <button class="cta-btn secondary" data-action="manage-resources">Manage Resources</button>
            </div>
          </div>
          ${resourcesHtml}
        </div>
        ${ingressSection}
        ${!hasK8s ? `
          <div class="sec-card info-note">
            <span>⎈ Kubernetes is not configured for this environment. Ingress endpoint data is unavailable.</span>
          </div>` : ''}
      </div>`;
  }

  // ── Config Tab ─────────────────────────────────────────────────────────────

  _buildConfigTab() {
    const env = this.env || {};
    const vc  = this.varCounts || {};
    const vars    = env.variables ? Object.entries(env.variables) : [];
    const comEnv  = env.commonEnvironmentVariables ? Object.entries(env.commonEnvironmentVariables) : [];
    const varCnt  = vc.variableCount  || vc.variables || vars.length || 0;
    const secCnt  = vc.secretCount    || vc.secrets   || 0;

    return `
      <div class="tab-panel">
        <div class="sec-card">
          <div class="sec-title-row">
            <span class="sec-title">Variables &amp; Secrets (${varCnt + secCnt})</span>
            <div class="sec-actions">
              <button class="cta-btn secondary" data-action="add-variable">+ Add Variable</button>
            </div>
          </div>
          ${vars.length > 0 ? `
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>Name</th><th>Type</th><th>Status</th><th>Description</th></tr>
                </thead>
                <tbody>
                  ${vars.map(([name, meta]) => `
                    <tr>
                      <td><code class="var-code">${name}</code></td>
                      <td>${meta.secret ? '<span class="secret-badge">Secret</span>' : 'Variable'}</td>
                      <td><span class="dot-badge ${meta.status === 'OVERRIDDEN' ? 'override' : 'default'}">${meta.status || 'DEFAULT'}</span></td>
                      <td style="color:var(--muted)">${meta.description || '—'}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>` : `
            <div class="empty-state">
              No variables configured.
              <button class="inline-link cta-btn" data-action="add-variable">Add the first one</button>
            </div>`}
        </div>

        ${comEnv.length > 0 ? `
          <div class="sec-card">
            <div class="sec-title">Common Environment Variables (${comEnv.length})</div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>Key</th><th>Value</th></tr></thead>
                <tbody>
                  ${comEnv.map(([k, v]) => `
                    <tr>
                      <td><code class="var-code">${k}</code></td>
                      <td>${v}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>` : ''}

        <div class="sec-card">
          <div class="sec-title-row">
            <span class="sec-title">Governance</span>
          </div>
          <div class="info-grid">
            <div class="info-row">
              <span class="info-lbl">Approval Required</span>
              <span class="info-val">
                <span class="toggle-badge ${env.requireSignOff ? 'on' : 'off'}">${env.requireSignOff ? 'Yes' : 'No'}</span>
              </span>
            </div>
            <div class="info-row">
              <span class="info-lbl">Auto Sign-off</span>
              <span class="info-val">
                <span class="toggle-badge ${env.enableAutoSignOff ? 'on' : 'off'}">${env.enableAutoSignOff ? 'Enabled' : 'Disabled'}</span>
                ${env.autoSignOffSchedule ? `<span style="font-size:11px;color:var(--muted);margin-left:.5rem">${env.autoSignOffSchedule}</span>` : ''}
              </span>
            </div>
            <div class="info-row">
              <span class="info-lbl">Releases Paused</span>
              <span class="info-val">
                <span class="toggle-badge ${env.pauseReleases ? 'warn' : 'off'}">${env.pauseReleases ? 'Paused' : 'Active'}</span>
                ${env.pauseReleases ? `<button class="mini-btn cta-btn" data-action="resume-releases" style="margin-left:.5rem">Resume</button>` : ''}
              </span>
            </div>
            <div class="info-row">
              <span class="info-lbl">Release Stream</span>
              <span class="info-val">${env.releaseStream || '—'}</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ── Schedule Tab ───────────────────────────────────────────────────────────

  _buildScheduleTab() {
    const sched = this.schedule;
    const mw    = this.maintenanceWin;
    const env   = this.env || {};

    let schedHtml;
    if (!sched) {
      schedHtml = '<div class="loading-inline">Loading schedules…</div>';
    } else {
      const list = Array.isArray(sched) ? sched : (sched.content || sched.schedules || []);
      if (!list.length) {
        schedHtml = `
          <div class="empty-state">
            No availability schedules configured.
            <button class="inline-link cta-btn" data-action="add-schedule">Set up a schedule</button>
            to automatically start and stop this environment.
          </div>`;
      } else {
        schedHtml = `
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr><th>Name</th><th>Start (cron)</th><th>Stop (cron)</th><th>Timezone</th><th>Status</th></tr>
              </thead>
              <tbody>
                ${list.map(s => `
                  <tr>
                    <td>${s.name || s.scheduleName || '—'}</td>
                    <td><code class="var-code">${s.startCron || s.startExpression || '—'}</code></td>
                    <td><code class="var-code">${s.stopCron  || s.stopExpression  || '—'}</code></td>
                    <td>${s.timezone || s.tz || '—'}</td>
                    <td><span class="toggle-badge ${s.enabled !== false ? 'on' : 'off'}">${s.enabled !== false ? 'Active' : 'Disabled'}</span></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
      }
    }

    const mwEnabled = mw && mw.enabled;

    return `
      <div class="tab-panel">
        ${env.isEphemeral ? `
          <div class="banner banner-info" style="margin-bottom:0">
            <span class="banner-icon">⚡</span>
            <span>This is an <strong>ephemeral environment</strong> — it will be automatically destroyed at the scheduled teardown time.</span>
          </div>` : ''}

        <div class="sec-card">
          <div class="sec-title-row">
            <span class="sec-title">Availability Schedules</span>
            <div class="sec-actions">
              <button class="cta-btn secondary" data-action="add-schedule">+ Add Schedule</button>
            </div>
          </div>
          ${schedHtml}
        </div>

        <div class="sec-card">
          <div class="sec-title-row">
            <span class="sec-title">Maintenance Window</span>
            <div class="sec-actions">
              <button class="cta-btn secondary cta-btn" data-action="toggle-maintenance">
                ${mwEnabled ? 'Disable' : 'Enable'} Maintenance
              </button>
            </div>
          </div>
          ${!mw ? '<div class="loading-inline">Loading…</div>' : `
            <div class="info-grid">
              <div class="info-row">
                <span class="info-lbl">Status</span>
                <span class="info-val">
                  <span class="toggle-badge ${mwEnabled ? 'on' : 'off'}">${mwEnabled ? 'Active' : 'Inactive'}</span>
                </span>
              </div>
              ${mwEnabled ? `
                <div class="info-row">
                  <span class="info-lbl">Start</span>
                  <span class="info-val"><code class="var-code">${mw.startCron || mw.startTime || '—'}</code></span>
                </div>
                <div class="info-row">
                  <span class="info-lbl">End</span>
                  <span class="info-val"><code class="var-code">${mw.endCron || mw.endTime || '—'}</code></span>
                </div>` : ''}
            </div>`}
        </div>
      </div>`;
  }

  // ── CTA Handling ───────────────────────────────────────────────────────────

  _handleCTA(action, event) {
    const env   = this.env || {};
    const depId = event && event.target
      ? (event.target.closest('[data-dep]') || {}).dataset && event.target.closest('[data-dep]').dataset.dep
      : null;

    const base = `/projects/${env.stackName}/environments/${env.name}`;

    const routes = {
      'launch':           `${base}/launch`,
      'plan':             `${base}/releases/plan`,
      'run-plan':         `${base}/releases/plan`,
      'trigger-release':  `${base}/releases/new`,
      'trigger-hotfix':   `${base}/releases/hotfix`,
      'scale-up':         `${base}/scale-up`,
      'scale-down':       `${base}/scale-down`,
      'resume-releases':  `${base}/settings?action=resume-releases`,
      'add-variable':     `${base}/settings?tab=variables`,
      'add-schedule':     `${base}/settings?tab=schedule`,
      'toggle-maintenance': `${base}/settings?tab=maintenance`,
      'manage-resources': `${base}/resources`,
      'open-cost':        `/projects/${env.stackName}/cost`,
      'destroy':          `${base}/destroy`
    };

    if (action === 'approve' && depId) return this._navigate(`${base}/releases/${depId}?action=approve`);
    if (action === 'reject'  && depId) return this._navigate(`${base}/releases/${depId}?action=reject`);
    if (action === 'abort'   && depId) return this._navigate(`${base}/releases/${depId}?action=abort`);

    const route = routes[action];
    if (route) this._navigate(route);
  }

  _navigate(route) {
    this.dispatchEvent(new CustomEvent('facets-navigate', {
      bubbles: true, composed: true,
      detail: { route }
    }));
  }

  // ── Post-render event wiring ───────────────────────────────────────────────

  _attachTabListeners() {
    const root = this.shadowRoot;

    root.querySelectorAll('#tab-content .cta-btn[data-action]').forEach(b =>
      b.addEventListener('click', e => this._handleCTA(b.dataset.action, e)));

    root.querySelectorAll('.copy-url-btn').forEach(b =>
      b.addEventListener('click', () => {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(b.dataset.url).then(() => {
            const orig = b.textContent;
            b.textContent = 'Copied!';
            setTimeout(() => { b.textContent = orig; }, 2000);
          });
        }
      }));

    root.querySelectorAll('.dep-logs-btn').forEach(b =>
      b.addEventListener('click', () => {
        const env = this.env || {};
        this._navigate(`/projects/${env.stackName}/environments/${env.name}/releases/${b.dataset.depId}`);
      }));

    root.querySelectorAll('.nav-btn[data-href]').forEach(b =>
      b.addEventListener('click', () => this._navigate(b.dataset.href)));

    root.querySelectorAll('.view-res-btn').forEach(b =>
      b.addEventListener('click', () => {
        const env = this.env || {};
        this._navigate(`/projects/${env.stackName}/environments/${env.name}/resources/${b.dataset.rtype}/${b.dataset.rname}`);
      }));
  }

  _showBootError(msg) {
    const lo = this.shadowRoot.getElementById('loading-overlay');
    if (lo) lo.style.display = 'none';
    this.shadowRoot.getElementById('header-section').innerHTML =
      `<div class="boot-error">${msg}</div>`;
  }

  // ── Picker (no context available) ─────────────────────────────────────────

  _showPicker() {
    var lo = this.shadowRoot.getElementById('loading-overlay');
    if (lo) lo.style.display = 'none';

    var root = this.shadowRoot;
    root.getElementById('header-section').innerHTML = '';
    root.getElementById('banners-section').innerHTML = '';
    root.getElementById('cards-section').innerHTML   = '';
    root.getElementById('tabs-nav').innerHTML        = '';
    root.getElementById('tab-content').innerHTML     = `
      <div class="picker-wrap">
        <div class="picker-card">
          <div class="picker-title">
            <span class="picker-icon">🌐</span>
            Environment Overview
          </div>
          <p class="picker-sub">Select a project and environment to view its overview.</p>

          <div class="picker-field">
            <label class="picker-label">Project</label>
            <select id="proj-select" class="picker-select">
              <option value="">Loading projects…</option>
            </select>
          </div>

          <div class="picker-field" id="env-field" style="display:none">
            <label class="picker-label">Environment</label>
            <select id="env-select" class="picker-select">
              <option value="">Select environment…</option>
            </select>
          </div>

          <div id="picker-error" class="picker-error" style="display:none"></div>

          <button class="cta-btn primary picker-go" id="picker-go" disabled>
            View Environment
          </button>
        </div>
      </div>`;

    this._loadPickerProjects();
    this._attachPickerListeners();
  }

  async _loadPickerProjects() {
    var data = await this._api('/cc-ui/v1/stacks/');
    var sel  = this.shadowRoot.getElementById('proj-select');
    if (!sel) return;

    if (!data) {
      sel.innerHTML = '<option value="">Failed to load projects</option>';
      return;
    }

    var list = Array.isArray(data) ? data : (data.content || data.stacks || data.items || []);
    if (!list.length) {
      sel.innerHTML = '<option value="">No projects found</option>';
      return;
    }

    list.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
    sel.innerHTML = '<option value="">— Select project —</option>' +
      list.map(function(s) {
        return '<option value="' + (s.name || s.stackName) + '">' + (s.name || s.stackName) + '</option>';
      }).join('');
  }

  async _loadPickerEnvironments(stackName) {
    var envField = this.shadowRoot.getElementById('env-field');
    var sel      = this.shadowRoot.getElementById('env-select');
    if (!envField || !sel) return;

    envField.style.display = 'block';
    sel.innerHTML = '<option value="">Loading environments…</option>';

    var data = await this._api('/cc-ui/v1/stacks/' + encodeURIComponent(stackName) + '/clusters-overview');
    if (!data) {
      sel.innerHTML = '<option value="">Failed to load environments</option>';
      return;
    }

    var list = Array.isArray(data) ? data : (data.content || data.clusters || data.items || []);
    if (!list.length) {
      sel.innerHTML = '<option value="">No environments found</option>';
      return;
    }

    list.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
    sel.innerHTML = '<option value="">— Select environment —</option>' +
      list.map(function(c) {
        var state = c.clusterState || c.state || '';
        var id    = c.id || c.clusterId || '';
        return '<option value="' + id + '" data-name="' + (c.name || '') + '">' +
          (c.name || id) + (state ? ' (' + state + ')' : '') + '</option>';
      }).join('');
  }

  _attachPickerListeners() {
    var self = this;
    var root = this.shadowRoot;

    var projSel = root.getElementById('proj-select');
    var envSel  = root.getElementById('env-select');
    var goBtn   = root.getElementById('picker-go');

    if (projSel) {
      projSel.addEventListener('change', function() {
        var stack = projSel.value;
        var envField = root.getElementById('env-field');
        if (envField) envField.style.display = 'none';
        if (envSel)  envSel.innerHTML = '<option value="">Select environment…</option>';
        if (goBtn)   goBtn.disabled = true;
        if (stack) self._loadPickerEnvironments(stack);
      });
    }

    if (envSel) {
      envSel.addEventListener('change', function() {
        if (goBtn) goBtn.disabled = !envSel.value;
      });
    }

    if (goBtn) {
      goBtn.addEventListener('click', function() {
        var cid = envSel && envSel.value;
        if (!cid) return;
        self.clusterId = cid;
        // Reset data state
        self.overview = null; self.env = null; self.resourceStats = null;
        self.varCounts = null; self.deployments = null; self.resources = null;
        self.ingresses = null; self.schedule = null; self.maintenanceWin = null;
        self.isLoading = true;
        // Re-render loading state
        root.getElementById('tab-content').innerHTML = '';
        root.getElementById('loading-overlay').style.display = 'flex';
        self._loadData();
      });
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _hasKubernetes() {
    const env = this.env;
    if (!env) return false;
    if (env.cloud === 'KUBERNETES') return true;
    if (env.hasK8sCredentials === true) return true;
    const cv = env.componentVersions || {};
    return Object.keys(cv).some(k =>
      k.toLowerCase().includes('kubernetes') || k.toLowerCase().includes('k8s'));
  }

  _stateConf(state) {
    const map = {
      RUNNING:          { label:'Running',          bg:'#e8f5e9', color:'#1b5e20', border:'#a5d6a7', dot:'#2e7d32', pulse:false },
      LAUNCHING:        { label:'Launching',         bg:'#fff8e1', color:'#e65100', border:'#ffe082', dot:'#ff9800', pulse:true  },
      SCALING_UP:       { label:'Scaling Up',        bg:'#e3f2fd', color:'#0d47a1', border:'#90caf9', dot:'#1565c0', pulse:true  },
      SCALING_DOWN:     { label:'Scaling Down',      bg:'#e3f2fd', color:'#0d47a1', border:'#90caf9', dot:'#1565c0', pulse:true  },
      DESTROYING:       { label:'Destroying',        bg:'#fff3e0', color:'#bf360c', border:'#ffcc80', dot:'#e64a19', pulse:true  },
      STOPPED:          { label:'Stopped',           bg:'#f5f5f5', color:'#424242', border:'#e0e0e0', dot:'#9e9e9e', pulse:false },
      SCALE_DOWN:       { label:'Scaled Down',       bg:'#e8eaf6', color:'#283593', border:'#9fa8da', dot:'#3f51b5', pulse:false },
      LAUNCH_FAILED:    { label:'Launch Failed',     bg:'#ffebee', color:'#b71c1c', border:'#ef9a9a', dot:'#c62828', pulse:false },
      DESTROY_FAILED:   { label:'Destroy Failed',    bg:'#ffebee', color:'#b71c1c', border:'#ef9a9a', dot:'#c62828', pulse:false },
      SCALE_DOWN_FAILED:{ label:'Scale-Down Failed', bg:'#ffebee', color:'#b71c1c', border:'#ef9a9a', dot:'#c62828', pulse:false },
      SCALE_UP_FAILED:  { label:'Scale-Up Failed',   bg:'#ffebee', color:'#b71c1c', border:'#ef9a9a', dot:'#c62828', pulse:false },
      UNKNOWN:          { label:'Unknown',           bg:'#f5f5f5', color:'#616161', border:'#e0e0e0', dot:'#9e9e9e', pulse:false }
    };
    return map[state] || map.UNKNOWN;
  }

  _depStatusConf(status) {
    const map = {
      SUCCEEDED:        { icon:'✓', color:'#2e7d32' },
      FAILED:           { icon:'✗', color:'#c62828' },
      FAULT:            { icon:'✗', color:'#c62828' },
      TIMED_OUT:        { icon:'⏱', color:'#e65100' },
      IN_PROGRESS:      { icon:'⚡', color:'#1565c0' },
      STARTED:          { icon:'⚡', color:'#1565c0' },
      QUEUED:           { icon:'⏳', color:'#546e7a' },
      PENDING_APPROVAL: { icon:'⏳', color:'#f57f17' },
      APPROVED:         { icon:'✓', color:'#1b5e20' },
      ABORTED:          { icon:'⬛', color:'#616161' },
      STOPPED:          { icon:'⬛', color:'#616161' },
      REJECTED:         { icon:'✗', color:'#c62828' }
    };
    return map[status] || { icon:'?', color:'#9e9e9e' };
  }

  _headerCTAs(state, env) {
    const maps = {
      STOPPED:          [{ l:'Launch',          a:'launch',          p:true  }, { l:'Run Plan', a:'plan', p:false }],
      RUNNING:          [{ l:'Trigger Release', a:'trigger-release', p:true  }, { l:'Hotfix', a:'trigger-hotfix', p:false }, { l:'Scale Down', a:'scale-down', p:false }, { l:'Destroy', a:'destroy', p:false, d:true }],
      SCALE_DOWN:       [{ l:'Scale Up',        a:'scale-up',        p:true  }, { l:'Trigger Release', a:'trigger-release', p:false }, { l:'Destroy', a:'destroy', p:false, d:true }],
      LAUNCH_FAILED:    [{ l:'Retry Launch',    a:'launch',          p:true  }, { l:'Run Plan', a:'plan', p:false }],
      DESTROY_FAILED:   [{ l:'Retry Destroy',   a:'destroy',         p:true, d:true }],
      SCALE_UP_FAILED:  [{ l:'Retry Scale Up',  a:'scale-up',        p:true  }],
      SCALE_DOWN_FAILED:[{ l:'Retry Scale Down',a:'scale-down',      p:true  }],
      LAUNCHING:        [],
      DESTROYING:       [],
      SCALING_UP:       [],
      SCALING_DOWN:     []
    };
    const ctas = maps[state] || maps.STOPPED;
    return ctas.map(c =>
      `<button class="cta-btn ${c.p ? 'primary' : 'secondary'}${c.d ? ' danger' : ''}" data-action="${c.a}">${c.l}</button>`
    ).join('');
  }

  _cloudIcon(cloud) {
    const m = { AWS:'☁', GCP:'☁', AZURE:'☁', KUBERNETES:'⎈', LOCAL:'⬡', NO_CLOUD:'○' };
    return m[cloud] || '○';
  }

  _humanize(str) {
    return str.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^\w/, c => c.toUpperCase()).trim();
  }

  _fmtDate(d) {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
  }

  _fmtRel(d) {
    if (!d) return '—';
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60)    return 'just now';
    if (s < 3600)  return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  }

  _fmtElapsed(d) {
    if (!d) return '';
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60)   return `${s}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  }

  _fmtDur(seconds) {
    if (!seconds) return '—';
    if (seconds < 60)   return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds/60)}m ${seconds%60}s`;
    return `${Math.floor(seconds/3600)}h ${Math.floor((seconds%3600)/60)}m`;
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  _styles() {
    return `
      :host {
        display: block;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        color: #1a1a1a;
        --primary: #0050b3;
        --primary-h: #003a8c;
        --border: #e0e0e0;
        --bg: #f4f6f9;
        --card: #ffffff;
        --muted: #666;
        --danger: #d32f2f;
        --green: #2e7d32;
        --orange: #e65100;
      }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      a { color: var(--primary); text-decoration: none; }
      a:hover { text-decoration: underline; }

      /* ── Animations ── */
      @keyframes spin  { to { transform: rotate(360deg); } }
      @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.25 } }

      /* ── Wrapper ── */
      .wrapper { min-height: 100vh; background: var(--bg); }

      /* ── Loading overlay ── */
      .loading-overlay {
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; min-height: 320px; gap: .75rem;
        color: var(--muted); font-size: 13px;
      }
      .spinner {
        width: 32px; height: 32px; border: 3px solid var(--border);
        border-top-color: var(--primary); border-radius: 50%;
        animation: spin .75s linear infinite;
      }

      /* ── Boot error ── */
      .boot-error {
        margin: 1.5rem; padding: 1rem 1.25rem; background: #fff0f0;
        border: 1px solid #ffcdd2; border-radius: 8px; color: var(--danger); font-size: 13px;
      }

      /* ── HEADER ── */
      .header { background: var(--card); border-bottom: 1px solid var(--border); padding: 1rem 1.5rem; }
      .header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
      .header-identity { display: flex; flex-direction: column; gap: .4rem; }
      .breadcrumb { display: flex; align-items: center; gap: .4rem; font-size: 13px; }
      .breadcrumb-proj { color: var(--primary); font-weight: 500; cursor: pointer; }
      .breadcrumb-sep  { color: #bbb; }
      .breadcrumb-env  { font-size: 1.1rem; font-weight: 700; color: #111; }
      .header-badges { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-top: .2rem; }
      .header-ctas   { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; padding-top: .2rem; }
      .header-meta   {
        display: flex; align-items: center; gap: .75rem; flex-wrap: wrap;
        margin-top: .65rem; font-size: 12px; color: var(--muted);
      }
      .meta-item { display: flex; align-items: center; gap: .25rem; }

      /* ── State pill ── */
      .state-pill {
        display: inline-flex; align-items: center; gap: .35rem;
        padding: .22rem .7rem; border-radius: 20px; border: 1px solid;
        font-size: 12px; font-weight: 600;
      }
      .state-pill.sm { font-size: 11px; padding: .18rem .55rem; }
      .state-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

      /* ── Cloud / K8s badges ── */
      .cloud-badge {
        display: inline-flex; align-items: center; gap: .25rem;
        padding: .18rem .55rem; background: #f0f0f0; border-radius: 4px;
        font-size: 11px; font-weight: 500; color: #333;
      }
      .k8s-badge { background: #e3f2fd; color: #1565c0; }
      .ns-badge  { background: #f3e5f5; color: #6a1b9a; }

      /* ── Tags ── */
      .tag {
        display: inline-flex; align-items: center;
        padding: .13rem .5rem; border-radius: 4px; font-size: 11px; font-weight: 500;
      }
      .tag-eph  { background: #fff3e0; color: #e65100; }
      .tag-base { background: #e8eaf6; color: #3949ab; }
      .tag-warn { background: #fff8e1; color: #f57f17; }
      .tag-info { background: #e3f2fd; color: #1565c0; }
      .tag-new  { background: #e8f5e9; color: #2e7d32; }

      /* ── CTA Buttons ── */
      .cta-btn {
        padding: .38rem .85rem; border-radius: 5px; border: 1px solid;
        cursor: pointer; font-size: 13px; font-weight: 500; transition: background .12s, color .12s;
        white-space: nowrap;
      }
      .cta-btn.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
      .cta-btn.primary:hover { background: var(--primary-h); }
      .cta-btn.secondary { background: #fff; color: var(--primary); border-color: var(--primary); }
      .cta-btn.secondary:hover { background: #f0f5ff; }
      .cta-btn.danger { background: #fff; color: var(--danger); border-color: var(--danger); }
      .cta-btn.danger:hover { background: #ffebee; }
      .cta-btn.dim { opacity: .5; cursor: not-allowed; }
      .inline-link { background: none; border: none; color: var(--primary); cursor: pointer; text-decoration: underline; font-size: 13px; padding: 0; }
      .mini-btn {
        padding: .18rem .55rem; border-radius: 4px; border: 1px solid var(--border);
        background: #fff; cursor: pointer; font-size: 12px; color: var(--primary);
        white-space: nowrap;
      }
      .mini-btn:hover { background: #f0f5ff; }

      /* ── Banners ── */
      .banner {
        display: flex; align-items: center; gap: .75rem;
        padding: .55rem 1.5rem; font-size: 13px; border-bottom: 1px solid;
        flex-wrap: wrap;
      }
      .banner-info   { background: #e3f2fd; border-color: #90caf9; color: #0d47a1; }
      .banner-warn   { background: #fff8e1; border-color: #ffe082; color: #e65100; }
      .banner-subtle { background: #f8f8f8; border-color: var(--border); color: var(--muted); }
      .banner-icon   { font-size: 1rem; flex-shrink: 0; }
      .banner-actions { display: flex; gap: .4rem; margin-left: auto; }
      .banner-btn {
        padding: .18rem .65rem; border-radius: 4px; border: 1px solid currentColor;
        background: transparent; cursor: pointer; font-size: 12px; color: inherit;
      }
      .b-primary { color: var(--primary); border-color: var(--primary); }
      .b-success { color: #2e7d32; border-color: #a5d6a7; background: #e8f5e9; }
      .b-danger  { color: var(--danger); border-color: #ef9a9a; background: #ffebee; }

      /* ── Status Cards ── */
      .cards-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 1px; background: var(--border);
        border-bottom: 1px solid var(--border);
      }
      .scard { background: var(--card); padding: .85rem 1.25rem; }
      .scard-label {
        font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .06em; color: var(--muted); margin-bottom: .3rem;
      }
      .scard-num  { font-size: 1.85rem; font-weight: 800; line-height: 1.1; }
      .scard-sub  { font-size: 11px; color: var(--muted); margin-top: .2rem; }
      .card-na    { color: #aaa; font-style: italic; font-size: 12px; }
      .last-rel   { display: flex; flex-direction: column; gap: .12rem; }
      .rel-status { font-size: 13px; font-weight: 600; }
      .rel-meta   { font-size: 11px; color: var(--muted); }
      .rel-by     { font-size: 11px; color: var(--muted); }

      /* ── Tabs bar ── */
      .tabs-bar {
        display: flex; align-items: center; background: var(--card);
        border-bottom: 2px solid var(--border); padding: 0 1.5rem;
      }
      .tab-btn {
        padding: .7rem 1rem; border: none; background: none; cursor: pointer;
        font-size: 13px; font-weight: 500; color: var(--muted);
        border-bottom: 2px solid transparent; margin-bottom: -2px; transition: color .12s;
        white-space: nowrap;
      }
      .tab-btn:hover { color: var(--primary); }
      .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); font-weight: 600; }
      .tab-flex  { flex: 1; }
      .refresh-btn {
        padding: .35rem .7rem; border: 1px solid var(--border); background: #fff;
        border-radius: 4px; cursor: pointer; font-size: 12px; color: var(--muted);
        margin: .4rem 0;
      }
      .refresh-btn:hover { background: #f5f5f5; }

      /* ── Tab panel ── */
      .tab-panel { padding: 1.25rem 1.5rem; display: flex; flex-direction: column; gap: .9rem; }

      /* ── Section cards ── */
      .sec-card {
        background: var(--card); border: 1px solid var(--border);
        border-radius: 8px; padding: 1.1rem 1.25rem;
      }
      .sec-title { font-size: 14px; font-weight: 600; color: #111; display: block; margin-bottom: .75rem; }
      .sec-title-row {
        display: flex; align-items:center; justify-content: space-between;
        margin-bottom: .9rem; flex-wrap: wrap; gap: .5rem;
      }
      .sec-title-row .sec-title { margin-bottom: 0; }
      .sec-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
      .sec-note {
        font-size: 12px; color: #e65100; margin-top: .75rem;
        padding: .45rem .65rem; background: #fff8e1; border-radius: 4px;
      }
      .info-note {
        font-size: 12px; color: var(--muted);
        padding: .65rem 1rem; border-style: dashed;
      }

      /* ── Launch readiness ── */
      .readiness-card {
        background: var(--card); border: 2px dashed #d0d0d0;
        border-radius: 8px; padding: 1.25rem;
      }
      .readiness-header { margin-bottom: 1rem; }
      .readiness-header h3 { font-size: 15px; font-weight: 600; margin-bottom: .25rem; }
      .readiness-header p  { font-size: 13px; color: var(--muted); }
      .readiness-checks { display: flex; flex-direction: column; gap: .4rem; margin-bottom: 1.1rem; }
      .r-check {
        display: flex; align-items: flex-start; gap: .65rem;
        padding: .55rem .75rem; border-radius: 6px;
      }
      .r-check.ok   { background: #f1f9f3; }
      .r-check.todo { background: #fafafa; border: 1px solid var(--border); }
      .r-icon { font-size: 1rem; color: #2e7d32; line-height: 1.3; }
      .r-check.todo .r-icon { color: #bbb; }
      .r-body  { display: flex; flex-direction: column; gap: .1rem; }
      .r-label { font-size: 13px; font-weight: 500; }
      .r-hint  { font-size: 11px; color: var(--muted); }
      .readiness-footer { display: flex; gap: .75rem; flex-wrap: wrap; }

      /* Blueprint info */
      .bp-info { display: flex; flex-direction: column; gap: .3rem; margin-bottom: 1.1rem; }
      .bp-row  {
        display: flex; justify-content: space-between; align-items: center;
        padding: .38rem 0; border-bottom: 1px solid #f4f4f4; font-size: 13px;
      }
      .bp-row span { color: var(--muted); }

      /* ── Info grid ── */
      .info-grid { display: flex; flex-direction: column; }
      .info-row {
        display: flex; align-items: baseline; gap: 1rem;
        padding: .38rem 0; border-bottom: 1px solid #f6f6f6; font-size: 13px;
      }
      .info-row:last-child { border-bottom: none; }
      .info-lbl { min-width: 160px; color: var(--muted); font-size: 12px; flex-shrink: 0; }
      .info-val { flex: 1; font-weight: 500; word-break: break-all; }

      /* ── Downstream ── */
      .downstream-list { display: flex; flex-direction: column; gap: .35rem; margin-bottom: .5rem; }
      .downstream-item {
        display: flex; align-items: center; justify-content: space-between;
        padding: .45rem .75rem; background: #f8f9fb; border-radius: 6px; font-size: 13px;
      }

      /* ── Cost teaser ── */

      /* ── Stats ── */
      .stats-row { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: .75rem; }
      .stat-box  { display: flex; flex-direction: column; gap: .1rem; }
      .stat-n    { font-size: 1.6rem; font-weight: 800; line-height: 1.1; }
      .stat-n.green { color: #2e7d32; }
      .stat-n.red   { color: #c62828; }
      .stat-n.grey  { color: #757575; }
      .stat-lbl { font-size: 11px; color: var(--muted); font-weight: 500; }
      .bar-track {
        height: 7px; display: flex; border-radius: 4px; overflow: hidden;
        background: #eee; margin-top: .4rem;
      }
      .bar-seg { height: 100%; transition: width .4s ease; }
      .bar-seg.green { background: #43a047; }
      .bar-seg.red   { background: #e53935; }
      .bar-seg.grey  { background: #bdbdbd; }

      /* ── Tables ── */
      .table-wrap { overflow-x: auto; }
      .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .data-table th {
        text-align: left; padding: .45rem .75rem; background: #f7f8fa;
        font-weight: 600; font-size: 11px; text-transform: uppercase;
        letter-spacing: .04em; color: var(--muted); border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .data-table td {
        padding: .55rem .75rem; border-bottom: 1px solid #f4f4f4;
        vertical-align: middle;
      }
      .data-table tr:last-child td { border-bottom: none; }
      .data-table tr:hover td { background: #fafafa; }

      /* ── Type tiles ── */
      .type-tiles { display: flex; gap: .65rem; flex-wrap: wrap; margin-bottom: .9rem; }
      .type-tile  {
        background: #f8f9fb; border: 1px solid var(--border);
        border-radius: 7px; padding: .65rem .9rem; min-width: 80px; text-align: center;
      }
      .type-n   { font-size: 1.35rem; font-weight: 700; color: var(--primary); }
      .type-lbl { font-size: 10px; color: var(--muted); margin-top: .15rem; text-transform: uppercase; letter-spacing: .04em; }

      /* ── Badges ── */
      .rt-badge {
        display: inline-block; padding: .1rem .45rem; border-radius: 4px;
        font-size: 11px; font-weight: 600; background: #e8eaf6; color: #3949ab;
        text-transform: uppercase;
      }
      .rt-badge.hotfix   { background: #fff3e0; color: #e65100; }
      .rt-badge.launch   { background: #e8f5e9; color: #2e7d32; }
      .rt-badge.destroy  { background: #ffebee; color: #c62828; }
      .rt-badge.scale_up, .rt-badge.scale_down { background: #e3f2fd; color: #1565c0; }
      .rt-badge.plan, .rt-badge.hotfix_plan, .rt-badge.apply_plan { background: #f3e5f5; color: #6a1b9a; }

      .change-pill  { font-size: 11px; padding: .1rem .4rem; background: #f3e5f5; color: #6a1b9a; border-radius: 4px; }
      .type-badge   { font-size: 11px; padding: .12rem .45rem; background: #e8eaf6; color: #3949ab; border-radius: 4px; }
      .ovr-badge    { font-size: 11px; padding: .1rem .4rem;  background: #fff3e0; color: #e65100; border-radius: 4px; }
      .secret-badge { font-size: 11px; padding: .1rem .4rem;  background: #fce4ec; color: #880e4f; border-radius: 4px; }
      .dot-badge    { font-size: 12px; font-weight: 500; }
      .dot-badge.active   { color: #2e7d32; }
      .dot-badge.inactive { color: #757575; }
      .dot-badge.override { color: #e65100; }
      .dot-badge.default  { color: #546e7a; }
      .toggle-badge {
        display: inline-block; padding: .13rem .55rem;
        border-radius: 10px; font-size: 11px; font-weight: 600;
      }
      .toggle-badge.on   { background: #e8f5e9; color: #1b5e20; }
      .toggle-badge.off  { background: #f5f5f5; color: #757575; }
      .toggle-badge.warn { background: #fff8e1; color: #e65100; }

      /* ── Config ── */
      .var-code {
        font-family: 'SFMono-Regular', Consolas, monospace;
        font-size: 12px; background: #f5f5f5;
        padding: .1rem .35rem; border-radius: 3px;
      }

      /* ── Misc ── */
      .loading-inline { padding: 1.5rem; text-align: center; color: var(--muted); font-size: 13px; }
      .empty-state    { padding: 1.5rem; text-align: center; color: var(--muted); font-size: 13px; }
      .approve-btn    { color: #2e7d32; border-color: #a5d6a7; background: #e8f5e9; }

      /* ── Picker ── */
      .picker-wrap {
        display: flex; align-items: center; justify-content: center;
        min-height: 70vh; padding: 2rem;
      }
      .picker-card {
        background: var(--card); border: 1px solid var(--border); border-radius: 12px;
        padding: 2rem 2.5rem; width: 100%; max-width: 420px;
        box-shadow: 0 4px 24px rgba(0,0,0,.07);
      }
      .picker-title {
        font-size: 1.1rem; font-weight: 700; color: #111;
        margin-bottom: .4rem; display: flex; align-items: center; gap: .5rem;
      }
      .picker-icon { font-size: 1.3rem; }
      .picker-sub  { font-size: 13px; color: var(--muted); margin-bottom: 1.5rem; }
      .picker-field { display: flex; flex-direction: column; gap: .35rem; margin-bottom: 1rem; }
      .picker-label { font-size: 12px; font-weight: 600; color: #444; }
      .picker-select {
        padding: .5rem .75rem; border: 1px solid var(--border); border-radius: 6px;
        font-size: 13px; color: #111; background: #fff; cursor: pointer;
        outline: none; appearance: auto;
      }
      .picker-select:focus { border-color: var(--primary); }
      .picker-error { color: var(--danger); font-size: 12px; margin-bottom: .75rem; }
      .picker-go { width: 100%; justify-content: center; padding: .6rem; font-size: 14px; margin-top: .5rem; }
    `;
  }
}

customElements.define('environment-overview', EnvironmentOverview);
