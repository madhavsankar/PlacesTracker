/**
 * PlacesTrackerClient — Modular Frontend Controller for the Interactive Vector World Map,
 * US 50-State Vector Map, Checklist Explorer, and Gemini AI Bar.
 */

class PlacesTrackerClient {
  constructor(naturalEarthNameMap) {
    this.naturalEarthNameMap = naturalEarthNameMap || {};
    this.googleIdToken = localStorage.getItem('places_google_id_token') || '';
    this.userEmail = localStorage.getItem('places_user_email') || '';
    const savedUser = this.userEmail || localStorage.getItem('places_user_id') || '';
    this.userId = this.normalizeUserId(savedUser);
    if (this.userId) {
      localStorage.setItem('places_user_id', this.userId);
    }
    this.activeSection = sessionStorage.getItem('places_active_section') || 'home';
    this.homeCategory = sessionStorage.getItem('places_home_cat') || 'city';
    this.activeTab = 'world';
    this.places = [];
    this.usGrid = [];
    this.filterCat = 'country';
    this.exploreCountryFilter = 'all';
    this.exploreStatusMode = 'bucket_list';
    this.myPlacesTile = 'countries_states';
    this.expandedContinents = {};
    this.expandedCountryStates = {};
    this.regionalMode = 'world';
    this.regionalLayerFilter = 'none';
    this.regionalStatusFilter = 'visited';
    this.visitedColor = localStorage.getItem('places_visited_color') || '#10b981';
    this.dreamColor = localStorage.getItem('places_dream_color') || '#f59e0b';
    this.worldTopo = null;
    this.usTopo = null;
    this.indiaGeo = null;
    this.canadaGeo = null;
    this.focusedCountry = null;
    this.focusedState = null;
    this.longPressTimer = null;
    this.suppressClickUntil = 0;
    this.worldZoomBehavior = null;
    this.currentZoomTransform = null;
    this.baseWorldProjection = null;
    this.worldSvgWidth = 900;
    this.worldSvgHeight = 400;
    this.viewportRaf = null;
    this.globeRotation = [-20, -20, 0];
    this.activeStatsCircle = 'countries';
    this.statsCircleStatusFilter = 'all';
    this.statsCircleSearch = '';
    this.regionalZoomBehavior = null;
    this.currentRegionalZoom = null;
    this.pendingImageBase64 = '';
    this.pendingImageMime = '';
    this.toastTimer = null;
    this.csvImportMode = 'append';
    this.activityLog = this.loadLocalActivityLog();
  }

  getActivityLogKey() {
    const safeId = (this.userId || 'default').replace(/[^a-z0-9_.-]/g, '_');
    return 'places_activity_log_v1_' + safeId;
  }

  loadLocalActivityLog() {
    try {
      const raw = localStorage.getItem(this.getActivityLogKey());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.slice(0, 25);
      }
    } catch (_) { }
    return [];
  }

  saveLocalActivityLog() {
    try {
      localStorage.setItem(
        this.getActivityLogKey(),
        JSON.stringify((this.activityLog || []).slice(0, 25))
      );
    } catch (_) { }
  }

  recordLocalActivity(p, prevStatus, nextStatus) {
    if (!p || prevStatus === nextStatus) return;
    let actionLabel = 'Updated';
    if (prevStatus === 'unvisited' && nextStatus === 'visited') {
      actionLabel = 'Added as Been';
    } else if (prevStatus === 'unvisited' && nextStatus === 'bucket_list') {
      actionLabel = 'Added as Want';
    } else if (prevStatus === 'bucket_list' && nextStatus === 'visited') {
      actionLabel = 'Converted from Want to Been';
    } else if (prevStatus === 'visited' && nextStatus === 'bucket_list') {
      actionLabel = 'Converted from Been to Want';
    } else if (prevStatus === 'visited' && nextStatus === 'unvisited') {
      actionLabel = 'Removed from Been';
    } else if (prevStatus === 'bucket_list' && nextStatus === 'unvisited') {
      actionLabel = 'Removed from Want';
    }
    const entry = {
      id: p.id,
      name: p.name,
      category: p.category,
      flag_emoji: p.flag_emoji || '📍',
      prev_status: prevStatus,
      next_status: nextStatus,
      action_label: actionLabel,
      timestamp: new Date().toISOString(),
    };
    this.activityLog = [entry, ...(this.activityLog || [])].slice(0, 25);
    this.saveLocalActivityLog();
    if (this.activeSection === 'csv' || this.activeSection === 'gemini') {
      this.renderRecentUpdatesList();
    }
  }

  normalizeUserId(raw) {
    const cleaned = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/@[a-z0-9.-]+\.[a-z]{2,}$/i, '')
      .replace(/^([a-z0-9._-]+)_[a-z0-9-]+\.[a-z]{2,}$/i, '$1')
      .replace(/[^a-z0-9_.-]/g, '_')
      .slice(0, 64);
    if (!cleaned || cleaned === 'default') return '';
    return cleaned;
  }

  decodeJwtPayload(token) {
    try {
      const parts = String(token || '').split('.');
      if (parts.length < 2) return null;
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b64));
    } catch (_) {
      return null;
    }
  }

  isGoogleTokenValid(tokenOverride) {
    if (!tokenOverride && !this.googleIdToken && window.PlacesAndroidAuth && typeof window.PlacesAndroidAuth.getSavedAuth === 'function') {
      try {
        const savedRaw = window.PlacesAndroidAuth.getSavedAuth();
        if (savedRaw) {
          const saved = JSON.parse(savedRaw);
          if (saved && saved.idToken && saved.email) {
            this.googleIdToken = saved.idToken;
            this.userEmail = String(saved.email).trim().toLowerCase();
            this.userId = this.normalizeUserId(this.userEmail);
            localStorage.setItem('places_google_id_token', this.googleIdToken);
            localStorage.setItem('places_user_email', this.userEmail);
            localStorage.setItem('places_user_id', this.userId);
          }
        }
      } catch (_) { }
    }
    const tok = tokenOverride || this.googleIdToken;
    if (!tok) return false;
    const payload = this.decodeJwtPayload(tok);
    if (!payload || !payload.email) return false;
    const issuedAtSec = Number(payload.iat || payload.exp || 0);
    const tenYearsMs = 3650 * 24 * 60 * 60 * 1000;
    if (issuedAtSec > 0) {
      return issuedAtSec * 1000 + tenYearsMs > Date.now();
    }
    return true;
  }

  ensureUsernamePrompt(initialError = '') {
    if (this.isGoogleTokenValid() && !initialError) {
      const payload = this.decodeJwtPayload(this.googleIdToken);
      if (payload && payload.email) {
        this.userEmail = String(payload.email).trim().toLowerCase();
        this.userId = this.normalizeUserId(this.userEmail);
        localStorage.setItem('places_user_email', this.userEmail);
        localStorage.setItem('places_user_id', this.userId);
        this.updateUserUI();
      }
      return Promise.resolve(this.userId);
    }

    return new Promise((resolve) => {
      let modal = document.getElementById('username-setup-modal');
      if (modal) modal.remove();
      modal = document.createElement('div');
      modal.id = 'username-setup-modal';
      modal.className =
        'fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4';
      modal.innerHTML =
        '<div class="card rounded-2xl p-6 w-full max-w-sm border border-emerald-500/30 space-y-4 shadow-2xl text-center">' +
        '<div>' +
        '<div class="text-3xl mb-2">🌍</div>' +
        '<h2 class="text-base font-bold text-white">Sign in to PlacesTracker</h2>' +
        '<p class="text-xs text-slate-400 mt-1">Sign in with your allowlisted Google account to access your personal travel map:</p>' +
        '</div>' +
        '<div id="google-signin-btn-container" class="flex justify-center py-2 min-h-[48px] items-center">' +
        '<span class="text-xs text-slate-400">Loading Google Sign-In...</span>' +
        '</div>' +
        '<div id="initial-username-error" class="' +
        (initialError ? '' : 'hidden ') +
        'text-xs text-rose-400 font-medium bg-rose-500/10 border border-rose-500/30 rounded-xl p-2.5">' +
        (initialError || '') +
        '</div>' +
        '</div>';
      document.body.appendChild(modal);

      const err = document.getElementById('initial-username-error');
      const btnContainer = document.getElementById('google-signin-btn-container');

      const initGoogleButton = async () => {
        try {
          const cfgRes = await fetch('/api/auth-config', { cache: 'no-store' });
          const cfg = await cfgRes.json();
          const clientId = cfg.googleClientId || '';

          const completeLogin = (token, emailHint = '') => {
            const payload = this.decodeJwtPayload(token);
            const email = String((payload && payload.email) || emailHint || '')
              .trim()
              .toLowerCase();
            if (!token || !email) {
              if (err) {
                err.textContent = 'Google Sign-In did not return a valid email token.';
                err.classList.remove('hidden');
              }
              return;
            }
            this.googleIdToken = token;
            this.userEmail = email;
            this.userId = this.normalizeUserId(this.userEmail);
            localStorage.setItem('places_google_id_token', this.googleIdToken);
            localStorage.setItem('places_user_email', this.userEmail);
            localStorage.setItem('places_user_id', this.userId);
            this.activityLog = this.loadLocalActivityLog();
            this.updateUserUI();
            modal.remove();
            resolve(this.userId);
          };

          // 1. Native Android Google Sign-In Bridge (same flow as PackTrack)
          if (window.PlacesAndroidAuth && typeof window.PlacesAndroidAuth.signIn === 'function') {
            window.onAndroidGoogleSignInResult = (res) => {
              if (res && res.error) {
                if (err) {
                  err.textContent = res.error;
                  err.classList.remove('hidden');
                }
                return;
              }
              if (res && res.idToken) {
                completeLogin(res.idToken, res.email || '');
              }
            };
            if (btnContainer) {
              btnContainer.innerHTML =
                '<button type="button" id="native-google-signin-btn" class="px-6 py-2.5 rounded-full bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-slate-950 font-bold text-xs shadow-lg inline-flex items-center gap-2">' +
                '<span>🔐</span><span>Sign in with Google</span>' +
                '</button>';
              const nativeBtn = document.getElementById('native-google-signin-btn');
              if (nativeBtn) {
                nativeBtn.onclick = () => {
                  if (err) err.classList.add('hidden');
                  window.PlacesAndroidAuth.signIn(clientId);
                };
              }
            }
            return;
          }

          let tries = 0;
          while (!(window.google && window.google.accounts && window.google.accounts.id) && tries < 40) {
            await new Promise((r) => setTimeout(r, 150));
            tries++;
          }
          if (!(window.google && window.google.accounts && window.google.accounts.id)) {
            if (err) {
              err.textContent = 'Unable to load Google Sign-In SDK. Check your connection and reload.';
              err.classList.remove('hidden');
            }
            return;
          }
          window.google.accounts.id.initialize({
            client_id: clientId,
            callback: (resp) => {
              const token = resp && resp.credential ? resp.credential : '';
              completeLogin(token);
            },
          });

          const isAndroidWebView = /Android/i.test(navigator.userAgent || '');
          if (isAndroidWebView) {
            // Avoid rendering the web OAuth popup button on Android WebView (which opens a blocked popup and creates 2 buttons)
            if (btnContainer) {
              btnContainer.innerHTML =
                '<button type="button" id="android-onetap-signin-btn" class="px-6 py-2.5 rounded-full bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-slate-950 font-bold text-xs shadow-lg inline-flex items-center gap-2">' +
                '<span>🔐</span><span>Sign in with Google</span>' +
                '</button>';
              const oneTapBtn = document.getElementById('android-onetap-signin-btn');
              if (oneTapBtn) {
                oneTapBtn.onclick = () => {
                  if (err) err.classList.add('hidden');
                  try {
                    window.google.accounts.id.prompt();
                  } catch (_) { }
                };
              }
            }
            try {
              window.google.accounts.id.prompt();
            } catch (_) { }
          } else {
            if (btnContainer) {
              btnContainer.innerHTML = '';
              window.google.accounts.id.renderButton(btnContainer, {
                theme: 'filled_black',
                size: 'large',
                shape: 'pill',
                text: 'signin_with',
                width: 260,
              });
            }
          }
        } catch (e) {
          if (err) {
            err.textContent = 'Failed to initialize Google Sign-In.';
            err.classList.remove('hidden');
          }
        }
      };

      initGoogleButton();
    });
  }

  getBackupKey() {
    const safeId = (this.userId || 'unassigned').replace(/[^a-z0-9_.-]/g, '_');
    return 'places_backup_v1_' + safeId;
  }

  saveLocalBackup() {
    if (!this.userId) return;
    try {
      const activeOnly = this.places.filter(
        (p) => (p.status && p.status !== 'unvisited') || p.is_favorite
      );
      localStorage.setItem(this.getBackupKey(), JSON.stringify(activeOnly));
    } catch (_) { }
  }

  async init() {
    this.updateUserUI();
    this.syncColorIndicators();
    this.setupClipboardImagePaste();
    this.setupBackNavigation();
    this.openSection(this.activeSection || 'home', this.homeCategory || 'city', true);
    const initialHash = this.getCurrentAppHash();
    if (initialHash) {
      this.pushAppHistory(initialHash);
    }
    await this.ensureUsernamePrompt();
    await this.bootstrapState();
    this.handleUrlQueryActions();
    window.addEventListener('resize', () => {
      if (this.activeSection === 'home') this.drawWorldMap(false);
      else if (this.activeSection === 'visited_map') this.drawUSVectorMap(false);
      else if (this.activeSection === 'globe') this.drawGlobe(false);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.bootstrapState(true);
      }
    });
    window.addEventListener('online', () => {
      this.bootstrapState(true);
    });
  }

  async refreshApp() {
    const statusEl = document.getElementById('sync-status');
    if (statusEl) statusEl.textContent = 'Syncing...';
    sessionStorage.setItem('places_active_section', this.activeSection || 'home');
    sessionStorage.setItem('places_home_cat', this.homeCategory || 'city');
    await this.bootstrapState(true);
    window.location.reload();
  }

  getCurrentAppHash() {
    if (this.activeSection === 'visited_map') {
      if (this.regionalMode === 'state_focus' && this.focusedState && this.focusedState.place) {
        return 'visited_map/state/' + (this.focusedState.place.state_code || this.focusedState.place.id);
      }
      if (this.regionalMode === 'us_states') return 'visited_map/country/US';
      if (this.regionalMode === 'india_states') return 'visited_map/country/IN';
      if (this.regionalMode === 'country_focus' && this.focusedCountry && this.focusedCountry.place) {
        return 'visited_map/country/' + (this.focusedCountry.place.country_code || this.focusedCountry.place.id);
      }
      return 'visited_map';
    }
    if (this.activeSection && this.activeSection !== 'home') {
      return this.activeSection;
    }
    return '';
  }

  pushAppHistory(hashSuffix) {
    try {
      const targetUrl = hashSuffix ? '#' + hashSuffix : window.location.pathname + window.location.search;
      if (window.location.hash !== (hashSuffix ? '#' + hashSuffix : '')) {
        window.history.pushState({ appNav: true, hash: hashSuffix || '' }, '', targetUrl);
      }
    } catch (_) { }
  }

  handleBackAction(fromPopState = false) {
    const drawer = document.getElementById('nav-drawer');
    if (drawer && !drawer.classList.contains('hidden')) {
      drawer.classList.add('hidden');
      return true;
    }
    const csvModal = document.getElementById('csv-import-modal');
    if (csvModal) {
      csvModal.remove();
      return true;
    }
    if (
      this.activeSection === 'visited_map' &&
      (this.focusedState || this.focusedCountry || (this.regionalMode && this.regionalMode !== 'world'))
    ) {
      this.exitDrillDown(true);
      return true;
    }
    if (this.activeSection === 'statistics' && this.activeStatsCircle) {
      this.selectStatsCircle(this.activeStatsCircle);
      return true;
    }
    if (this.activeSection && this.activeSection !== 'home') {
      this.openSection('home', this.homeCategory || 'city', true);
      return true;
    }
    return false;
  }

  setupBackNavigation() {
    window.addEventListener('popstate', () => {
      const handled = this.handleBackAction(true);
      if (handled) {
        const nextHash = this.getCurrentAppHash();
        if (nextHash && window.location.hash !== '#' + nextHash) {
          this.pushAppHistory(nextHash);
        }
      }
    });
  }

  showMobileToast(msg) {
    const el = document.getElementById('mobile-toast');
    if (!el || !msg) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 1850);
  }

  getHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-User-Id': this.userId || 'default',
      ...extra,
    };
    if (this.googleIdToken) {
      headers['Authorization'] = 'Bearer ' + this.googleIdToken;
    }
    return headers;
  }

  updateUserUI() {
    const drawerLbl = document.getElementById('drawer-user-label');
    const csvEl = document.getElementById('csv-export-link');
    const settingsInp = document.getElementById('settings-user-input');
    const displayLabel = this.userEmail || (this.userId && this.userId !== 'default' ? this.userId : 'Not signed in');
    if (drawerLbl) {
      drawerLbl.textContent = displayLabel;
    }
    if (settingsInp) {
      settingsInp.value = displayLabel === 'Not signed in' ? '' : displayLabel;
    }
    if (csvEl) {
      csvEl.href = this.googleIdToken
        ? '/api/export.csv?id_token=' + encodeURIComponent(this.googleIdToken)
        : '/api/export.csv';
    }
  }

  toggleNavDrawer(show) {
    const drawer = document.getElementById('nav-drawer');
    if (!drawer) return;
    const isCurrentlyOpen = !drawer.classList.contains('hidden');
    const nextShow = show !== undefined ? Boolean(show) : !isCurrentlyOpen;
    drawer.classList.toggle('hidden', !nextShow);
    if (nextShow) {
      this.updateUserUI();
      this.pushAppHistory('drawer');
    }
  }

  toggleSettingsDrawer(show) {
    const shouldOpen = show !== undefined ? Boolean(show) : this.activeSection !== 'settings';
    if (shouldOpen) {
      if (this.activeSection && this.activeSection !== 'settings') {
        this.previousNonSettingsSection = this.activeSection;
      }
      this.openSection('settings');
    } else {
      const target =
        this.previousNonSettingsSection && this.previousNonSettingsSection !== 'settings'
          ? this.previousNonSettingsSection
          : 'home';
      this.openSection(target);
    }
  }

  openVisitedMapRoot() {
    this.focusedCountry = null;
    this.focusedState = null;
    this.regionalMode = 'world';
    this.regionalLayerFilter = 'none';
    this.openSection('visited_map');
  }

  openSection(section, homeCat, skipHistory = false) {
    this.toggleNavDrawer(false);
    let sec = section || 'home';
    if (sec === 'colored_maps' || sec === 'us_parks') {
      sec = 'visited_map';
    }
    if (sec !== 'settings') {
      this.previousNonSettingsSection = sec;
    } else if (!this.previousNonSettingsSection && this.activeSection && this.activeSection !== 'settings') {
      this.previousNonSettingsSection = this.activeSection;
    }
    this.activeSection = sec;
    sessionStorage.setItem('places_active_section', sec);

    const settingsBtn = document.getElementById('top-settings-btn');
    if (settingsBtn) {
      if (sec === 'settings') {
        settingsBtn.className =
          'w-9 h-9 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-400/50 flex items-center justify-center text-sm transition';
      } else {
        settingsBtn.className =
          'w-9 h-9 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-200 border border-white/10 flex items-center justify-center text-sm transition';
      }
    }

    if (homeCat) {
      this.homeCategory = homeCat;
      sessionStorage.setItem('places_home_cat', homeCat);
    }

    if (!skipHistory) {
      this.pushAppHistory(sec === 'home' ? '' : sec);
    }

    const viewMap = {
      home: 'view-home',
      visited_map: 'view-us',
      globe: 'view-globe',
      my_places: 'view-explore',
      statistics: 'view-statistics',
      settings: 'view-settings',
      csv: 'view-csv',
      gemini: 'view-gemini',
    };

    Object.entries(viewMap).forEach(([k, id]) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', k !== sec);
    });

    const titleEl = document.getElementById('app-header-title');
    if (titleEl) {
      if (sec === 'home') {
        const catTitles = {
          city: 'Cities',
          sights: 'UNESCO & Sights',
          airport: 'Airports',
        };
        titleEl.textContent = catTitles[this.homeCategory] || 'Cities';
      } else {
        const secTitles = {
          visited_map: 'Visited Map',
          globe: '3D Globe',
          my_places: 'My Places',
          statistics: 'Statistics',
          settings: 'Settings',
          csv: 'Import / Export CSV',
          gemini: 'Gemini AI Logger',
        };
        titleEl.textContent = secTitles[sec] || 'PlacesTracker';
      }
    }

    if (sec === 'home') {
      this.setHomeCategory(this.homeCategory || 'city', true);
      setTimeout(() => {
        if (this.homeMap) this.homeMap.invalidateSize();
      }, 60);
    } else if (sec === 'visited_map') {
      this.setRegionalMode(this.regionalMode || 'world', true);
    } else if (sec === 'globe') {
      this.drawGlobe(false);
    } else if (sec === 'my_places') {
      this.renderCatalogList();
    } else if (sec === 'statistics') {
      this.renderStatisticsPage();
    } else if (sec === 'settings') {
      this.updateUserUI();
      this.syncColorIndicators();
    } else if (sec === 'csv') {
      this.renderCsvPage();
    } else if (sec === 'gemini') {
      this.renderGeminiPage();
    }
  }

  signOutGoogle() {
    this.googleIdToken = '';
    this.userEmail = '';
    this.userId = '';
    localStorage.removeItem('places_google_id_token');
    localStorage.removeItem('places_user_email');
    localStorage.removeItem('places_user_id');
    try {
      if (window.PlacesAndroidAuth && typeof window.PlacesAndroidAuth.signOut === 'function') {
        window.PlacesAndroidAuth.signOut();
      }
      if (window.google && window.google.accounts && window.google.accounts.id) {
        window.google.accounts.id.disableAutoSelect();
      }
    } catch (_) { }
    window.location.reload();
  }

  saveProfileFromSettings() {
    this.signOutGoogle();
  }

  openUserModal() {
    this.signOutGoogle();
  }

  setupClipboardImagePaste() {
    const inp = document.getElementById('gemini-input');
    if (!inp) return;
    inp.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            this.compressAndAttachImage(file);
          }
        }
      }
    });
  }

  clearAttachment() {
    this.pendingImageBase64 = '';
    this.pendingImageMime = '';
    const pill = document.getElementById('gemini-attachment-pill');
    if (pill) pill.classList.add('hidden');
    const fileInp = document.getElementById('ticket-upload');
    if (fileInp) fileInp.value = '';
  }

  async handleTicketOrIcsUpload(evt) {
    const file = evt.target && evt.target.files && evt.target.files[0];
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.ics') || file.type === 'text/calendar') {
      const text = await file.text();
      const lines = text
        .split(/\r?\n/)
        .filter((l) => /^(SUMMARY|LOCATION|DESCRIPTION|DTSTART)/i.test(l))
        .slice(0, 80)
        .join('; ');
      const inp = document.getElementById('gemini-input');
      inp.value = 'Extract flights, airports, and visited places from calendar: ' + lines;
      this.askGemini();
      return;
    }
    if (file.type.startsWith('image/')) {
      await this.compressAndAttachImage(file);
      const inp = document.getElementById('gemini-input');
      if (!inp.value.trim()) {
        inp.value =
          'Scan this flight ticket / boarding pass screenshot and log the airports and destination cities';
      }
      this.askGemini();
    }
  }

  compressAndAttachImage(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 1280;
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          this.pendingImageBase64 = dataUrl.split(',')[1] || '';
          this.pendingImageMime = 'image/jpeg';
          const pill = document.getElementById('gemini-attachment-pill');
          const nameEl = document.getElementById('gemini-attachment-name');
          if (nameEl) nameEl.textContent = '🎫 ' + (file.name || 'Ticket Screenshot');
          if (pill) pill.classList.remove('hidden');
          resolve();
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async bootstrapState(isBackgroundSync = false) {
    const cacheKey = this.getBackupKey();
    let localById = {};
    let localFavById = {};
    try {
      const candidateKeys = [cacheKey];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(cacheKey + '_')) {
          candidateKeys.push(k);
        }
      }
      for (const k of candidateKeys) {
        const rawLocal = localStorage.getItem(k);
        if (rawLocal) {
          const parsedLocal = JSON.parse(rawLocal);
          if (Array.isArray(parsedLocal)) {
            for (const lp of parsedLocal) {
              if (lp && lp.id) {
                if (lp.status && lp.status !== 'unvisited') {
                  localById[lp.id] = lp.status;
                }
                if (lp.is_favorite) {
                  localFavById[lp.id] = true;
                }
              }
            }
          }
        }
      }
    } catch (_) { }

    try {
      const res = await fetch('/api/state', { headers: this.getHeaders(), cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        const errBody = await res.json().catch(() => ({}));
        this.googleIdToken = '';
        this.userEmail = '';
        this.userId = '';
        localStorage.removeItem('places_google_id_token');
        localStorage.removeItem('places_user_email');
        localStorage.removeItem('places_user_id');
        try {
          if (window.google && window.google.accounts && window.google.accounts.id) {
            window.google.accounts.id.disableAutoSelect();
          }
        } catch (_) { }
        await this.ensureUsernamePrompt(
          errBody.error || 'Please sign in with an allowlisted Google account.'
        );
        return this.bootstrapState(isBackgroundSync);
      }
      const data = await res.json();
      if (data.session_token && data.session_token !== this.googleIdToken) {
        this.googleIdToken = data.session_token;
        localStorage.setItem('places_google_id_token', this.googleIdToken);
        try {
          if (window.PlacesAndroidAuth && typeof window.PlacesAndroidAuth.saveSessionToken === 'function') {
            window.PlacesAndroidAuth.saveSessionToken(this.googleIdToken, this.userEmail || '');
          }
        } catch (_) { }
        this.updateUserUI();
      }
      const serverPlaces = data.places || [];
      const toPushVisited = [];
      const toPushDream = [];

      for (const sp of serverPlaces) {
        if (localFavById[sp.id] && !sp.is_favorite) {
          sp.is_favorite = true;
        }
        if (this.isParentCategory(sp.category)) continue;
        const localStatus = localById[sp.id];
        if (localStatus && sp.status === 'unvisited') {
          sp.status = localStatus;
          if (localStatus === 'visited') toPushVisited.push(sp.id);
          else if (localStatus === 'bucket_list') toPushDream.push(sp.id);
        }
      }

      this.places = serverPlaces;
      this.usGrid = data.us_grid;
      if (Array.isArray(data.activity_log) && data.activity_log.length > 0) {
        this.activityLog = data.activity_log.slice(0, 25);
        this.saveLocalActivityLog();
      } else {
        this.activityLog = this.loadLocalActivityLog();
      }
      if (data.client_geo && typeof data.client_geo.lat === 'number' && !this.hasBrowserGeo) {
        this.clientGeo = data.client_geo;
      }
      if (this.extendedCitiesCache && this.extendedCitiesCache.length) {
        this.mergeExtendedCitiesIntoPlaces(this.extendedCitiesCache, localById, localFavById);
      }
      this.recomputeParentRegionsLocal();
      this.saveLocalBackup();

      if (toPushVisited.length > 0) {
        fetch('/api/mark', {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({ places: toPushVisited, status: 'visited' }),
        }).catch(() => { });
      }
      if (toPushDream.length > 0) {
        fetch('/api/mark', {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({ places: toPushDream, status: 'bucket_list' }),
        }).catch(() => { });
      }

      const statusEl = document.getElementById('sync-status');
      if (statusEl) {
        statusEl.textContent =
          this.userId !== 'default' ? 'Synced · ' + this.userId : 'Synced ✓';
      }
    } catch (e) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) this.places = JSON.parse(cached);
      const statusEl = document.getElementById('sync-status');
      if (statusEl) statusEl.textContent = 'Offline Mode (Auto-syncs when online)';
    }
    if (!isBackgroundSync) {
      this.setFilterCat(this.filterCat || 'country');
    }
    this.populateExploreCountryFilter();
    this.recomputeAndRender();
    if (this.activeSection === 'csv') {
      this.renderCsvPage();
    } else if (this.activeSection === 'gemini') {
      this.renderGeminiPage();
    }
    if (!this.worldTopo) {
      this.loadVectorMaps();
    } else if (!this.hasInitialCityFocus) {
      this.focusCurrentCity(true);
    }
  }

  handleUrlQueryActions() {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    if (tabParam === 'us') {
      this.openSection('us_parks');
    } else if (tabParam === 'explore') {
      this.openSection('my_places');
    } else if (tabParam === 'stats' || tabParam === 'statistics') {
      this.openSection('statistics');
    } else if (tabParam === 'gemini') {
      this.openSection('gemini');
    }
    const shared = params.get('text') || params.get('title') || params.get('q');
    if (shared) {
      const inp = document.getElementById('top-search-input');
      if (inp) {
        inp.value = shared;
        this.onTopSearchInput(shared);
      }
      window.history.replaceState({}, '', '/');
    }
  }

  async loadVectorMaps() {
    try {
      const [wRes, uRes, iRes] = await Promise.all([
        fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json').catch(() =>
          fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
        ),
        fetch('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json'),
        fetch('https://cdn.jsdelivr.net/gh/udit-001/india-maps-data@main/geojson/india.geojson').catch(() => null),
      ]);
      if (wRes && wRes.ok) this.worldTopo = await wRes.json();
      if (uRes && uRes.ok) this.usTopo = await uRes.json();
      if (iRes && iRes.ok) this.indiaGeo = await iRes.json();
    } catch (_) { }
    const loadingEl = document.getElementById('map-loading');
    if (loadingEl) loadingEl.classList.add('hidden');
    this.drawWorldMap(true);
    this.focusCurrentCity(true);
    this.drawUSVectorMap(true);
    if (this.activeSection === 'globe') this.drawGlobe(false);
    this.loadExtendedWorldCities();
    this.requestBrowserGeolocation();
  }

  requestBrowserGeolocation() {
    if (this.geoRequested || typeof navigator === 'undefined' || !navigator.geolocation) return;
    this.geoRequested = true;
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!pos || !pos.coords) return;
          this.hasBrowserGeo = true;
          this.clientGeo = {
            ...(this.clientGeo || {}),
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          };
          if (!this.userHasManuallyZoomed) {
            this.focusCurrentCity(false);
          } else {
            this.renderViewportPlacesList();
          }
        },
        () => {},
        { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 }
      );
    } catch (_) {}
  }

  focusCurrentCity(isInitial = false) {
    if (isInitial && this.hasInitialCityFocus) return;
    this.initHomeGoogleMap();
    if (!this.homeMap) return;
    const geo = this.clientGeo;
    if (!geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number') return;
    this.hasInitialCityFocus = true;
    this.homeMap.setView([geo.lat, geo.lng], 9, { animate: !isInitial });
    this.scheduleViewportListUpdate();
  }

  async loadExtendedWorldCities() {
    if (this.extendedCitiesLoaded) return;
    this.extendedCitiesLoaded = true;
    try {
      const res = await fetch(
        'https://cdn.jsdelivr.net/gh/madhavsankar/PlacesTracker@main/data/catalog/worldcities_compact.json'
      );
      if (!res.ok) return;
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) return;
      this.extendedCitiesCache = rows;
      this.mergeExtendedCitiesIntoPlaces(rows, {}, {});
      this.recomputeParentRegionsLocal();
      this.renderHomeTopBar();
      this.renderViewportPlacesList();
      if (this.activeSection === 'my_places') {
        this.renderCatalogList();
      } else if (this.activeSection === 'statistics') {
        this.renderStatisticsPage();
      }
    } catch (_) { }
  }

  mergeExtendedCitiesIntoPlaces(rows, localById = {}, localFavById = {}) {
    if (!Array.isArray(rows) || !rows.length) return;
    const existingById = new Map(this.places.map((p) => [p.id, p]));
    const countryByCode = {};
    this.places
      .filter((p) => p.category === 'country')
      .forEach((c) => {
        countryByCode[c.country_code] = c;
      });

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length < 6) continue;
      const pid = 'city:sm_' + r[0];
      const pop = r[6] || 0;
      const existing = existingById.get(pid);
      if (existing) {
        if (!existing.population && pop > 0) existing.population = pop;
        continue;
      }
      const name = r[1];
      const cc = r[2];
      const reg = r[3] || '';
      const lat = r[4];
      const lng = r[5];
      const co = countryByCode[cc];
      const isStateCode =
        (cc === 'US' && reg.length === 2 && reg === reg.toUpperCase()) ||
        reg.startsWith('IN-') ||
        reg.startsWith('CA-');
      const stateCode = isStateCode ? reg : '';
      const coName = co ? co.name : cc;
      const status = localById[pid] || 'unvisited';
      const isFav = !!localFavById[pid];

      this.places.push({
        id: pid,
        name,
        category: 'city',
        country_code: cc,
        state_code: stateCode,
        continent: co ? co.continent : 'Asia',
        subregion: reg || coName,
        lat,
        lng,
        population: pop,
        flag_emoji: co ? co.flag_emoji : '📍',
        description: (reg ? reg + ', ' : '') + coName,
        status,
        is_favorite: isFav,
        is_extended: true,
      });
    }
  }

  isOfficialUSNationalPark(p) {
    return (
      p &&
      p.category === 'national_park' &&
      p.country_code === 'US' &&
      /\bNational (and State )?Parks?\b/i.test(p.name)
    );
  }

  isSightPlace(p) {
    return (
      p &&
      (p.category === 'national_park' ||
        p.category === 'unesco' ||
        p.category === 'world_wonder')
    );
  }

  countByCat(cat, status) {
    return this.places.filter(
      (p) =>
        (cat === 'us_np' ? this.isOfficialUSNationalPark(p) : p.category === cat) &&
        (!status || p.status === status)
    ).length;
  }

  recomputeAndRender() {
    this.renderHomeTopBar();
    this.renderViewportPlacesList();
    this.renderUSParksList();
    this.renderCatalogList();
    this.drawWorldMap(false);
    this.drawUSVectorMap(false);
    if (this.activeSection === 'globe') {
      this.drawGlobe(false);
    }
    if (this.activeSection === 'statistics') {
      this.renderStatisticsPage();
    }
  }

  setVisitedColor(hex) {
    if (!hex) return;
    if (hex.toLowerCase() === (this.dreamColor || '').toLowerCase()) {
      alert('Visited and Dream List colors should be different so you can tell them apart on the map.');
      this.syncColorIndicators();
      return;
    }
    this.visitedColor = hex;
    localStorage.setItem('places_visited_color', hex);
    this.syncColorIndicators();
    this.drawWorldMap(false);
    this.drawUSVectorMap(false);
    this.drawGlobe(false);
  }

  setDreamColor(hex) {
    if (!hex) return;
    if (hex.toLowerCase() === (this.visitedColor || '').toLowerCase()) {
      alert('Dream List and Visited colors should be different so you can tell them apart on the map.');
      this.syncColorIndicators();
      return;
    }
    this.dreamColor = hex;
    localStorage.setItem('places_dream_color', hex);
    this.syncColorIndicators();
    this.drawWorldMap(false);
    this.drawUSVectorMap(false);
    this.drawGlobe(false);
  }

  syncColorIndicators() {
    const vp = document.getElementById('visited-color-picker');
    if (vp) vp.value = this.visitedColor;
    const dp = document.getElementById('dream-color-picker');
    if (dp) dp.value = this.dreamColor;
    ['legend-dot-visited-1', 'legend-dot-visited-2', 'settings-dot-visited'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.background = this.visitedColor;
    });
    ['legend-dot-dream-1', 'legend-dot-dream-2', 'settings-dot-dream'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.background = this.dreamColor;
    });
  }

  resolveCountryFeature(feat) {
    const rawName = ((feat && feat.properties && feat.properties.name) || '').trim();
    if (!rawName) return null;
    const nl = rawName.toLowerCase();
    const mappedId = this.naturalEarthNameMap[nl];
    if (mappedId) {
      const found = this.places.find((p) => p.id === mappedId);
      if (found) return found;
    }
    return (
      this.places.find(
        (p) => (p.category === 'country' || p.category === 'territory') && p.name.toLowerCase() === nl
      ) || null
    );
  }

  setHomeCategory(cat, fromOpenSection = false) {
    const validCats = ['city', 'sights', 'airport'];
    const c = validCats.includes(cat) ? cat : 'city';
    this.homeCategory = c;
    sessionStorage.setItem('places_home_cat', c);

    validCats.forEach((k) => {
      const btn = document.getElementById('home-cat-' + k);
      if (!btn) return;
      if (k === c) {
        btn.className =
          'py-2 px-1 sm:px-2 flex items-center justify-center gap-1.5 bg-emerald-500/15 border-b-2 border-emerald-400 transition min-w-0';
      } else {
        btn.className =
          'py-2 px-1 sm:px-2 flex items-center justify-center gap-1.5 hover:bg-white/5 transition min-w-0';
      }
    });

    if (this.activeSection === 'home') {
      const titleEl = document.getElementById('app-header-title');
      if (titleEl) {
        const catTitles = {
          city: 'Cities',
          sights: 'UNESCO & Sights',
          airport: 'Airports',
        };
        titleEl.textContent = catTitles[c] || 'Cities';
      }
    }

    this.renderHomeTopBar();
    this.drawWorldMap(false);
    this.renderViewportPlacesList();
  }

  onHomeSubfilterChange() {
    this.drawWorldMap(false);
    this.renderViewportPlacesList();
  }

  renderHomeTopBar() {
    const cityEl = document.getElementById('bar-count-city');
    const sightsEl = document.getElementById('bar-count-sights');
    const airportEl = document.getElementById('bar-count-airport');

    if (cityEl) {
      const cities = this.places.filter((p) => p.category === 'city');
      const been = cities.filter((p) => p.status === 'visited').length;
      const want = cities.filter((p) => p.status === 'bucket_list').length;
      cityEl.innerHTML =
        '<span class="text-sky-400">' +
        been +
        '</span>' +
        (want > 0 ? ' <span class="text-amber-400">' + want + '</span>' : '');
    }
    if (sightsEl) {
      const sights = this.places.filter((p) => this.isSightPlace(p));
      const been = sights.filter((p) => p.status === 'visited').length;
      const want = sights.filter((p) => p.status === 'bucket_list').length;
      sightsEl.innerHTML =
        '<span class="text-emerald-400">' +
        been +
        '</span>' +
        (want > 0 ? ' <span class="text-amber-400">' + want + '</span>' : '');
    }
    if (airportEl) {
      const visA = this.countByCat('airport', 'visited');
      airportEl.textContent = String(visA);
    }
  }

  scheduleViewportListUpdate() {
    if (this.viewportRaf) return;
    this.viewportRaf = requestAnimationFrame(() => {
      this.viewportRaf = null;
      this.renderViewportPlacesList();
    });
  }

  isPlaceInCurrentViewport(p) {
    if (p.lng === undefined || p.lat === undefined) return false;
    if (!this.homeMap) return true;
    const b = this.homeMap.getBounds();
    if (!b) return true;
    return (
      p.lat >= b.getSouth() &&
      p.lat <= b.getNorth() &&
      p.lng >= b.getWest() &&
      p.lng <= b.getEast()
    );
  }

  focusPlaceOnHomeMap(placeId, evt) {
    if (evt) evt.stopPropagation();
    const p = this.places.find((x) => x.id === placeId);
    if (!p || p.lat === undefined || p.lng === undefined) return;
    this.initHomeGoogleMap();
    if (!this.homeMap) return;
    const curZ = this.homeMap.getZoom() || 9;
    const targetZ = p.category === 'country' ? 5 : curZ < 10 ? 10 : 12;
    this.homeMap.flyTo([p.lat, p.lng], targetZ, { duration: 0.4 });
  }

  updateViewportDetailPins(viewportItems) {
    if (!this.homeMap || !this.homePinsLayer || typeof L === 'undefined') return;
    this.homePinsLayer.clearLayers();
    const cat = this.homeCategory || 'city';
    if (cat === 'country') return;

    const slice = (viewportItems || []).slice(0, 500);
    const statusOrder = { unvisited: 0, bucket_list: 1, visited: 2 };
    const pinsData = slice
      .slice()
      .sort((a, b) => (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0));

    for (let i = 0; i < pinsData.length; i++) {
      const d = pinsData[i];
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number') continue;
      const isVis = d.status === 'visited';
      const isWant = d.status === 'bucket_list';
      L.circleMarker([d.lat, d.lng], {
        renderer: this.homeCanvasRenderer,
        interactive: false,
        radius: isVis ? 5.0 : isWant ? 4.5 : 3.5,
        color: '#0f172a',
        weight: 1.2,
        fillColor: isVis ? '#0284c7' : isWant ? '#f59e0b' : '#ffffff',
        fillOpacity: 0.9,
      }).addTo(this.homePinsLayer);
    }
  }

  renderViewportPlacesList() {
    const listEl = document.getElementById('viewport-places-list');
    const countLbl = document.getElementById('viewport-count-label');
    if (!listEl) return;

    const searchInp = document.getElementById('top-search-input');
    const rawSearch = ((searchInp && searchInp.value) || '').trim();
    const q = rawSearch.toLowerCase();
    const cat = this.homeCategory || 'city';
    const statusFilter =
      (document.getElementById('home-status-filter') &&
        document.getElementById('home-status-filter').value) ||
      'visited';

    const matchesCat = (p) => {
      if (cat === 'country') return p.category === 'country';
      if (cat === 'city') return p.category === 'city';
      if (cat === 'airport') return p.category === 'airport';
      if (cat === 'sights') return this.isSightPlace(p);
      return false;
    };

    const matchesStatus = (p) => {
      if (statusFilter === 'visited') return p.status === 'visited';
      return p.status !== 'visited';
    };

    const matchesQuery = (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q) ||
      (p.subregion || '').toLowerCase().includes(q) ||
      (p.state_code || '').toLowerCase() === q ||
      (p.country_code || '').toLowerCase() === q;

    // When a search query is typed, search across all places globally;
    // otherwise filter to places matching the status filter within the zoomed map viewport!
    const items = this.places.filter((p) => {
      if (q.length >= 2) {
        if (this.isParentCategory(p.category) && cat !== 'country') return false;
        return matchesQuery(p);
      }
      if (!matchesCat(p)) return false;
      if (!matchesStatus(p)) return false;
      return this.isPlaceInCurrentViewport(p);
    });

    // Determine the geographic center of the current map view (or current city geo) so the current city starts first!
    let centerLng = this.clientGeo && typeof this.clientGeo.lng === 'number' ? this.clientGeo.lng : null;
    let centerLat = this.clientGeo && typeof this.clientGeo.lat === 'number' ? this.clientGeo.lat : null;
    if (this.homeMap && this.homeMap.getCenter) {
      const c = this.homeMap.getCenter();
      if (c && typeof c.lat === 'number' && typeof c.lng === 'number') {
        centerLat = c.lat;
        centerLng = c.lng;
      }
    }
    const clientCityLower = ((this.clientGeo && this.clientGeo.city) || '').trim().toLowerCase();

    items.sort((a, b) => {
      if (q.length >= 2) {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name);
      }
      if (clientCityLower) {
        const aIsCur = a.name.toLowerCase() === clientCityLower ? 0 : 1;
        const bIsCur = b.name.toLowerCase() === clientCityLower ? 0 : 1;
        if (aIsCur !== bIsCur) return aIsCur - bIsCur;
      }
      if (centerLat !== null && centerLng !== null) {
        const da = Math.pow((a.lat || 0) - centerLat, 2) + Math.pow((a.lng || 0) - centerLng, 2);
        const db = Math.pow((b.lat || 0) - centerLat, 2) + Math.pow((b.lng || 0) - centerLng, 2);
        if (Math.abs(da - db) > 0.0001) return da - db;
      }
      return a.name.localeCompare(b.name);
    });

    if (countLbl) {
      countLbl.textContent = '(' + items.length + ' in view)';
    }

    this.updateViewportDetailPins(items);

    const visibleSlice = items.slice(0, 160);
    let html = '';

    if (rawSearch.length >= 2) {
      const safeQ = rawSearch.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const dispQ = rawSearch.replace(/</g, '&lt;');
      html +=
        '<div class="px-3 py-2.5 bg-emerald-950/30 flex flex-col sm:flex-row sm:items-center justify-between gap-2">' +
        '<div class="min-w-0">' +
        '<div class="text-xs font-semibold text-emerald-300 truncate">➕ Add & geocode "' +
        dispQ +
        '"</div>' +
        '<div class="text-[10px] text-slate-400 truncate">Any city or town worldwide · auto-updates country & state</div>' +
        '</div>' +
        '<div class="flex items-center gap-1.5 shrink-0">' +
        '<button type="button" onclick="app.quickAddAndMarkCity(\'' +
        safeQ +
        '\', \'visited\')" class="flex-1 sm:flex-none px-2.5 py-1 rounded-lg bg-emerald-500 text-slate-950 text-[11px] font-bold">+ Been</button>' +
        '<button type="button" onclick="app.quickAddAndMarkCity(\'' +
        safeQ +
        '\', \'bucket_list\')" class="flex-1 sm:flex-none px-2.5 py-1 rounded-lg bg-amber-500 text-slate-950 text-[11px] font-bold">+ Want</button>' +
        '</div>' +
        '</div>';
    }

    if (visibleSlice.length === 0) {
      html +=
        '<div class="p-6 text-center space-y-1">' +
        '<div class="text-xs font-semibold text-slate-300">No places in this zoomed map area</div>' +
        '<div class="text-[11px] text-slate-500">Pan or zoom out on the map above, or use the top search bar to find any city or sight.</div>' +
        '</div>';
    } else {
      html += visibleSlice
        .map((p) => {
          const isBeen = p.status === 'visited';
          const isWant = p.status === 'bucket_list';
          const isParent = this.isParentCategory(p.category);

          const beenBoxCls = isBeen
            ? 'bg-sky-500 border-sky-400 text-slate-950 font-bold'
            : 'border-sky-500/70 text-transparent hover:border-sky-400';
          const wantBoxCls = isWant
            ? 'bg-amber-500 border-amber-400 text-slate-950 font-bold'
            : 'border-amber-500/70 text-transparent hover:border-amber-400';

          const subParts = [];
          if (p.state_code) subParts.push(p.state_code);
          if (p.description) subParts.push(p.description);
          else if (p.continent) subParts.push(p.continent);
          const subText = subParts.join(' · ');

          const rightControls = isParent
            ? '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-lg ' +
              (isBeen
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">✓ Visited'
                : isWant
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40">🎯 Want to Go'
                  : 'bg-slate-800/80 text-slate-400 border border-slate-700/80">Auto') +
              '</span>'
            : '<div class="w-9 flex justify-center">' +
              '<button type="button" onclick="app.togglePlaceBeen(\'' +
              p.id +
              '\', event)" class="w-5 h-5 rounded-[4px] border-2 flex items-center justify-center text-xs transition ' +
              beenBoxCls +
              '">✓</button>' +
              '</div>' +
              '<div class="w-9 flex justify-center">' +
              '<button type="button" onclick="app.togglePlaceWant(\'' +
              p.id +
              '\', event)" class="w-5 h-5 rounded-[4px] border-2 flex items-center justify-center text-xs transition ' +
              wantBoxCls +
              '">✓</button>' +
              '</div>';

          return (
            '<div class="px-2.5 py-2 flex items-center justify-between gap-2 hover:bg-white/[0.03] transition">' +
            '<div onclick="app.focusPlaceOnHomeMap(\'' +
            p.id +
            '\', event)" class="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">' +
            '<span class="w-5 h-5 rounded-full bg-sky-500/20 border border-sky-400/40 text-sky-300 text-[11px] font-serif italic font-bold flex items-center justify-center shrink-0">i</span>' +
            '<span class="text-base leading-none shrink-0">' +
            (p.flag_emoji || '📍') +
            '</span>' +
            '<div class="min-w-0 flex-1">' +
            '<div class="text-xs font-semibold text-slate-100 truncate">' +
            p.name +
            '</div>' +
            (subText
              ? '<div class="text-[10px] text-slate-400 truncate">' + subText + '</div>'
              : '') +
            '</div>' +
            '</div>' +
            '<div class="flex items-center gap-2 shrink-0 pr-0.5">' +
            rightControls +
            '</div>' +
            '</div>'
          );
        })
        .join('');
    }

    listEl.innerHTML = html;
  }

  async togglePlaceBeen(placeId, evt) {
    if (evt) evt.stopPropagation();
    const p = this.places.find((x) => x.id === placeId);
    if (!p) return;
    if (this.isParentCategory(p.category)) {
      this.showMobileToast(
        (p.flag_emoji || '🌍') +
        ' ' +
        p.name +
        ' updates automatically when you mark cities or sights inside it'
      );
      return;
    }
    const next = p.status === 'visited' ? 'unvisited' : 'visited';
    await this.setPlaceStatusDirect(placeId, next, evt);
  }

  async togglePlaceWant(placeId, evt) {
    if (evt) evt.stopPropagation();
    const p = this.places.find((x) => x.id === placeId);
    if (!p) return;
    if (this.isParentCategory(p.category)) {
      this.showMobileToast(
        (p.flag_emoji || '🌍') +
        ' ' +
        p.name +
        ' updates automatically when you mark cities or sights inside it'
      );
      return;
    }
    const next = p.status === 'bucket_list' ? 'unvisited' : 'bucket_list';
    await this.setPlaceStatusDirect(placeId, next, evt);
  }

  async togglePlaceFav(placeId, evt) {
    if (evt) evt.stopPropagation();
    const p = this.places.find((x) => x.id === placeId);
    if (!p) return;
    p.is_favorite = !p.is_favorite;
    this.showMobileToast(
      (p.flag_emoji || '📍') +
      ' ' +
      p.name +
      (p.is_favorite ? ' · ♥ Added to Favorites' : ' · Removed from Favorites')
    );
    this.renderHomeTopBar();
    this.renderViewportPlacesList();
    this.saveLocalBackup();
    try {
      await fetch('/api/mark', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          places: [placeId],
          status: p.status || 'unvisited',
          is_favorite: p.is_favorite,
          place_meta: p.is_extended ? p : undefined,
        }),
      });
    } catch (_) { }
  }

  bindLongPress(selection, onLongPress) {
    let startX = 0;
    let startY = 0;
    const clearTimer = () => {
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }
    };
    const triggerOnce = (evt, d) => {
      const now = Date.now();
      if (this.lastLongPressAt && now - this.lastLongPressAt < 650) {
        return;
      }
      this.lastLongPressAt = now;
      this.suppressClickUntil = now + 550;
      try {
        if (navigator.vibrate) navigator.vibrate(35);
      } catch (_) { }
      onLongPress(evt, d);
    };
    selection
      .on('pointerdown', (evt, d) => {
        if (evt.button && evt.button !== 0) return;
        startX = evt.clientX || 0;
        startY = evt.clientY || 0;
        clearTimer();
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          triggerOnce(evt, d);
        }, 430);
      })
      .on('pointermove', (evt) => {
        if (!this.longPressTimer) return;
        const dx = Math.abs((evt.clientX || 0) - startX);
        const dy = Math.abs((evt.clientY || 0) - startY);
        if (dx > 10 || dy > 10) clearTimer();
      })
      .on('pointerup', clearTimer)
      .on('pointercancel', clearTimer)
      .on('contextmenu', (evt, d) => {
        evt.preventDefault();
        evt.stopPropagation();
        clearTimer();
        triggerOnce(evt, d);
      });
  }

  getInheritedLayerFilter(defaultForDrilldown = 'national_park') {
    if (this.regionalMode === 'us_parks') return 'national_park';
    if (this.regionalLayerFilter && this.regionalLayerFilter !== 'none') {
      return this.regionalLayerFilter;
    }
    if (this.homeCategory === 'city') return 'city';
    if (this.homeCategory === 'airport') return 'airport';
    if (this.homeCategory === 'sights') {
      const sub =
        document.getElementById('home-sights-subfilter') &&
        document.getElementById('home-sights-subfilter').value;
      return sub && sub !== 'all' ? sub : 'national_park';
    }
    return defaultForDrilldown;
  }

  setRegionalLayerFilter(val) {
    this.regionalLayerFilter = val || 'none';
    const regSel = document.getElementById('regional-layer-filter');
    if (regSel && regSel.value !== this.regionalLayerFilter) {
      regSel.value = this.regionalLayerFilter;
    }
    this.updateRegionalSectionVisibilityAndLabels();
    this.drawUSVectorMap(false);
    this.renderUSParksList();
  }

  setRegionalStatusFilter(val) {
    this.regionalStatusFilter = val || 'visited';
    const stSel = document.getElementById('regional-status-filter');
    if (stSel && stSel.value !== this.regionalStatusFilter) {
      stSel.value = this.regionalStatusFilter;
    }
    this.updateRegionalSectionVisibilityAndLabels();
    this.drawUSVectorMap(false);
    this.renderUSParksList();
  }

  filterRegionalPlaces(placesList) {
    const f = this.regionalLayerFilter || 'none';
    if (f === 'none') return [];
    const stFilter = this.regionalStatusFilter || 'visited';
    return placesList.filter((p) => {
      if (this.isParentCategory(p.category)) {
        return false;
      }
      if (stFilter === 'visited' && p.status !== 'visited') return false;
      return p.category === f;
    });
  }

  getRegionalLayerLabel() {
    const labels = {
      national_park: '🌲 National Parks',
      unesco: '🏛️ UNESCO Sites',
      world_wonder: '✨ World Wonders',
      city: '🏙️ Cities',
      airport: '✈️ Airports',
    };
    const base = labels[this.regionalLayerFilter] || '📍 Places';
    return this.regionalStatusFilter === 'visited' ? 'Visited ' + base : base;
  }

  updateRegionalSectionVisibilityAndLabels() {
    const isWorld = !this.regionalMode || this.regionalMode === 'world';
    const hasLayerPins = !isWorld && this.regionalLayerFilter && this.regionalLayerFilter !== 'none';
    const showList =
      (this.regionalMode === 'state_focus' ||
        this.regionalMode === 'country_focus' ||
        this.regionalMode === 'us_states' ||
        this.regionalMode === 'india_states') &&
      hasLayerPins;

    const worldHeading = document.getElementById('visited-map-world-heading');
    if (worldHeading) {
      worldHeading.classList.toggle('hidden', !isWorld);
    }

    const parksSec = document.getElementById('us-parks-list-section');
    if (parksSec) {
      parksSec.classList.toggle('hidden', !showList);
    }

    const regSel = document.getElementById('regional-layer-filter');
    if (regSel) {
      regSel.classList.toggle('hidden', isWorld);
    }

    const stSel = document.getElementById('regional-status-filter');
    if (stSel) {
      stSel.classList.toggle('hidden', !showList);
    }

    const listTitle = document.getElementById('regional-list-title');
    if (listTitle) {
      const catLabel = this.getRegionalLayerLabel();
      if (this.regionalMode === 'state_focus' && this.focusedState) {
        const st = this.focusedState.place;
        listTitle.textContent = catLabel + ' in ' + st.name + ' (' + st.state_code + ')';
      } else if (this.regionalMode === 'country_focus' && this.focusedCountry) {
        const co = this.focusedCountry.place;
        listTitle.textContent = catLabel + ' in ' + co.name;
      } else if (this.regionalMode === 'india_states') {
        listTitle.textContent = catLabel + ' in India';
      } else if (this.regionalMode === 'us_states') {
        listTitle.textContent = catLabel + ' in the United States';
      }
    }
    return showList;
  }

  async drillDownCountry(countryObj, feat) {
    if (!countryObj) return;
    this.hideTooltip('us-tooltip');
    this.hideTooltip('map-tooltip');
    this.focusedState = null;
    this.pushAppHistory('visited_map/country/' + (countryObj.country_code || countryObj.id));
    this.showMobileToast((countryObj.flag_emoji || '🌍') + ' ' + countryObj.name);
    if (countryObj.country_code === 'US') {
      this.focusedCountry = null;
      this.regionalLayerFilter = 'none';
      this.regionalMode = 'us_states';
      this.openSection('visited_map', null, true);
      return;
    }
    if (countryObj.country_code === 'IN') {
      this.focusedCountry = null;
      this.regionalLayerFilter = 'none';
      this.regionalMode = 'india_states';
      this.openSection('visited_map', null, true);
      return;
    }
    if (countryObj.country_code === 'CA' && !this.canadaGeo) {
      try {
        const res = await fetch(
          'https://cdn.jsdelivr.net/gh/codeforamerica/click_that_hood@master/public/data/canada.geojson'
        );
        if (res.ok) this.canadaGeo = await res.json();
      } catch (_) { }
    }
    if (countryObj.country_code === 'CA') {
      this.regionalLayerFilter = 'none';
    } else {
      const hasNP = this.places.some(
        (p) => p.country_code === countryObj.country_code && p.category === 'national_park'
      );
      this.regionalLayerFilter = hasNP ? 'national_park' : 'city';
    }
    this.focusedCountry = { place: countryObj, feature: feat };
    this.regionalMode = 'country_focus';
    this.openSection('visited_map', null, true);
  }

  drillDownState(stateObj, feat) {
    if (!stateObj || !feat) return;
    this.hideTooltip('us-tooltip');
    this.pushAppHistory('visited_map/state/' + (stateObj.state_code || stateObj.id));
    this.showMobileToast((stateObj.flag_emoji || '📍') + ' ' + stateObj.name);
    if (!this.regionalLayerFilter || this.regionalLayerFilter === 'none') {
      const hasNP = this.places.some(
        (p) => p.state_code === stateObj.state_code && p.category === 'national_park'
      );
      this.regionalLayerFilter = hasNP ? 'national_park' : 'city';
    }
    this.focusedState = {
      place: stateObj,
      feature: feat,
      parentMode: this.regionalMode || 'us_states',
      parentCountry: this.focusedCountry,
    };
    this.regionalMode = 'state_focus';
    this.openSection('visited_map', null, true);
  }

  exitDrillDown(fromPopState = false) {
    if (this.focusedState) {
      const prevMode = this.focusedState.parentMode || 'us_states';
      this.focusedCountry = this.focusedState.parentCountry || null;
      this.focusedState = null;
      this.regionalLayerFilter = 'none';
      this.setRegionalMode(prevMode, true);
      if (!fromPopState) {
        this.pushAppHistory(this.getCurrentAppHash());
      }
      return;
    }
    this.focusedCountry = null;
    this.focusedState = null;
    this.regionalLayerFilter = 'none';
    this.setRegionalMode('world', true);
    if (!fromPopState) {
      this.pushAppHistory('visited_map');
    }
  }

  setRegionalMode(mode, preserveFilter = false) {
    const nextMode = mode || 'world';
    if (nextMode === 'world' || nextMode === 'us_states' || nextMode === 'india_states') {
      this.focusedState = null;
      this.focusedCountry = null;
      if (!preserveFilter) {
        this.regionalLayerFilter = 'none';
      }
    }
    this.regionalMode = nextMode;
    const regSel = document.getElementById('regional-layer-filter');
    if (regSel) {
      regSel.value = this.regionalLayerFilter || 'none';
    }
    const stSel = document.getElementById('regional-status-filter');
    if (stSel) {
      stSel.value = this.regionalStatusFilter || 'visited';
    }

    const isDrilldown = this.regionalMode !== 'world';
    const drillHeaderEl = document.getElementById('drilldown-header-bar');
    const drillTitleEl = document.getElementById('drilldown-focused-title');
    const backLbl = document.getElementById('drilldown-back-label');

    if (drillHeaderEl) {
      drillHeaderEl.classList.toggle('hidden', !isDrilldown);
      drillHeaderEl.classList.toggle('flex', !!isDrilldown);
    }

    if (this.regionalMode === 'state_focus' && this.focusedState) {
      const st = this.focusedState.place;
      const pMode = this.focusedState.parentMode;
      if (backLbl) {
        backLbl.textContent =
          pMode === 'india_states'
            ? 'India'
            : pMode === 'country_focus' && this.focusedState.parentCountry
              ? this.focusedState.parentCountry.place.name
              : 'United States';
      }
      if (drillTitleEl) {
        drillTitleEl.textContent =
          (st.flag_emoji || '📍') + ' ' + st.name + ' (' + st.state_code + ')';
      }
    } else if (this.regionalMode === 'us_states') {
      if (backLbl) backLbl.textContent = 'World Map';
      if (drillTitleEl) drillTitleEl.textContent = '🇺🇸 United States';
    } else if (this.regionalMode === 'india_states') {
      if (backLbl) backLbl.textContent = 'World Map';
      if (drillTitleEl) drillTitleEl.textContent = '🇮🇳 India';
    } else if (this.regionalMode === 'country_focus' && this.focusedCountry) {
      const co = this.focusedCountry.place;
      if (backLbl) backLbl.textContent = 'World Map';
      if (drillTitleEl) {
        drillTitleEl.textContent = (co.flag_emoji || '🌍') + ' ' + co.name;
      }
    }

    const showList = this.updateRegionalSectionVisibilityAndLabels();

    const subEl = document.getElementById('regional-subtitle');
    if (subEl) {
      if (this.regionalMode === 'world') {
        subEl.textContent =
          'Long-press any country (e.g. United States, India, Canada) to open its country & states map';
      } else if (this.regionalMode === 'state_focus' && this.focusedState) {
        const st = this.focusedState.place;
        subEl.textContent =
          (st.flag_emoji || '📍') +
          ' ' +
          st.name +
          ' (' +
          st.state_code +
          ') · Filter sights via dropdown above';
      } else if (this.regionalMode === 'country_focus' && this.focusedCountry) {
        const co = this.focusedCountry.place;
        subEl.textContent =
          (co.flag_emoji || '🌍') +
          ' ' +
          co.name +
          (co.country_code === 'CA'
            ? ' · Long-press any province to open its single-province map'
            : ' · Filter sights via dropdown above');
      } else if (this.regionalMode === 'india_states') {
        subEl.textContent =
          'Long-press any Indian state to open its single-state map · States update automatically from cities & sights';
      } else {
        subEl.textContent =
          'Long-press any US state to open its single-state map · States update automatically from cities & parks';
      }
    }
    this.currentRegionalZoom = null;
    this.drawUSVectorMap(true);
    if (showList) {
      this.renderUSParksList();
    }
  }

  renderUSParksList() {
    const listEl = document.getElementById('us-parks-list');
    if (!listEl) return;
    const searchEl = document.getElementById('us-parks-search');
    const q = ((searchEl && searchEl.value) || '').trim().toLowerCase();

    let items = [];
    if (this.regionalMode === 'state_focus' && this.focusedState) {
      const st = this.focusedState.place;
      const rawInState = this.places.filter(
        (p) => p.state_code === st.state_code && p.id !== st.id
      );
      items = this.filterRegionalPlaces(rawInState);
    } else if (this.regionalMode === 'country_focus' && this.focusedCountry) {
      const co = this.focusedCountry.place;
      const rawInCo = this.places.filter(
        (p) => p.country_code === co.country_code && p.id !== co.id
      );
      items = this.filterRegionalPlaces(rawInCo);
    } else if (this.regionalMode === 'us_parks') {
      items = this.places.filter(
        (p) =>
          this.isOfficialUSNationalPark(p) &&
          (this.regionalStatusFilter !== 'visited' || p.status === 'visited')
      );
    } else if (this.regionalMode === 'india_states') {
      const rawInIndia = this.places.filter((p) => p.country_code === 'IN');
      items = this.filterRegionalPlaces(rawInIndia);
    } else {
      const rawInUS = this.places.filter((p) => p.country_code === 'US');
      items = this.filterRegionalPlaces(rawInUS);
    }

    const filtered = items
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q) ||
          (p.state_code || '').toLowerCase() === q ||
          (p.subregion || '').toLowerCase().includes(q)
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    listEl.innerHTML = filtered
      .map((p) => {
        let cls = 'border-slate-800 bg-slate-900/60 text-slate-300';
        let badge = 'Unvisited';
        if (p.status === 'visited') {
          cls = 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300';
          badge = '✓ Visited';
        } else if (p.status === 'bucket_list') {
          cls = 'border-amber-500/50 bg-amber-500/10 text-amber-300';
          badge = '🎯 Want to Go';
        }
        return (
          '<div class="p-2.5 rounded-xl border ' +
          cls +
          ' flex items-center justify-between gap-2">' +
          '<div class="min-w-0">' +
          '<div class="text-xs font-semibold text-white truncate">' +
          (p.flag_emoji || '📍') +
          ' ' +
          p.name +
          '</div>' +
          '<div class="text-[11px] text-slate-400 truncate">' +
          (p.state_code ? p.state_code + ' · ' : '') +
          (p.description || p.category) +
          '</div>' +
          '</div>' +
          '<span class="text-[11px] font-medium px-2 py-0.5 rounded border ' +
          cls +
          ' shrink-0">' +
          badge +
          '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  isParentCategory(cat) {
    return (
      cat === 'country' ||
      cat === 'territory' ||
      cat === 'us_state' ||
      cat === 'indian_state' ||
      cat === 'canadian_province'
    );
  }

  recomputeParentRegionsLocal() {
    const visitedCountries = new Set();
    const bucketCountries = new Set();
    const visitedStates = new Set();
    const bucketStates = new Set();

    for (const p of this.places) {
      if (this.isParentCategory(p.category) || p.category === 'airport') continue;
      if (p.status === 'visited') {
        if (p.country_code) visitedCountries.add(p.country_code);
        if (p.state_code) visitedStates.add(p.state_code);
      } else if (p.status === 'bucket_list') {
        if (p.country_code) bucketCountries.add(p.country_code);
        if (p.state_code) bucketStates.add(p.state_code);
      }
    }

    for (const p of this.places) {
      if (p.category === 'country' || p.category === 'territory') {
        if (visitedCountries.has(p.country_code)) p.status = 'visited';
        else if (bucketCountries.has(p.country_code)) p.status = 'bucket_list';
        else p.status = 'unvisited';
      } else if (
        p.category === 'us_state' ||
        p.category === 'indian_state' ||
        p.category === 'canadian_province'
      ) {
        if (visitedStates.has(p.state_code)) p.status = 'visited';
        else if (bucketStates.has(p.state_code)) p.status = 'bucket_list';
        else p.status = 'unvisited';
      }
    }
  }

  async setPlaceStatusDirect(placeId, nextStatus, evt) {
    if (evt) evt.stopPropagation();
    const p = this.places.find((x) => x.id === placeId);
    if (!p) return;
    if (this.isParentCategory(p.category)) {
      this.showMobileToast(
        (p.flag_emoji || '🌍') +
        ' ' +
        p.name +
        ' is updated automatically from cities, parks & UNESCO sites'
      );
      return;
    }
    const prevStatus = p.status || 'unvisited';
    p.status = nextStatus;
    this.recordLocalActivity(p, prevStatus, nextStatus);
    const statusLabel =
      nextStatus === 'visited'
        ? '✓ Visited'
        : nextStatus === 'bucket_list'
          ? '🎯 Dream List'
          : 'Unvisited';
    this.showMobileToast((p.flag_emoji || '📍') + ' ' + p.name + ' · ' + statusLabel);
    this.recomputeParentRegionsLocal();
    this.recomputeAndRender();
    this.saveLocalBackup();
    try {
      document.getElementById('sync-status').textContent = 'Saving...';
      const res = await fetch('/api/mark', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          places: [placeId],
          status: nextStatus,
          place_meta: p.is_extended ? p : undefined,
        }),
      });
      if (res && res.ok) {
        const resData = await res.json();
        if (Array.isArray(resData.activity_log) && resData.activity_log.length > 0) {
          this.activityLog = resData.activity_log.slice(0, 25);
          this.saveLocalActivityLog();
          if (this.activeSection === 'csv') {
            this.renderRecentUpdatesList();
          }
        }
      }
      document.getElementById('sync-status').textContent =
        this.userId !== 'default' ? 'Synced · ' + this.userId : 'Synced ✓';
    } catch (e) {
      document.getElementById('sync-status').textContent = 'Saved locally (offline)';
    }
  }

  async cyclePlaceStatus(placeId) {
    if (this.suppressClickUntil && Date.now() < this.suppressClickUntil) return;
    const p = this.places.find((x) => x.id === placeId);
    if (!p) return;
    if (this.isParentCategory(p.category)) {
      const stLabel =
        p.status === 'visited'
          ? '✓ Visited'
          : p.status === 'bucket_list'
            ? '🎯 Dream List'
            : 'Unvisited';
      this.showMobileToast(
        (p.flag_emoji || '🌍') +
        ' ' +
        p.name +
        ' · ' +
        stLabel +
        ' (Updated automatically from cities & sights)'
      );
      return;
    }
    const order = ['unvisited', 'visited', 'bucket_list'];
    const next = order[(order.indexOf(p.status || 'unvisited') + 1) % order.length];
    await this.setPlaceStatusDirect(placeId, next);
  }

  onTopSearchInput(val) {
    const clearBtn = document.getElementById('top-search-clear');
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', !val || !val.trim());
    }
    this.renderViewportPlacesList();
    if (this.activeSection === 'my_places') {
      this.renderCatalogList();
    }
  }

  clearTopSearch() {
    const inp = document.getElementById('top-search-input');
    if (inp) inp.value = '';
    const clearBtn = document.getElementById('top-search-clear');
    if (clearBtn) clearBtn.classList.add('hidden');
    this.renderViewportPlacesList();
    if (this.activeSection === 'my_places') {
      this.renderCatalogList();
    }
  }

  renderLeafActionButtons(p) {
    if (p.status === 'visited') {
      return (
        '<div class="flex items-center gap-1 shrink-0">' +
        '<span class="text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">✓ Visited</span>' +
        '</div>'
      );
    }
    if (p.status === 'bucket_list') {
      return (
        '<div class="flex items-center gap-1 shrink-0">' +
        '<span class="text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40">🎯 Want to Go</span>' +
        '</div>'
      );
    }
    return (
      '<div class="flex items-center gap-1 shrink-0">' +
      '<span class="text-[11px] font-medium px-2.5 py-1 rounded-lg bg-slate-800/80 text-slate-400 border border-slate-700/80">Not Visited</span>' +
      '</div>'
    );
  }

  populateExploreCountryFilter() {
    const sel = document.getElementById('explore-country-filter');
    if (!sel) return;
    const prev = this.exploreCountryFilter || 'all';
    const countries = this.places
      .filter((p) => p.category === 'country')
      .sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML =
      '<option value="all">🌍 All Countries</option>' +
      countries
        .map(
          (c) =>
            '<option value="' +
            c.country_code +
            '">' +
            (c.flag_emoji || '🌍') +
            ' ' +
            c.name +
            '</option>'
        )
        .join('');
    sel.value = prev;
  }

  setExploreCountryFilter(cc) {
    this.exploreCountryFilter = cc || 'all';
    const sel = document.getElementById('explore-country-filter');
    if (sel && sel.value !== this.exploreCountryFilter) {
      sel.value = this.exploreCountryFilter;
    }
    this.renderCatalogList();
  }

  focusCountryInExplore(cc, evt) {
    if (evt) evt.stopPropagation();
    if (!cc) return;
    this.exploreCountryFilter = cc;
    const countrySel = document.getElementById('explore-country-filter');
    if (countrySel) countrySel.value = cc;
    this.setFilterCat('city');
    this.openSection('my_places');
  }

  setExploreStatusMode(mode) {
    this.exploreStatusMode = mode || 'bucket_list';
    const dreamBtn = document.getElementById('explore-mode-dream');
    const visBtn = document.getElementById('explore-mode-visited');
    const allBtn = document.getElementById('explore-mode-all');
    if (dreamBtn) {
      dreamBtn.className =
        this.exploreStatusMode === 'bucket_list'
          ? 'py-1.5 px-2 rounded-lg text-xs font-semibold bg-amber-500 text-slate-950 text-center truncate'
          : 'py-1.5 px-2 rounded-lg text-xs font-semibold text-slate-300 text-center truncate';
    }
    if (visBtn) {
      visBtn.className =
        this.exploreStatusMode === 'visited'
          ? 'py-1.5 px-2 rounded-lg text-xs font-semibold bg-emerald-500 text-slate-950 text-center truncate'
          : 'py-1.5 px-2 rounded-lg text-xs font-semibold text-slate-300 text-center truncate';
    }
    if (allBtn) {
      allBtn.className =
        this.exploreStatusMode === 'all'
          ? 'py-1.5 px-2 rounded-lg text-xs font-semibold bg-sky-500 text-slate-950 text-center truncate'
          : 'py-1.5 px-2 rounded-lg text-xs font-semibold text-slate-300 text-center truncate';
    }
    this.renderCatalogList();
  }

  setFilterCat(cat) {
    this.filterCat = cat || 'country';
    const catSel = document.getElementById('explore-cat-filter');
    if (catSel && catSel.value !== this.filterCat) {
      catSel.value = this.filterCat;
    }
    this.renderCatalogList();
  }

  selectMyPlacesTile(tileKey) {
    this.myPlacesTile = tileKey || 'countries_states';
    this.renderCatalogList();
  }

  toggleContinentAccordion(continentName) {
    if (!continentName) return;
    this.expandedContinents[continentName] = !this.expandedContinents[continentName];
    this.renderCatalogList();
  }

  toggleCountryStatesAccordion(countryCode, evt) {
    if (evt) evt.stopPropagation();
    if (!countryCode) return;
    this.expandedCountryStates[countryCode] = !this.expandedCountryStates[countryCode];
    this.renderCatalogList();
  }

  getMyPlacesTileDefinitions() {
    return [
      {
        key: 'countries_states',
        label: 'Countries+States',
        icon: '🗺️',
        bgActive: 'from-amber-700/80 via-amber-900/75 to-stone-950',
      },
      {
        key: 'visited_places',
        label: 'Visited Places',
        icon: '🪧',
        bgActive: 'from-emerald-700/80 via-emerald-900/75 to-slate-950',
      },
      {
        key: 'bucket_list',
        label: 'Bucket List',
        icon: '🧭',
        bgActive: 'from-amber-600/80 via-amber-800/75 to-slate-950',
      },
      {
        key: 'capitals',
        label: 'Visited Capitals',
        icon: '🏛️',
        bgActive: 'from-sky-700/80 via-sky-900/75 to-slate-950',
      },
      {
        key: 'top_airports',
        label: 'Top 25 Airports',
        icon: '✈️',
        bgActive: 'from-cyan-700/80 via-cyan-900/75 to-slate-950',
      },
      {
        key: 'world_cities',
        label: 'World Cities',
        icon: '🏙️',
        bgActive: 'from-indigo-700/80 via-indigo-900/75 to-slate-950',
      },
      {
        key: 'national_parks',
        label: 'National Parks',
        icon: '🌲',
        bgActive: 'from-teal-700/80 via-teal-900/75 to-slate-950',
      },
      {
        key: 'world_wonders',
        label: 'World Wonders',
        icon: '🏔️',
        bgActive: 'from-rose-700/80 via-rose-900/75 to-slate-950',
      },
      {
        key: 'unesco_sites',
        label: 'UNESCO Sites',
        icon: '🎈',
        bgActive: 'from-purple-700/80 via-purple-900/75 to-slate-950',
      },
    ];
  }

  getCapitalPlaces() {
    const countries = this.places.filter((p) => p.category === 'country');
    const cities = this.places.filter((p) => p.category === 'city');
    const cityByCountryAndName = {};
    cities.forEach((c) => {
      const k = (c.country_code || '') + ':' + c.name.toLowerCase();
      cityByCountryAndName[k] = c;
    });

    const out = [];
    countries.forEach((co) => {
      const desc = co.description || '';
      const m = desc.match(/Capital:\s*([^·]+)/i);
      if (!m) return;
      const capName = m[1].trim();
      if (!capName) return;
      const k = (co.country_code || '') + ':' + capName.toLowerCase();
      const matchedCity =
        cityByCountryAndName[k] ||
        cities.find(
          (c) =>
            c.country_code === co.country_code &&
            (c.name.toLowerCase() === capName.toLowerCase() ||
              c.name.toLowerCase().includes(capName.toLowerCase()) ||
              capName.toLowerCase().includes(c.name.toLowerCase()))
        );
      if (matchedCity) {
        out.push({
          ...matchedCity,
          subText: 'Capital of ' + co.name + ' (' + co.flag_emoji + ')',
          isLeaf: true,
        });
      } else {
        out.push({
          id: co.id,
          name: capName,
          flag_emoji: co.flag_emoji || '🏛️',
          continent: co.continent,
          country_code: co.country_code,
          status: co.status || 'unvisited',
          subText: 'Capital of ' + co.name,
          isLeaf: false,
          rawAddName: capName + ', ' + co.name,
        });
      }
    });
    return out;
  }

  renderCatalogList() {
    const listEl = document.getElementById('catalog-list');
    const tileGridEl = document.getElementById('my-places-tile-grid');
    const activeLblEl = document.getElementById('my-places-active-label');
    if (!listEl) return;

    const tileDefs = this.getMyPlacesTileDefinitions();
    const activeTileKey = this.myPlacesTile || 'countries_states';
    const activeTileObj = tileDefs.find((t) => t.key === activeTileKey) || tileDefs[0];

    if (tileGridEl) {
      tileGridEl.innerHTML = tileDefs
        .map((t) => {
          const isActive = t.key === activeTileKey;
          const bgCls = isActive
            ? 'bg-gradient-to-br ' + t.bgActive + ' ring-1 ring-inset ring-amber-400/60'
            : 'bg-gradient-to-br from-slate-700/60 via-slate-800/80 to-slate-950 opacity-80 hover:opacity-100';
          return (
            '<button type="button" onclick="app.selectMyPlacesTile(\'' +
            t.key +
            '\')" class="relative h-20 sm:h-24 overflow-hidden flex flex-col items-center justify-between p-2 transition select-none ' +
            bgCls +
            '">' +
            '<div class="flex-1 flex items-center justify-center text-2xl sm:text-3xl drop-shadow ' +
            (isActive ? '' : 'grayscale opacity-80') +
            '">' +
            t.icon +
            '</div>' +
            '<div class="w-full text-center text-[11px] sm:text-xs font-extrabold tracking-tight truncate ' +
            (isActive ? 'text-amber-200 drop-shadow' : 'text-slate-200') +
            '">' +
            t.label +
            '</div>' +
            '</button>'
          );
        })
        .join('');
    }

    if (activeLblEl) {
      activeLblEl.textContent = activeTileObj.icon + ' ' + activeTileObj.label;
    }

    const mySearchEl = document.getElementById('my-places-search');
    const topSearchEl = document.getElementById('top-search-input');
    const q = (
      ((mySearchEl && mySearchEl.value) || (topSearchEl && topSearchEl.value) || '')
    )
      .trim()
      .toLowerCase();

    const continentsOrder = [
      { name: 'Asia', icon: '🌏' },
      { name: 'Africa', icon: '🌍' },
      { name: 'Europe', icon: '🌍' },
      { name: 'North America', icon: '🌎' },
      { name: 'South America', icon: '🌎' },
      { name: 'Oceania', icon: '🌏' },
      { name: 'Antarctica', icon: '❄️' },
    ];

    // Gather candidate items for the active tile
    let tileItems = [];
    let countMode = 'ratio'; // 'ratio' -> (vis/tot), 'single' -> (count)

    if (activeTileKey === 'countries_states') {
      tileItems = this.places.filter((p) => p.category === 'country');
    } else if (activeTileKey === 'visited_places') {
      countMode = 'single';
      tileItems = this.places.filter(
        (p) => !this.isParentCategory(p.category) && p.status === 'visited'
      );
    } else if (activeTileKey === 'bucket_list') {
      countMode = 'single';
      tileItems = this.places.filter(
        (p) => !this.isParentCategory(p.category) && p.status === 'bucket_list'
      );
    } else if (activeTileKey === 'capitals') {
      tileItems = this.getCapitalPlaces();
    } else if (activeTileKey === 'top_airports') {
      tileItems = this.getTop25Airports().map(({ place, rank, pax, cleanName }) => ({
        ...place,
        displayName: cleanName,
        subText:
          'Rank #' +
          rank +
          (pax ? ' · ' + pax + ' passengers' : '') +
          (place.subregion ? ' · ' + place.subregion.replace(/^Airport\s*\((.+)\)$/i, '$1') : ''),
        rank,
      }));
    } else if (activeTileKey === 'world_cities') {
      tileItems = this.places.filter((p) => p.category === 'city');
    } else if (activeTileKey === 'national_parks') {
      tileItems = this.places.filter((p) => p.category === 'national_park');
    } else if (activeTileKey === 'world_wonders') {
      tileItems = this.places.filter((p) => p.category === 'world_wonder');
    } else if (activeTileKey === 'unesco_sites') {
      tileItems = this.places.filter((p) => p.category === 'unesco');
    }

    const matchesSearch = (item) =>
      !q ||
      (item.displayName || item.name || '').toLowerCase().includes(q) ||
      (item.description || '').toLowerCase().includes(q) ||
      (item.subText || '').toLowerCase().includes(q) ||
      (item.country_code || '').toLowerCase() === q ||
      (item.state_code || '').toLowerCase() === q;

    const statusRank = { visited: 0, bucket_list: 1, unvisited: 2 };

    if (activeTileKey === 'top_airports') {
      const rankedAirports = tileItems
        .filter(matchesSearch)
        .sort((a, b) => (a.rank || 999) - (b.rank || 999));

      if (rankedAirports.length === 0) {
        listEl.innerHTML =
          '<div class="p-6 text-center text-xs text-slate-400">No airports match this filter.</div>';
        return;
      }

      listEl.innerHTML =
        '<div class="divide-y divide-white/5 bg-slate-950/70">' +
        rankedAirports
          .map(
            (p) =>
              '<div class="px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-white/[0.02]">' +
              '<div class="min-w-0">' +
              '<div class="text-xs font-semibold text-white truncate">' +
              (p.flag_emoji || '✈️') +
              ' ' +
              (p.displayName || p.name) +
              '</div>' +
              '<div class="text-[11px] text-slate-400 truncate">' +
              (p.subText || p.description || '') +
              '</div>' +
              '</div>' +
              this.renderLeafActionButtons(p) +
              '</div>'
          )
          .join('') +
        '</div>';
      return;
    }

    const continentRowsHtml = continentsOrder
      .map((cont) => {
        const inContAll = tileItems.filter((item) => (item.continent || 'Asia') === cont.name);
        const inContFiltered = inContAll.filter(matchesSearch);
        if (inContAll.length === 0 || inContFiltered.length === 0) return '';

        const visCount = inContAll.filter((i) => i.status === 'visited').length;
        const totCount = inContAll.length;
        const rightCountText =
          countMode === 'single'
            ? '(' + inContFiltered.length + ')'
            : '(' + visCount + '/' + totCount + ')';

        const isExpanded = q ? inContFiltered.length > 0 : !!this.expandedContinents[cont.name];
        const chevron = isExpanded ? '▾' : '▸';

        let bodyHtml = '';
        if (isExpanded) {
          const sorted = inContFiltered.slice().sort((a, b) => {
            const ra = statusRank[a.status || 'unvisited'] ?? 2;
            const rb = statusRank[b.status || 'unvisited'] ?? 2;
            if (ra !== rb) return ra - rb;
            if (a.rank && b.rank) return a.rank - b.rank;
            return (a.displayName || a.name).localeCompare(b.displayName || b.name);
          });

          if (sorted.length === 0) {
            bodyHtml =
              '<div class="px-4 py-3 text-xs text-slate-500 bg-slate-950/60">No places in ' +
              cont.name +
              ' for this view.</div>';
          } else if (activeTileKey === 'countries_states') {
            bodyHtml =
              '<div class="divide-y divide-white/5 bg-slate-950/70">' +
              sorted
                .map((co) => {
                  const stateCat =
                    co.country_code === 'US'
                      ? 'us_state'
                      : co.country_code === 'IN'
                        ? 'indian_state'
                        : co.country_code === 'CA'
                          ? 'canadian_province'
                          : null;
                  const states = stateCat
                    ? this.places.filter((s) => s.category === stateCat)
                    : [];
                  const visStates = states.filter((s) => s.status === 'visited').length;

                  const childPlaces = this.places.filter(
                    (ch) =>
                      !this.isParentCategory(ch.category) &&
                      ch.category !== 'airport' &&
                      ch.country_code === co.country_code &&
                      (ch.status === 'visited' || ch.status === 'bucket_list')
                  );
                  const visLeaf = childPlaces.filter((ch) => ch.status === 'visited').length;
                  const wantLeaf = childPlaces.filter((ch) => ch.status === 'bucket_list').length;

                  const subParts = [];
                  if (states.length > 0) {
                    subParts.push(visStates + '/' + states.length + ' states visited');
                  }
                  if (visLeaf > 0) subParts.push(visLeaf + ' visited places');
                  if (wantLeaf > 0) subParts.push(wantLeaf + ' want to go');

                  const statusBadge =
                    co.status === 'visited'
                      ? '<span class="text-[10px] sm:text-[11px] font-semibold px-1.5 sm:px-2 py-0.5 rounded border border-emerald-500/50 bg-emerald-500/15 text-emerald-300 shrink-0">✓ Visited</span>'
                      : co.status === 'bucket_list'
                        ? '<span class="text-[10px] sm:text-[11px] font-semibold px-1.5 sm:px-2 py-0.5 rounded border border-amber-500/50 bg-amber-500/15 text-amber-300 shrink-0">🎯 Want</span>'
                        : '<span class="text-[10px] sm:text-[11px] font-medium px-1.5 sm:px-2 py-0.5 rounded border border-slate-700 bg-slate-800/80 text-slate-400 shrink-0">Not Visited</span>';

                  const hasStates = states.length > 0;
                  const statesExpanded = !!this.expandedCountryStates[co.country_code];
                  const leftChevron = hasStates
                    ? '<span class="text-emerald-400 text-xs w-3.5 inline-block font-bold shrink-0">' +
                      (statesExpanded ? '▾' : '▸') +
                      '</span>'
                    : '<span class="w-3.5 inline-block shrink-0"></span>';
                  const stateBtnHtml = hasStates
                    ? '<span class="px-1.5 sm:px-2 py-0.5 rounded bg-slate-800 text-[10px] sm:text-[11px] font-semibold text-sky-300 border border-sky-500/30 shrink-0">' +
                      (statesExpanded
                        ? '▾ States ' + visStates + '/' + states.length
                        : '▸ States ' + visStates + '/' + states.length) +
                      '</span>'
                    : '';

                  let nestedStatesHtml = '';
                  if (hasStates && statesExpanded) {
                    const sortedStates = states.slice().sort((a, b) => {
                      const ra = statusRank[a.status || 'unvisited'] ?? 2;
                      const rb = statusRank[b.status || 'unvisited'] ?? 2;
                      if (ra !== rb) return ra - rb;
                      return a.name.localeCompare(b.name);
                    });
                    nestedStatesHtml =
                      '<div class="pl-7 pr-3 py-2.5 bg-slate-900/80 border-t border-white/5 grid grid-cols-1 sm:grid-cols-2 gap-1.5">' +
                      sortedStates
                        .map((st) => {
                          const stBadge =
                            st.status === 'visited'
                              ? '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shrink-0">✓ Visited</span>'
                              : st.status === 'bucket_list'
                                ? '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0">🎯 Want</span>'
                                : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0">Not Visited</span>';
                          return (
                            '<div class="px-2.5 py-1.5 rounded-lg bg-slate-950/90 border border-white/5 flex items-center justify-between gap-2">' +
                            '<span class="text-xs text-slate-200 truncate">' +
                            (st.flag_emoji || '📍') +
                            ' ' +
                            st.name +
                            (st.state_code ? ' (' + st.state_code + ')' : '') +
                            '</span>' +
                            stBadge +
                            '</div>'
                          );
                        })
                        .join('') +
                      '</div>';
                  }

                  const rowClickAttr = hasStates
                    ? 'onclick="app.toggleCountryStatesAccordion(\'' +
                      co.country_code +
                      '\', event)" class="px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-white/[0.04] cursor-pointer select-none"'
                    : 'class="px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-white/[0.02]"';

                  return (
                    '<div>' +
                    '<div ' +
                    rowClickAttr +
                    '>' +
                    '<div class="min-w-0 flex items-center gap-1.5">' +
                    leftChevron +
                    '<div class="min-w-0">' +
                    '<div class="text-xs font-semibold text-white truncate">' +
                    (co.flag_emoji || '🌍') +
                    ' ' +
                    co.name +
                    '</div>' +
                    (subParts.length
                      ? '<div class="text-[11px] text-slate-400 truncate">' +
                        subParts.join(' · ') +
                        '</div>'
                      : '') +
                    '</div>' +
                    '</div>' +
                    '<div class="flex items-center gap-1.5 shrink-0">' +
                    stateBtnHtml +
                    statusBadge +
                    '</div>' +
                    '</div>' +
                    nestedStatesHtml +
                    '</div>'
                  );
                })
                .join('') +
              '</div>';
          } else {
            bodyHtml =
              '<div class="divide-y divide-white/5 bg-slate-950/70">' +
              sorted
                .slice(0, 200)
                .map((p) => {
                  const isCapUnmatched = activeTileKey === 'capitals' && p.isLeaf === false;
                  const rightCtrl = isCapUnmatched
                    ? '<span class="text-[11px] font-medium px-2.5 py-1 rounded-lg bg-slate-800/80 text-slate-400 border border-slate-700/80">Not Visited</span>'
                    : this.renderLeafActionButtons(p);

                  return (
                    '<div class="px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-white/[0.02]">' +
                    '<div class="min-w-0">' +
                    '<div class="text-xs font-semibold text-white truncate">' +
                    (p.flag_emoji || '📍') +
                    ' ' +
                    (p.displayName || p.name) +
                    '</div>' +
                    '<div class="text-[11px] text-slate-400 truncate">' +
                    (p.subText || p.description || p.category || '') +
                    '</div>' +
                    '</div>' +
                    rightCtrl +
                    '</div>'
                  );
                })
                .join('') +
              '</div>';
          }
        }

        return (
          '<div>' +
          '<button type="button" onclick="app.toggleContinentAccordion(\'' +
          cont.name +
          '\')" class="w-full px-3.5 py-3 flex items-center justify-between gap-3 hover:bg-white/[0.04] transition text-left">' +
          '<div class="flex items-center gap-3 min-w-0">' +
          '<span class="text-xs text-slate-400 w-3 text-center">' +
          chevron +
          '</span>' +
          '<span class="text-lg leading-none grayscale opacity-80">' +
          cont.icon +
          '</span>' +
          '<span class="text-sm font-medium text-slate-200 truncate">' +
          cont.name +
          '</span>' +
          '</div>' +
          '<span class="text-sm font-medium text-slate-400 shrink-0">' +
          rightCountText +
          '</span>' +
          '</button>' +
          bodyHtml +
          '</div>'
        );
      })
      .join('');

    listEl.innerHTML =
      continentRowsHtml ||
      '<div class="p-6 text-center text-xs text-slate-400">No places in this section yet.</div>';
  }

  async quickAddAndMarkCity(rawCityQuery, targetStatus = 'visited') {
    if (!rawCityQuery) return;
    const statusEl = document.getElementById('sync-status');
    if (statusEl) statusEl.textContent = 'Geocoding & saving ' + rawCityQuery + '...';
    this.showMobileToast('📍 Geocoding ' + rawCityQuery + '...');
    try {
      await fetch('/api/mark', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ places: [rawCityQuery], status: targetStatus }),
      });
      this.clearTopSearch();
      await this.bootstrapState();
      this.showMobileToast(
        (targetStatus === 'visited' ? '✓ Visited ' : '🎯 Dream List: ') + rawCityQuery
      );
    } catch (_) {
      if (statusEl) statusEl.textContent = 'Could not geocode while offline';
    }
  }

  switchTab(tab) {
    if (tab === 'world') this.openSection('home');
    else if (tab === 'us') this.openSection('us_parks');
    else if (tab === 'explore') this.openSection('my_places');
  }

  zoomWorldBy(factor) {
    this.initHomeGoogleMap();
    if (!this.homeMap) return;
    if (factor > 1) {
      this.homeMap.zoomIn(1);
    } else {
      this.homeMap.zoomOut(1);
    }
  }

  resetMapZoom() {
    this.initHomeGoogleMap();
    if (!this.homeMap) return;
    const geo = this.clientGeo;
    if (geo && typeof geo.lat === 'number' && typeof geo.lng === 'number') {
      const c = this.homeMap.getCenter();
      const nearCity =
        c && Math.abs(c.lat - geo.lat) < 0.35 && Math.abs(c.lng - geo.lng) < 0.35;
      if (!nearCity || (this.homeMap.getZoom() || 9) < 7) {
        this.homeMap.flyTo([geo.lat, geo.lng], 9, { duration: 0.4 });
        return;
      }
    }
    this.homeMap.flyTo([25, 0], 2, { duration: 0.4 });
  }

  zoomRegionalBy(factor) {
    if (!this.regionalZoomBehavior) return;
    const svg = d3.select('#us-svg');
    svg.transition().duration(250).call(this.regionalZoomBehavior.scaleBy, factor);
  }

  resetRegionalZoom() {
    if (!this.regionalZoomBehavior) return;
    const svg = d3.select('#us-svg');
    this.currentRegionalZoom = d3.zoomIdentity;
    svg.transition().duration(300).call(this.regionalZoomBehavior.transform, d3.zoomIdentity);
  }

  showTooltip(elId, wrapId, evt, htmlContent) {
    const tip = document.getElementById(elId);
    const wrap = document.getElementById(wrapId);
    if (!tip || !wrap) return;
    tip.innerHTML = htmlContent;
    tip.classList.remove('hidden');
    const rect = wrap.getBoundingClientRect();
    const x = (evt.clientX || 0) - rect.left;
    const y = (evt.clientY || 0) - rect.top;
    tip.style.left = Math.min(rect.width - 210, Math.max(8, x + 14)) + 'px';
    tip.style.top = Math.min(rect.height - 80, Math.max(8, y - 12)) + 'px';
  }

  hideTooltip(elId) {
    const tip = document.getElementById(elId);
    if (tip) tip.classList.add('hidden');
  }

  initHomeGoogleMap() {
    if (this.homeMap || typeof L === 'undefined') return;
    const mapEl = document.getElementById('home-google-map');
    if (!mapEl) return;

    const initLat =
      this.clientGeo && typeof this.clientGeo.lat === 'number' ? this.clientGeo.lat : 37.77;
    const initLng =
      this.clientGeo && typeof this.clientGeo.lng === 'number' ? this.clientGeo.lng : -122.42;
    const initZoom =
      this.clientGeo && typeof this.clientGeo.lat === 'number' ? 9 : 5;
    if (this.clientGeo && typeof this.clientGeo.lat === 'number') {
      this.hasInitialCityFocus = true;
    }

    this.homeMap = L.map(mapEl, {
      center: [initLat, initLng],
      zoom: initZoom,
      minZoom: 2,
      maxZoom: 12,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
      worldCopyJump: true,
    });

    L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=en&gl=US&x={x}&y={y}&z={z}', {
      subdomains: ['0', '1', '2', '3'],
      minZoom: 2,
      maxZoom: 12,
    }).addTo(this.homeMap);

    this.homeCanvasRenderer = L.canvas({ padding: 0.5 });
    this.homePinsLayer = L.layerGroup().addTo(this.homeMap);

    this.homeMap.on('dragstart zoomstart', (evt) => {
      if (evt && evt.originalEvent) {
        this.userHasManuallyZoomed = true;
      }
    });
    this.homeMap.on('moveend zoomend', () => {
      this.scheduleViewportListUpdate();
    });
  }

  drawWorldMap(resetProj) {
    this.initHomeGoogleMap();
    if (!this.homeMap) return;
    this.homeMap.invalidateSize();
    this.scheduleViewportListUpdate();
  }

  drawGlobe(resetSpin = false) {
    const svgEl = document.getElementById('globe-svg');
    if (!svgEl || !this.worldTopo || typeof d3 === 'undefined' || typeof topojson === 'undefined') return;
    if (resetSpin) {
      this.globeRotation = [-20, -20, 0];
    }
    const rect = svgEl.getBoundingClientRect();
    const W = rect.width || 600;
    const H = rect.height || 420;
    const radius = Math.min(W, H) * 0.44;

    const countriesGeo = topojson.feature(this.worldTopo, this.worldTopo.objects.countries);
    const projection = d3
      .geoOrthographic()
      .scale(radius)
      .translate([W / 2, H / 2])
      .clipAngle(90)
      .rotate(this.globeRotation);
    const pathGen = d3.geoPath().projection(projection);

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    svg
      .append('circle')
      .attr('cx', W / 2)
      .attr('cy', H / 2)
      .attr('r', radius)
      .attr('fill', '#081426')
      .attr('stroke', 'rgba(56,189,248,0.35)')
      .attr('stroke-width', 1.5);

    const graticulePath = svg
      .append('path')
      .datum(d3.geoGraticule10())
      .attr('d', pathGen)
      .attr('fill', 'none')
      .attr('stroke', 'rgba(148,163,184,0.1)')
      .attr('stroke-width', 0.6);

    const countryPaths = svg
      .append('g')
      .selectAll('path')
      .data(countriesGeo.features)
      .join('path')
      .attr('d', pathGen)
      .attr('fill', (feat) => {
        const c = this.resolveCountryFeature(feat);
        if (!c) return '#152033';
        if (c.status === 'visited') return this.visitedColor;
        if (c.status === 'bucket_list') return this.dreamColor;
        return '#162235';
      })
      .attr('stroke', '#293b56')
      .attr('stroke-width', 0.6);

    svg.call(
      d3.drag().on('drag', (event) => {
        const r = projection.rotate();
        const sens = 0.35;
        this.globeRotation = [
          r[0] + event.dx * sens,
          Math.max(-85, Math.min(85, r[1] - event.dy * sens)),
          r[2],
        ];
        projection.rotate(this.globeRotation);
        graticulePath.attr('d', pathGen);
        countryPaths.attr('d', pathGen);
      })
    );
  }

  getTop25Airports() {
    // 2025 Busiest Airports by Passenger Traffic (Wikipedia / ACI World 2025 statistics)
    const top25List = [
      { code: 'ATL', pax: '106.3M', cleanName: 'Hartsfield-Jackson Atlanta International Airport' },
      { code: 'DXB', pax: '95.2M', cleanName: 'Dubai International Airport' },
      { code: 'HND', pax: '91.7M', cleanName: 'Tokyo Haneda Airport' },
      { code: 'DFW', pax: '85.7M', cleanName: 'Dallas/Fort Worth International Airport' },
      { code: 'PVG', pax: '85.0M', cleanName: 'Shanghai Pudong International Airport' },
      { code: 'ORD', pax: '84.9M', cleanName: "O'Hare International Airport" },
      { code: 'LHR', pax: '84.5M', cleanName: 'London Heathrow Airport' },
      { code: 'IST', pax: '84.4M', cleanName: 'Istanbul Airport' },
      { code: 'CAN', pax: '83.6M', cleanName: 'Guangzhou Baiyun International Airport' },
      { code: 'DEN', pax: '82.4M', cleanName: 'Denver International Airport' },
      { code: 'DEL', pax: '78.1M', cleanName: 'Indira Gandhi International Airport' },
      { code: 'ICN', pax: '74.1M', cleanName: 'Incheon International Airport' },
      { code: 'LAX', pax: '73.7M', cleanName: 'Los Angeles International Airport' },
      { code: 'CDG', pax: '72.0M', cleanName: 'Charles de Gaulle Airport' },
      { code: 'PEK', pax: '70.7M', cleanName: 'Beijing Capital International Airport' },
      { code: 'SIN', pax: '70.0M', cleanName: 'Singapore Changi Airport' },
      { code: 'AMS', pax: '68.8M', cleanName: 'Amsterdam Airport Schiphol' },
      { code: 'MAD', pax: '68.1M', cleanName: 'Adolfo Suárez Madrid–Barajas Airport' },
      { code: 'SZX', pax: '66.5M', cleanName: "Shenzhen Bao'an International Airport" },
      { code: 'KUL', pax: '63.4M', cleanName: 'Kuala Lumpur International Airport' },
      { code: 'FRA', pax: '63.2M', cleanName: 'Frankfurt Airport' },
      { code: 'BKK', pax: '62.9M', cleanName: 'Suvarnabhumi Airport' },
      { code: 'JFK', pax: '62.6M', cleanName: 'John F. Kennedy International Airport' },
      { code: 'HKG', pax: '61.0M', cleanName: 'Hong Kong International Airport' },
      { code: 'MCO', pax: '57.7M', cleanName: 'Orlando International Airport' },
    ];
    const byCode = {};
    this.places
      .filter((p) => p.category === 'airport')
      .forEach((a) => {
        const code = (a.iata_code || (a.id || '').replace('airport:', '')).toUpperCase();
        byCode[code] = a;
      });
    return top25List
      .map((entry, idx) => {
        const a = byCode[entry.code];
        if (!a) return null;
        const fallbackClean = (a.name || '').replace(/^[A-Z0-9]{3}\s*[—–-]\s*/, '');
        return {
          place: a,
          rank: idx + 1,
          pax: entry.pax,
          cleanName: entry.cleanName || fallbackClean,
        };
      })
      .filter(Boolean);
  }

  selectStatsCircle(key) {
    if (this.activeStatsCircle === key) {
      this.activeStatsCircle = null;
    } else {
      this.activeStatsCircle = key;
      this.statsCircleStatusFilter = 'all';
      this.statsCircleSearch = '';
    }
    this.renderStatisticsPage();
  }

  setStatsCircleStatusFilter(st) {
    this.statsCircleStatusFilter = st || 'all';
    this.renderStatisticsPage();
  }

  onStatsCircleSearch(val) {
    this.statsCircleSearch = val || '';
    this.renderStatsCircleDetailListOnly();
  }

  getStatsCircleItems(circleKey) {
    if (circleKey === 'continents') {
      const allContinents = [
        { name: 'Asia', emoji: '🌏' },
        { name: 'Europe', emoji: '🌍' },
        { name: 'North America', emoji: '🌎' },
        { name: 'South America', emoji: '🌎' },
        { name: 'Africa', emoji: '🌍' },
        { name: 'Oceania', emoji: '🌏' },
        { name: 'Antarctica', emoji: '❄️' },
      ];
      const countries = this.places.filter((p) => p.category === 'country');
      return allContinents.map((c) => {
        const inCont = countries.filter((co) => co.continent === c.name);
        const vis = inCont.filter((co) => co.status === 'visited').length;
        const want = inCont.filter((co) => co.status === 'bucket_list').length;
        const status = vis > 0 ? 'visited' : want > 0 ? 'bucket_list' : 'unvisited';
        const subParts = [];
        if (vis > 0) subParts.push(vis + ' visited');
        if (want > 0) subParts.push(want + ' want to go');
        subParts.push(inCont.length + ' countries total');
        return {
          id: 'continent:' + c.name,
          name: c.name,
          flag_emoji: c.emoji,
          status,
          subText: subParts.join(' · '),
          isParent: true,
        };
      });
    }
    if (circleKey === 'countries') {
      return this.places
        .filter((p) => p.category === 'country')
        .map((p) => ({
          id: p.id,
          name: p.name,
          flag_emoji: p.flag_emoji || '🌍',
          status: p.status || 'unvisited',
          subText: p.continent || '',
          isParent: true,
        }));
    }
    if (circleKey === 'us_states') {
      return this.places
        .filter((p) => p.category === 'us_state')
        .map((p) => ({
          id: p.id,
          name: p.name + (p.state_code ? ' (' + p.state_code + ')' : ''),
          flag_emoji: '🇺🇸',
          status: p.status || 'unvisited',
          subText: p.description || 'US State',
          isParent: true,
        }));
    }
    if (circleKey === 'indian_states') {
      return this.places
        .filter((p) => p.category === 'indian_state')
        .map((p) => ({
          id: p.id,
          name: p.name,
          flag_emoji: '🇮🇳',
          status: p.status || 'unvisited',
          subText: (p.state_code ? p.state_code + ' · ' : '') + (p.description || 'Indian State / UT'),
          isParent: true,
        }));
    }
    if (circleKey === 'national_parks') {
      return this.places
        .filter((p) => p.category === 'national_park')
        .map((p) => ({
          id: p.id,
          name: p.name,
          flag_emoji: p.flag_emoji || '🌲',
          status: p.status || 'unvisited',
          subText: (p.state_code ? p.state_code + ' · ' : '') + (p.description || 'National Park'),
          isParent: false,
        }));
    }
    if (circleKey === 'top25_airports') {
      return this.getTop25Airports().map(({ place, rank, pax, cleanName }) => ({
        id: place.id,
        name: cleanName,
        flag_emoji: '✈️',
        status: place.status || 'unvisited',
        subText:
          'Rank #' +
          rank +
          (pax ? ' · ' + pax + ' passengers' : '') +
          (place.subregion ? ' · ' + place.subregion.replace(/^Airport\s*\((.+)\)$/i, '$1') : ''),
        isParent: false,
        rank,
      }));
    }
    return [];
  }

  renderStatsCircleDetailListOnly() {
    const listWrap = document.getElementById('stats-circle-items-grid');
    if (!listWrap || !this.activeStatsCircle) return;
    const allItems = this.getStatsCircleItems(this.activeStatsCircle);
    const stFilter = this.statsCircleStatusFilter || 'all';
    const q = (this.statsCircleSearch || '').trim().toLowerCase();

    const filtered = allItems.filter((item) => {
      if (stFilter !== 'all' && item.status !== stFilter) return false;
      if (
        q &&
        !item.name.toLowerCase().includes(q) &&
        !(item.subText || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });

    const statusOrder = { visited: 0, bucket_list: 1, unvisited: 2 };
    filtered.sort((a, b) => {
      if (a.rank && b.rank) return a.rank - b.rank;
      const sa = statusOrder[a.status] ?? 2;
      const sb = statusOrder[b.status] ?? 2;
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name);
    });

    if (filtered.length === 0) {
      listWrap.innerHTML =
        '<div class="col-span-full p-4 rounded-xl border border-dashed border-slate-700 text-center text-xs text-slate-400">No items match this filter.</div>';
      return;
    }

    listWrap.innerHTML = filtered
      .map((item) => {
        let cardCls = 'border-slate-800 bg-slate-900/60 text-slate-300';
        let badgeHtml =
          '<span class="text-[11px] font-medium px-2 py-0.5 rounded border border-slate-700 bg-slate-800/80 text-slate-400 shrink-0">Not Visited</span>';
        if (item.status === 'visited') {
          cardCls = 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300';
          badgeHtml =
            '<span class="text-[11px] font-semibold px-2 py-0.5 rounded border border-emerald-500/50 bg-emerald-500/15 text-emerald-300 shrink-0">✓ Visited</span>';
        } else if (item.status === 'bucket_list') {
          cardCls = 'border-amber-500/50 bg-amber-500/10 text-amber-300';
          badgeHtml =
            '<span class="text-[11px] font-semibold px-2 py-0.5 rounded border border-amber-500/50 bg-amber-500/15 text-amber-300 shrink-0">🎯 Want to Go</span>';
        }

        const rightControls = item.isParent
          ? badgeHtml
          : this.renderLeafActionButtons({ id: item.id, status: item.status });

        return (
          '<div class="p-2.5 rounded-xl border ' +
          cardCls +
          ' flex items-center justify-between gap-2">' +
          '<div class="min-w-0">' +
          '<div class="text-xs font-semibold text-white truncate">' +
          item.flag_emoji +
          ' ' +
          item.name +
          '</div>' +
          '<div class="text-[11px] text-slate-400 truncate">' +
          (item.subText || '') +
          '</div>' +
          '</div>' +
          rightControls +
          '</div>'
        );
      })
      .join('');
  }

  renderStatisticsPage() {
    const pctEl = document.getElementById('stats-world-pct');
    const subEl = document.getElementById('stats-world-sub');
    const donutsEl = document.getElementById('stats-donuts-grid');
    const detailEl = document.getElementById('stats-circle-detail');
    const geoEl = document.getElementById('stats-geo-extremes');
    if (!donutsEl) return;

    const visCountries = this.places.filter((p) => p.category === 'country' && p.status === 'visited');
    const totCountries = this.countByCat('country') || 195;
    const visContinents = new Set(visCountries.map((c) => c.continent).filter(Boolean)).size;
    const visCities = this.places.filter((p) => p.category === 'city' && p.status === 'visited');
    const visUSStates = this.countByCat('us_state', 'visited');
    const totUSStates = this.countByCat('us_state') || 51;
    const visIndiaStates = this.countByCat('indian_state', 'visited');
    const totIndiaStates = this.countByCat('indian_state') || 36;
    const visNP = this.countByCat('national_park', 'visited');
    const totNP = this.countByCat('national_park') || 1;
    const top25Airports = this.getTop25Airports();
    const visTop25Airports = top25Airports.filter((x) => x.place.status === 'visited').length;
    const visLeafTotal = this.places.filter(
      (p) => !this.isParentCategory(p.category) && p.status === 'visited'
    ).length;

    const worldPct = ((visCountries.length / totCountries) * 100).toFixed(2);
    if (pctEl) pctEl.textContent = worldPct + '%';
    if (subEl) {
      subEl.textContent =
        visCountries.length +
        ' of ' +
        totCountries +
        ' Countries · ' +
        visContinents +
        ' of 7 Continents · ' +
        visLeafTotal +
        ' Total Places Visited';
    }

    const makeDonut = (key, label, vis, tot, colorHex) => {
      const pct = tot > 0 ? Math.min(100, Math.round((vis / tot) * 100)) : 100;
      const r = 30;
      const circ = 2 * Math.PI * r;
      const dash = (pct / 100) * circ;
      const isSelected = this.activeStatsCircle === key;
      const borderCls = isSelected
        ? 'border-emerald-400 bg-emerald-500/10 ring-1 ring-emerald-400/50'
        : 'border-white/10 bg-slate-900/75 hover:border-white/25';
      return (
        '<button type="button" onclick="app.selectStatsCircle(\'' +
        key +
        '\')" class="p-3 rounded-2xl border transition flex flex-col items-center text-center cursor-pointer ' +
        borderCls +
        '">' +
        '<div class="text-[11px] font-semibold text-slate-200 truncate w-full mb-1.5">' +
        label +
        '</div>' +
        '<div class="relative w-20 h-20 flex items-center justify-center">' +
        '<svg class="w-20 h-20 -rotate-90" viewBox="0 0 76 76">' +
        '<circle cx="38" cy="38" r="' +
        r +
        '" fill="none" stroke="#1e293b" stroke-width="8"></circle>' +
        '<circle cx="38" cy="38" r="' +
        r +
        '" fill="none" stroke="' +
        colorHex +
        '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' +
        dash.toFixed(1) +
        ' ' +
        circ.toFixed(1) +
        '"></circle>' +
        '</svg>' +
        '<div class="absolute inset-0 flex flex-col items-center justify-center">' +
        '<span class="text-xs font-extrabold text-white">' +
        vis +
        '/' +
        tot +
        '</span>' +
        '<span class="text-[9px] text-slate-400">' +
        pct +
        '%</span>' +
        '</div>' +
        '</div>' +
        '</button>'
      );
    };

    donutsEl.innerHTML = [
      makeDonut('continents', 'Continents', visContinents, 7, '#f59e0b'),
      makeDonut('countries', 'Countries', visCountries.length, totCountries, this.visitedColor),
      makeDonut('us_states', 'US States', visUSStates, totUSStates, '#38bdf8'),
      makeDonut('indian_states', 'Indian States', visIndiaStates, totIndiaStates, '#a855f7'),
      makeDonut('national_parks', 'National Parks', visNP, totNP, '#10b981'),
      makeDonut('top25_airports', 'Top 25 Airports', visTop25Airports, 25, '#06b6d4'),
    ].join('');

    if (detailEl) {
      if (!this.activeStatsCircle) {
        detailEl.classList.add('hidden');
        detailEl.innerHTML = '';
      } else {
        detailEl.classList.remove('hidden');
        const titles = {
          continents: '🌍 Continents (7)',
          countries: '🌍 Countries (195)',
          us_states: '🇺🇸 US States (51)',
          indian_states: '🇮🇳 Indian States & UTs (36)',
          national_parks: '🌲 National Parks (' + totNP + ')',
          top25_airports: '✈️ World Top 25 Airports (by Passenger Traffic)',
        };
        const allItems = this.getStatsCircleItems(this.activeStatsCircle);
        const cntVisited = allItems.filter((i) => i.status === 'visited').length;
        const cntWant = allItems.filter((i) => i.status === 'bucket_list').length;
        const cntUnvisited = allItems.filter((i) => i.status === 'unvisited').length;
        const stF = this.statsCircleStatusFilter || 'all';

        const pillBtn = (key, text, activeBg) => {
          const active = stF === key;
          return (
            '<button type="button" onclick="app.setStatsCircleStatusFilter(\'' +
            key +
            '\')" class="px-2.5 py-1.5 sm:py-1 rounded-lg text-[11px] font-semibold text-center truncate transition ' +
            (active
              ? activeBg + ' text-slate-950'
              : 'bg-slate-900 text-slate-300 border border-white/10 hover:bg-slate-800') +
            '">' +
            text +
            '</button>'
          );
        };

        detailEl.innerHTML =
          '<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">' +
          '<div class="flex items-center justify-between gap-2">' +
          '<span class="text-xs sm:text-sm font-bold text-white truncate">' +
          (titles[this.activeStatsCircle] || 'List') +
          '</span>' +
          '<button type="button" onclick="app.selectStatsCircle(\'' +
          this.activeStatsCircle +
          '\')" class="sm:hidden text-xs text-slate-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 shrink-0">Close ✕</button>' +
          '</div>' +
          '<div class="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-1.5 w-full sm:w-auto">' +
          pillBtn('all', 'All (' + allItems.length + ')', 'bg-sky-400') +
          pillBtn('visited', '✓ Visited (' + cntVisited + ')', 'bg-emerald-400') +
          pillBtn('bucket_list', '🎯 Want (' + cntWant + ')', 'bg-amber-400') +
          pillBtn('unvisited', 'Not Visited (' + cntUnvisited + ')', 'bg-slate-300') +
          '</div>' +
          '</div>' +
          '<input id="stats-circle-search-input" oninput="app.onStatsCircleSearch(this.value)" value="' +
          (this.statsCircleSearch || '').replace(/"/g, '&quot;') +
          '" type="text" placeholder="Filter this list..." class="w-full h-8 bg-slate-950 text-white border border-white/15 rounded-xl px-3 text-xs focus:outline-none focus:border-emerald-500" />' +
          '<div id="stats-circle-items-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-[380px] overflow-y-auto pr-0.5"></div>';

        this.renderStatsCircleDetailListOnly();
      }
    }

    // Geographical & City Extremes (<>most cities & countries)
    if (geoEl) {
      const fmtLat = (lat) =>
        lat === undefined ? '—' : Math.abs(lat).toFixed(2) + '° ' + (lat >= 0 ? 'N' : 'S');
      const fmtLng = (lng) =>
        lng === undefined ? '—' : Math.abs(lng).toFixed(2) + '° ' + (lng >= 0 ? 'E' : 'W');
      const fmtPop = (pop) => {
        if (!pop || pop <= 0) return '';
        if (pop >= 1000000) return (pop / 1000000).toFixed(2) + 'M';
        if (pop >= 1000) return Math.round(pop / 1000).toLocaleString() + 'K';
        return pop.toLocaleString();
      };
      const haversineKm = (a, b) => {
        const toRad = (deg) => (deg * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lng - a.lng);
        const s =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(a.lat)) *
            Math.cos(toRad(b.lat)) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
        return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
      };
      const fmtCity = (c, extra) =>
        c ? (c.flag_emoji || '📍') + ' ' + c.name + (extra ? ' (' + extra + ')' : '') : '—';

      const citiesWithCoords = visCities.filter(
        (c) => typeof c.lat === 'number' && typeof c.lng === 'number'
      );
      const northCity = citiesWithCoords.slice().sort((a, b) => b.lat - a.lat)[0];
      const southCity = citiesWithCoords.slice().sort((a, b) => a.lat - b.lat)[0];
      const eastCity = citiesWithCoords.slice().sort((a, b) => b.lng - a.lng)[0];
      const westCity = citiesWithCoords.slice().sort((a, b) => a.lng - b.lng)[0];

      // Closest to Equator (0° lat), Prime Meridian (0° lng), and International Date Line (±180° lng)
      const equatorCity = citiesWithCoords
        .slice()
        .sort((a, b) => Math.abs(a.lat) - Math.abs(b.lat))[0];
      const primeMeridianCity = citiesWithCoords
        .slice()
        .sort((a, b) => Math.abs(a.lng) - Math.abs(b.lng))[0];
      const dateLineCity = citiesWithCoords
        .slice()
        .sort((a, b) => 180 - Math.abs(a.lng) - (180 - Math.abs(b.lng)))[0];

      // Most populous & Least populous visited city
      const citiesWithPop = visCities.filter((c) => typeof c.population === 'number' && c.population > 0);
      const mostPopCity = citiesWithPop.slice().sort((a, b) => b.population - a.population)[0];
      const leastPopCity = citiesWithPop.slice().sort((a, b) => a.population - b.population)[0];

      // Pairwise distance extreme: Farthest pair of visited cities
      let farthestPair = null;
      let maxDistKm = -1;

      if (citiesWithCoords.length >= 2) {
        const pool = citiesWithCoords.slice(0, 350);
        for (let i = 0; i < pool.length; i++) {
          for (let j = i + 1; j < pool.length; j++) {
            const dKm = haversineKm(pool[i], pool[j]);
            if (dKm > maxDistKm) {
              maxDistKm = dKm;
              farthestPair = [pool[i], pool[j]];
            }
          }
        }
      }

      const row = (icon, label, val) =>
        '<div class="py-2 flex flex-wrap sm:flex-nowrap items-center justify-between gap-x-3 gap-y-0.5">' +
        '<span class="text-slate-300 flex items-center gap-2 shrink-0"><span class="text-amber-400 font-bold w-5 text-center">' +
        icon +
        '</span>' +
        label +
        '</span>' +
        '<span class="font-semibold text-white text-right ml-auto break-words">' +
        (val || '—') +
        '</span>' +
        '</div>';

      geoEl.innerHTML = [
        row('⬆️', 'Northernmost city', fmtCity(northCity, northCity ? fmtLat(northCity.lat) : '')),
        row('➡️', 'Easternmost city', fmtCity(eastCity, eastCity ? fmtLng(eastCity.lng) : '')),
        row('⬇️', 'Southernmost city', fmtCity(southCity, southCity ? fmtLat(southCity.lat) : '')),
        row('⬅️', 'Westernmost city', fmtCity(westCity, westCity ? fmtLng(westCity.lng) : '')),
        row('🏙️', 'Most populous city', fmtCity(mostPopCity, mostPopCity ? fmtPop(mostPopCity.population) : '')),
        row('🏘️', 'Least populous city', fmtCity(leastPopCity, leastPopCity ? fmtPop(leastPopCity.population) : '')),
        row('☀️', 'Equatorialmost city', fmtCity(equatorCity, equatorCity ? fmtLat(equatorCity.lat) : '')),
        row('🕰️', 'Prime Meridianmost city', fmtCity(primeMeridianCity, primeMeridianCity ? fmtLng(primeMeridianCity.lng) : '')),
        row('🌏', 'Date Linemost city', fmtCity(dateLineCity, dateLineCity ? fmtLng(dateLineCity.lng) : '')),
        row(
          '✈️',
          'Farthest visited cities',
          farthestPair
            ? farthestPair[0].name +
              ' ↔ ' +
              farthestPair[1].name +
              ' (' +
              Math.round(maxDistKm).toLocaleString() +
              ' km)'
            : '—'
        ),
      ].join('');
    }
  }

  resolveIndianStateFeature(feat) {
    const props = (feat && feat.properties) || {};
    const raw = String(
      props.st_nm || props.NAME_1 || props.name || props.ST_NM || props.state || ''
    )
      .trim()
      .toLowerCase();
    if (!raw) return null;
    const normMap = {
      'nct of delhi': 'delhi',
      'national capital territory of delhi': 'delhi',
      orissa: 'odisha',
      uttaranchal: 'uttarakhand',
      pondicherry: 'puducherry',
      'jammu & kashmir': 'jammu and kashmir',
      'andaman & nicobar islands': 'andaman and nicobar islands',
      'andaman & nicobar': 'andaman and nicobar islands',
      'dadra and nagar haveli': 'dadra and nagar haveli and daman and diu',
      'daman and diu': 'dadra and nagar haveli and daman and diu',
      'dadara & nagar havelli': 'dadra and nagar haveli and daman and diu',
    };
    const target = normMap[raw] || raw;
    return (
      this.places.find(
        (p) => p.category === 'indian_state' && p.name.toLowerCase() === target
      ) || null
    );
  }

  resolveCanadianProvinceFeature(feat) {
    const props = (feat && feat.properties) || {};
    const raw = String(props.name || props.NAME || '').trim().toLowerCase();
    if (!raw) return null;
    return (
      this.places.find(
        (p) => p.category === 'canadian_province' && p.name.toLowerCase() === raw
      ) || null
    );
  }

  renderDrilldownPins(g, projection, items) {
    const rank = { unvisited: 0, bucket_list: 1, visited: 2 };
    const sorted = items.slice().sort((a, b) => (rank[a.status] || 0) - (rank[b.status] || 0));
    const pinG = g.append('g').attr('class', 'drilldown-pins');

    pinG
      .selectAll('circle')
      .data(sorted)
      .join('circle')
      .attr('class', 'reg-pin')
      .attr('cx', (d) => (projection([d.lng, d.lat]) || [-999, -999])[0])
      .attr('cy', (d) => (projection([d.lng, d.lat]) || [-999, -999])[1])
      .attr('r', (d) => (d.status === 'visited' ? 5.5 : d.status === 'bucket_list' ? 5.0 : 3.8))
      .attr('fill', (d) =>
        d.status === 'visited'
          ? this.visitedColor
          : d.status === 'bucket_list'
            ? this.dreamColor
            : '#38bdf8'
      )
      .attr('stroke', '#0b0f19')
      .attr('stroke-width', 1.2)
      .on('mousemove', (evt, d) => {
        this.showTooltip(
          'us-tooltip',
          'regional-map-wrap',
          evt,
          '<div class="font-bold text-white">' +
          (d.flag_emoji || '📍') +
          ' ' +
          d.name +
          '</div>' +
          '<div class="text-slate-400 text-[11px]">' +
          (d.description || d.category) +
          '</div>'
        );
      })
      .on('mouseleave', () => this.hideTooltip('us-tooltip'));
  }

  drawUSVectorMap(resetZoom) {
    const svgEl = document.getElementById('us-svg');
    if (!svgEl || typeof d3 === 'undefined') return;
    const rect = svgEl.getBoundingClientRect();
    const W = rect.width || 800;
    const H = rect.height || 460;
    const mode = this.regionalMode || 'world';

    const pillEl = document.getElementById('us-progress-pill');
    if (pillEl) {
      if (mode === 'world') {
        const vis = this.countByCat('country', 'visited');
        const tot = this.countByCat('country') || 195;
        pillEl.textContent = vis + ' / ' + tot + ' Visited';
      } else if (mode === 'state_focus' && this.focusedState) {
        const st = this.focusedState.place;
        const allInState = this.filterRegionalPlaces(
          this.places.filter((p) => p.state_code === st.state_code && p.id !== st.id)
        );
        const visInState = allInState.filter((p) => p.status === 'visited').length;
        pillEl.textContent = st.name + ': ' + visInState + ' / ' + allInState.length + ' Visited';
      } else if (mode === 'country_focus' && this.focusedCountry) {
        const co = this.focusedCountry.place;
        if (co.country_code === 'CA' && (!this.regionalLayerFilter || this.regionalLayerFilter === 'none')) {
          const vis = this.countByCat('canadian_province', 'visited');
          const tot = this.countByCat('canadian_province') || 13;
          pillEl.textContent = vis + ' / ' + tot + ' Visited';
        } else {
          const allInCo = this.filterRegionalPlaces(
            this.places.filter((p) => p.country_code === co.country_code && p.id !== co.id)
          );
          const visInCo = allInCo.filter((p) => p.status === 'visited').length;
          pillEl.textContent = co.name + ': ' + visInCo + ' / ' + allInCo.length + ' Visited';
        }
      } else if (mode === 'india_states') {
        const vis = this.countByCat('indian_state', 'visited');
        const tot = this.countByCat('indian_state') || 36;
        pillEl.textContent = vis + ' / ' + tot + ' Visited';
      } else {
        const vis = this.countByCat('us_state', 'visited');
        const tot = this.countByCat('us_state') || 51;
        pillEl.textContent = vis + ' / ' + tot + ' Visited';
      }
    }

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    const g = svg.append('g').attr('class', 'regional-root');

    if (mode === 'world') {
      if (!this.worldTopo || typeof topojson === 'undefined') return;
      const countriesGeo = topojson.feature(this.worldTopo, this.worldTopo.objects.countries);
      const mainContinentsGeo = {
        type: 'FeatureCollection',
        features: countriesGeo.features.filter(
          (f) => ((f.properties && f.properties.name) || '') !== 'Antarctica'
        ),
      };
      const projection = d3.geoMercator().fitSize([W, H], mainContinentsGeo);
      const pathGen = d3.geoPath().projection(projection);

      g.append('path')
        .datum(d3.geoGraticule10())
        .attr('d', pathGen)
        .attr('fill', 'none')
        .attr('stroke', 'rgba(148,163,184,0.06)')
        .attr('stroke-width', 0.6);

      const countryPaths = g
        .append('g')
        .selectAll('path')
        .data(countriesGeo.features)
        .join('path')
        .attr('class', 'country-path')
        .attr('d', pathGen)
        .attr('fill', (feat) => {
          const c = this.resolveCountryFeature(feat);
          if (!c) return '#152033';
          if (c.status === 'visited') return this.visitedColor;
          if (c.status === 'bucket_list') return this.dreamColor;
          return '#162235';
        })
        .attr('stroke', (feat) => {
          const c = this.resolveCountryFeature(feat);
          if (c && c.status === 'visited') return '#e2e8f0';
          if (c && c.status === 'bucket_list') return '#fde68a';
          return '#293b56';
        })
        .attr('stroke-width', (feat) => {
          const c = this.resolveCountryFeature(feat);
          return c && c.status !== 'unvisited' ? 1.0 : 0.65;
        })
        .on('mousemove', (evt, feat) => {
          const c = this.resolveCountryFeature(feat);
          const rawName = (feat.properties && feat.properties.name) || 'Unknown';
          if (c) {
            const stBadge =
              c.status === 'visited'
                ? '<span class="text-emerald-400 font-semibold">✓ Visited</span>'
                : c.status === 'bucket_list'
                  ? '<span class="text-amber-400 font-semibold">🎯 Dream</span>'
                  : '<span class="text-slate-400">Unvisited</span>';
            this.showTooltip(
              'us-tooltip',
              'regional-map-wrap',
              evt,
              '<div class="font-bold text-white">' +
              c.flag_emoji +
              ' ' +
              c.name +
              '</div>' +
              '<div class="text-slate-400 text-[11px]">' +
              (c.continent || '') +
              '</div>' +
              '<div class="mt-1">' +
              stBadge +
              ' · <span class="text-sky-400">Long-press for country map</span></div>'
            );
          } else {
            this.showTooltip(
              'us-tooltip',
              'regional-map-wrap',
              evt,
              '<div class="font-bold text-white">🌍 ' + rawName + '</div>'
            );
          }
        })
        .on('mouseleave', () => this.hideTooltip('us-tooltip'));

      this.bindLongPress(countryPaths, (evt, feat) => {
        const c = this.resolveCountryFeature(feat);
        if (c) this.drillDownCountry(c, feat);
      });
    } else if (mode === 'state_focus' && this.focusedState && this.focusedState.feature) {
      const st = this.focusedState.place;
      const feat = this.focusedState.feature;
      const projection = d3.geoMercator().fitExtent([[32, 32], [W - 32, H - 32]], feat);
      const pathGen = d3.geoPath().projection(projection);

      g.append('path')
        .datum(feat)
        .attr('class', 'state-path')
        .attr('d', pathGen)
        .attr('fill', () => {
          if (st.status === 'visited') return this.visitedColor;
          if (st.status === 'bucket_list') return this.dreamColor;
          return '#162235';
        })
        .attr('fill-opacity', st.status !== 'unvisited' ? 0.35 : 0.85)
        .attr('stroke', st.status === 'visited' ? this.visitedColor : st.status === 'bucket_list' ? this.dreamColor : '#38bdf8')
        .attr('stroke-width', 2.0);

      const statePlaces = this.filterRegionalPlaces(
        this.places.filter((p) => p.state_code === st.state_code && p.id !== st.id)
      );
      this.renderDrilldownPins(g, projection, statePlaces);
    } else if (mode === 'country_focus' && this.focusedCountry) {
      const co = this.focusedCountry.place;
      const feat = this.focusedCountry.feature;
      let projection;
      if (co.country_code === 'CA' && this.canadaGeo && this.canadaGeo.features) {
        projection = d3.geoMercator().fitExtent([[24, 24], [W - 24, H - 24]], this.canadaGeo);
        const pathGen = d3.geoPath().projection(projection);
        const caPaths = g
          .append('g')
          .selectAll('path')
          .data(this.canadaGeo.features)
          .join('path')
          .attr('class', 'state-path')
          .attr('d', pathGen)
          .attr('fill', (f) => {
            const pr = this.resolveCanadianProvinceFeature(f);
            if (!pr) return '#162235';
            if (pr.status === 'visited') return this.visitedColor;
            if (pr.status === 'bucket_list') return this.dreamColor;
            return '#162235';
          })
          .attr('stroke', '#2d405e')
          .attr('stroke-width', 1.0)
          .on('mousemove', (evt, f) => {
            const pr = this.resolveCanadianProvinceFeature(f);
            if (!pr) return;
            this.showTooltip(
              'us-tooltip',
              'regional-map-wrap',
              evt,
              '<div class="font-bold text-white">🇨🇦 ' +
              pr.name +
              ' (' +
              pr.state_code +
              ')</div>' +
              '<div class="text-sky-400 text-[11px] mt-0.5">Long-press for province map</div>'
            );
          })
          .on('mouseleave', () => this.hideTooltip('us-tooltip'));

        this.bindLongPress(caPaths, (evt, f) => {
          const pr = this.resolveCanadianProvinceFeature(f);
          if (pr) this.drillDownState(pr, f);
        });
      } else if (feat) {
        projection = d3.geoMercator().fitExtent([[28, 28], [W - 28, H - 28]], feat);
        const pathGen = d3.geoPath().projection(projection);
        g.append('path')
          .datum(feat)
          .attr('class', 'state-path')
          .attr('d', pathGen)
          .attr('fill', co.status === 'visited' ? this.visitedColor : co.status === 'bucket_list' ? this.dreamColor : '#162235')
          .attr('fill-opacity', co.status !== 'unvisited' ? 0.35 : 0.85)
          .attr('stroke', co.status === 'visited' ? this.visitedColor : co.status === 'bucket_list' ? this.dreamColor : '#38bdf8')
          .attr('stroke-width', 1.8);
      } else {
        projection = d3
          .geoMercator()
          .center([co.lng || 0, co.lat || 0])
          .scale(Math.min(W, H) * 2.2)
          .translate([W / 2, H / 2]);
      }

      const coPlaces = this.filterRegionalPlaces(
        this.places.filter(
          (p) =>
            p.country_code === co.country_code &&
            p.id !== co.id &&
            p.category !== 'canadian_province'
        )
      );
      this.renderDrilldownPins(g, projection, coPlaces);
    } else if (mode === 'india_states') {
      const indiaStates = this.places.filter((p) => p.category === 'indian_state');
      let projection;
      if (this.indiaGeo && this.indiaGeo.features && this.indiaGeo.features.length) {
        projection = d3.geoMercator().fitExtent([[20, 20], [W - 20, H - 20]], this.indiaGeo);
        const pathGen = d3.geoPath().projection(projection);
        const inPaths = g
          .append('g')
          .selectAll('path')
          .data(this.indiaGeo.features)
          .join('path')
          .attr('class', 'state-path')
          .attr('d', pathGen)
          .attr('fill', (feat) => {
            const st = this.resolveIndianStateFeature(feat);
            if (!st) return '#162235';
            if (st.status === 'visited') return this.visitedColor;
            if (st.status === 'bucket_list') return this.dreamColor;
            return '#162235';
          })
          .attr('stroke', (feat) => {
            const st = this.resolveIndianStateFeature(feat);
            if (st && st.status === 'visited') return '#e2e8f0';
            if (st && st.status === 'bucket_list') return '#fde68a';
            return '#2d405e';
          })
          .attr('stroke-width', 0.9)
          .on('mousemove', (evt, feat) => {
            const st = this.resolveIndianStateFeature(feat);
            if (!st) return;
            this.showTooltip(
              'us-tooltip',
              'regional-map-wrap',
              evt,
              '<div class="font-bold text-white">🇮🇳 ' +
              st.name +
              ' (' +
              st.state_code +
              ')</div>' +
              '<div class="text-slate-400 text-[11px]">' +
              (st.description || '') +
              '</div>' +
              '<div class="text-sky-400 text-[11px] mt-0.5">Long-press for state map</div>'
            );
          })
          .on('mouseleave', () => this.hideTooltip('us-tooltip'));

        this.bindLongPress(inPaths, (evt, feat) => {
          const st = this.resolveIndianStateFeature(feat);
          if (st) this.drillDownState(st, feat);
        });
      } else {
        projection = d3
          .geoMercator()
          .center([82.5, 22.5])
          .scale(Math.min(W, H) * 1.65)
          .translate([W / 2, H / 2]);
      }

      const pinG = g.append('g').attr('class', 'india-pins');
      pinG
        .selectAll('circle')
        .data(indiaStates)
        .join('circle')
        .attr('class', 'reg-pin')
        .attr('cx', (d) => (projection([d.lng, d.lat]) || [-999, -999])[0])
        .attr('cy', (d) => (projection([d.lng, d.lat]) || [-999, -999])[1])
        .attr('r', (d) => (d.status !== 'unvisited' ? 4.2 : 3.0))
        .attr('fill', (d) =>
          d.status === 'visited'
            ? this.visitedColor
            : d.status === 'bucket_list'
              ? this.dreamColor
              : '#64748b'
        )
        .attr('stroke', '#0b0f19')
        .attr('stroke-width', 1.0)
        .on('mousemove', (evt, d) => {
          this.showTooltip(
            'us-tooltip',
            'regional-map-wrap',
            evt,
            '<div class="font-bold text-white">🇮🇳 ' +
            d.name +
            ' (' +
            d.state_code +
            ')</div>' +
            '<div class="text-slate-400 text-[11px]">' +
            (d.description || '') +
            '</div>'
          );
        })
        .on('mouseleave', () => this.hideTooltip('us-tooltip'));

      pinG
        .selectAll('text')
        .data(indiaStates)
        .join('text')
        .attr('class', 'reg-label')
        .attr('x', (d) => (projection([d.lng, d.lat]) || [-999, -999])[0])
        .attr('y', (d) => (projection([d.lng, d.lat]) || [-999, -999])[1] - 5.5)
        .attr('text-anchor', 'middle')
        .attr('fill', (d) => (d.status !== 'unvisited' ? '#ffffff' : '#cbd5e1'))
        .attr('font-size', '8px')
        .attr('font-weight', '700')
        .attr('pointer-events', 'none')
        .text((d) => (d.state_code || '').replace('IN-', ''));

      if (this.regionalLayerFilter && this.regionalLayerFilter !== 'none') {
        const indiaPlaces = this.filterRegionalPlaces(
          this.places.filter((p) => p.country_code === 'IN')
        );
        this.renderDrilldownPins(g, projection, indiaPlaces);
      }
    } else {
      if (!this.usTopo || typeof topojson === 'undefined') return;
      const statesGeo = topojson.feature(this.usTopo, this.usTopo.objects.states);
      const projection = d3.geoAlbersUsa().fitExtent([[16, 16], [W - 16, H - 16]], statesGeo);
      const pathGen = d3.geoPath().projection(projection);

      const stateByName = {};
      this.places
        .filter((p) => p.category === 'us_state')
        .forEach((s) => {
          stateByName[s.name.toLowerCase()] = s;
        });

      const usStatePaths = g
        .append('g')
        .selectAll('path')
        .data(statesGeo.features)
        .join('path')
        .attr('class', 'state-path')
        .attr('d', pathGen)
        .attr('fill', (feat) => {
          const nm = ((feat.properties && feat.properties.name) || '').toLowerCase();
          const st = stateByName[nm];
          if (!st) return '#162235';
          if (st.status === 'visited') return this.visitedColor;
          if (st.status === 'bucket_list') return this.dreamColor;
          return '#162235';
        })
        .attr('stroke', (feat) => {
          const nm = ((feat.properties && feat.properties.name) || '').toLowerCase();
          const st = stateByName[nm];
          if (st && st.status === 'visited') return '#e2e8f0';
          if (st && st.status === 'bucket_list') return '#fde68a';
          return '#2d405e';
        })
        .attr('stroke-width', 1.0)
        .on('mousemove', (evt, feat) => {
          const nm = ((feat.properties && feat.properties.name) || '').toLowerCase();
          const st = stateByName[nm];
          if (!st) return;
          this.showTooltip(
            'us-tooltip',
            'regional-map-wrap',
            evt,
            '<div class="font-bold text-white">🇺🇸 ' +
            st.name +
            ' (' +
            st.state_code +
            ')</div>' +
            '<div class="text-slate-400 text-[11px]">' +
            (st.description || '') +
            '</div>' +
            '<div class="text-sky-400 text-[11px] mt-0.5">Long-press for state map</div>'
          );
        })
        .on('mouseleave', () => this.hideTooltip('us-tooltip'));

      this.bindLongPress(usStatePaths, (evt, feat) => {
        const nm = ((feat.properties && feat.properties.name) || '').toLowerCase();
        const st = stateByName[nm];
        if (st) this.drillDownState(st, feat);
      });

      g.append('g')
        .selectAll('text')
        .data(statesGeo.features)
        .join('text')
        .attr('class', 'reg-label')
        .attr('transform', (feat) => {
          const c = pathGen.centroid(feat);
          return c && !isNaN(c[0]) && !isNaN(c[1])
            ? 'translate(' + c[0] + ',' + c[1] + ')'
            : 'translate(-999,-999)';
        })
        .attr('text-anchor', 'middle')
        .attr('dy', '0.35em')
        .attr('fill', (feat) => {
          const nm = ((feat.properties && feat.properties.name) || '').toLowerCase();
          const st = stateByName[nm];
          return st && st.status !== 'unvisited' ? '#062016' : '#94a3b8';
        })
        .attr('font-size', '9px')
        .attr('font-weight', '700')
        .attr('pointer-events', 'none')
        .text((feat) => {
          const nm = ((feat.properties && feat.properties.name) || '').toLowerCase();
          const st = stateByName[nm];
          return st ? st.state_code : '';
        });

      if (this.regionalLayerFilter && this.regionalLayerFilter !== 'none') {
        const usPlaces = this.filterRegionalPlaces(
          this.places.filter((p) => p.country_code === 'US')
        );
        this.renderDrilldownPins(g, projection, usPlaces);
      }
    }

    this.regionalZoomBehavior = d3
      .zoom()
      .scaleExtent([1, 120])
      .extent([[0, 0], [W, H]])
      .translateExtent([
        [-20, -20],
        [W + 20, H + 20],
      ])
      .on('zoom', (event) => {
        this.currentRegionalZoom = event.transform;
        g.attr('transform', event.transform);
        const k = event.transform.k || 1;
        const boost = Math.min(1.5, Math.pow(k, 0.12));
        g.selectAll('.reg-pin')
          .attr(
            'r',
            (d) =>
              ((d.status === 'visited' ? 5.5 : d.status === 'bucket_list' ? 5.0 : 3.8) * boost) /
              k
          )
          .attr('stroke-width', 1.1 / k);
        g.selectAll('.reg-label').attr('font-size', (9 * boost) / k + 'px');
      });

    svg.call(this.regionalZoomBehavior);
    if (this.currentRegionalZoom && !resetZoom) {
      svg.call(this.regionalZoomBehavior.transform, this.currentRegionalZoom);
    } else {
      this.currentRegionalZoom = d3.zoomIdentity;
    }
  }

  async askGemini(e) {
    if (e) e.preventDefault();
    const inputEl = document.getElementById('gemini-input');
    const btnEl = document.getElementById('gemini-btn');
    const replyEl = document.getElementById('gemini-reply');
    const prompt = (inputEl.value || '').trim();
    if (!prompt && !this.pendingImageBase64) return;

    btnEl.disabled = true;
    btnEl.textContent = 'Thinking...';
    replyEl.classList.remove('hidden');
    replyEl.textContent = this.pendingImageBase64
      ? '✨ Gemini Vision (gemini-3.8-flash) is scanning your ticket screenshot...'
      : '✨ Gemini (gemini-3.8-flash) is updating your travel map...';

    try {
      const payload = { prompt };
      if (this.pendingImageBase64) {
        payload.image_base64 = this.pendingImageBase64;
        payload.image_mime_type = this.pendingImageMime || 'image/jpeg';
      }
      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) {
        replyEl.textContent = '⚠️ ' + data.error;
      } else {
        replyEl.textContent = '✨ ' + (data.reply || 'Updated your map!');
        inputEl.value = '';
        this.clearAttachment();
        await this.bootstrapState();
      }
    } catch (err) {
      replyEl.textContent = '⚠️ Error contacting /api/gemini: ' + err.message;
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = 'Ask';
    }
  }

  openCsvModal() {
    this.openSection('csv');
  }

  setCsvImportMode(mode) {
    this.csvImportMode = mode === 'override' ? 'override' : 'append';
    const appBtn = document.getElementById('csv-mode-append');
    const ovrBtn = document.getElementById('csv-mode-override');
    if (appBtn) {
      appBtn.className =
        this.csvImportMode === 'append'
          ? 'p-2.5 rounded-xl border border-emerald-400 bg-emerald-500/15 text-emerald-300 text-xs font-bold flex flex-col items-start gap-0.5 text-left transition'
          : 'p-2.5 rounded-xl border border-white/10 bg-slate-900/80 text-slate-300 hover:border-white/25 text-xs font-bold flex flex-col items-start gap-0.5 text-left transition';
    }
    if (ovrBtn) {
      ovrBtn.className =
        this.csvImportMode === 'override'
          ? 'p-2.5 rounded-xl border border-rose-400 bg-rose-500/15 text-rose-300 text-xs font-bold flex flex-col items-start gap-0.5 text-left transition'
          : 'p-2.5 rounded-xl border border-white/10 bg-slate-900/80 text-slate-300 hover:border-white/25 text-xs font-bold flex flex-col items-start gap-0.5 text-left transition';
    }
  }

  renderCsvPage() {
    this.setCsvImportMode(this.csvImportMode || 'append');
    this.renderRecentUpdatesList();
  }

  renderGeminiPage() {
    this.renderRecentUpdatesList();
    if (this.lastGeminiLoggedItems) {
      this.renderGeminiBatchResults();
    }
  }

  triggerCsvExport() {
    const tracked = this.places.filter(
      (p) =>
        !this.isParentCategory(p.category) &&
        (p.status === 'visited' || p.status === 'bucket_list')
    );
    const cats = [
      { key: 'city', icon: '🏙️', label: 'Cities' },
      { key: 'national_park', icon: '🌲', label: 'National Parks' },
      { key: 'unesco', icon: '🏛️', label: 'UNESCO Sites' },
      { key: 'world_wonder', icon: '✨', label: 'World Wonders & Landmarks' },
      { key: 'airport', icon: '✈️', label: 'Airports' },
    ];

    const totalBeen = tracked.filter((p) => p.status === 'visited').length;
    const totalWant = tracked.filter((p) => p.status === 'bucket_list').length;

    const rowsHtml = cats
      .map((c) => {
        const inCat = tracked.filter((p) => p.category === c.key);
        const been = inCat.filter((p) => p.status === 'visited').length;
        const want = inCat.filter((p) => p.status === 'bucket_list').length;
        return (
          '<div class="py-1.5 flex items-center justify-between gap-2 border-b border-white/5 last:border-0">' +
          '<span class="text-slate-200 font-medium">' +
          c.icon +
          ' ' +
          c.label +
          '</span>' +
          '<span class="text-slate-300 font-semibold">' +
          inCat.length +
          ' <span class="text-[11px] text-slate-400 font-normal">(' +
          been +
          ' been · ' +
          want +
          ' want)</span></span>' +
          '</div>'
        );
      })
      .join('');

    const statsBox = document.getElementById('csv-export-stats-box');
    if (statsBox) {
      statsBox.classList.remove('hidden');
      statsBox.innerHTML =
        '<div class="flex items-center justify-between gap-2 pb-1.5 border-b border-white/10">' +
        '<span class="font-bold text-sky-300">✅ Exported ' +
        tracked.length +
        ' Places to CSV</span>' +
        '<span class="text-[11px] text-slate-300"><span class="text-emerald-400 font-semibold">' +
        totalBeen +
        ' Been</span> · <span class="text-amber-400 font-semibold">' +
        totalWant +
        ' Want</span></span>' +
        '</div>' +
        '<div>' +
        rowsHtml +
        '</div>';
    }

    const exportHref = this.googleIdToken
      ? '/api/export.csv?id_token=' + encodeURIComponent(this.googleIdToken)
      : '/api/export.csv';
    const a = document.createElement('a');
    a.href = exportHref;
    a.download = 'places_tracker_export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async submitCsvFromPage() {
    const area = document.getElementById('csv-page-paste-area');
    const text = ((area && area.value) || '').trim();
    if (!text) {
      this.showMobileToast('Please choose a .csv file or paste CSV rows first');
      return;
    }
    await this.importCsvText(text);
  }

  async handleCsvFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    event.target.value = '';
    if (this.activeSection !== 'csv') {
      this.openSection('csv');
    }
    await this.importCsvText(text);
  }

  formatCategoryBreakdownHtml(byCatObj, itemsList) {
    const cats = [
      { key: 'city', icon: '🏙️', label: 'Cities' },
      { key: 'national_park', icon: '🌲', label: 'National Parks' },
      { key: 'unesco', icon: '🏛️', label: 'UNESCO Sites' },
      { key: 'world_wonder', icon: '✨', label: 'World Wonders & Landmarks' },
      { key: 'airport', icon: '✈️', label: 'Airports' },
    ];
    const bc = byCatObj || {};
    const catRows = cats
      .map((c) => {
        const count = bc[c.key] || 0;
        return (
          '<div class="py-1 flex items-center justify-between gap-2 border-b border-white/5 last:border-0">' +
          '<span class="text-slate-300">' +
          c.icon +
          ' ' +
          c.label +
          '</span>' +
          '<span class="font-bold text-white">' +
          count +
          '</span>' +
          '</div>'
        );
      })
      .join('');

    let listHtml = '';
    if (Array.isArray(itemsList) && itemsList.length > 0 && itemsList.length < 10) {
      listHtml =
        '<div class="pt-1.5 mt-1.5 border-t border-white/10 space-y-1">' +
        '<div class="text-[11px] font-semibold text-slate-400">Places (' +
        itemsList.length +
        '):</div>' +
        '<div class="flex flex-wrap gap-1.5">' +
        itemsList
          .map(
            (it) =>
              '<span class="px-2 py-0.5 rounded-lg bg-slate-900 border border-white/10 text-[11px] text-slate-200">' +
              (it.flag_emoji || '📍') +
              ' ' +
              it.name +
              '</span>'
          )
          .join('') +
        '</div>' +
        '</div>';
    }
    return '<div>' + catRows + '</div>' + listHtml;
  }

  async importCsvText(csvText) {
    const mode = this.csvImportMode === 'override' ? 'override' : 'append';
    const statsBox = document.getElementById('csv-import-stats-box');
    const btn = document.getElementById('csv-page-submit-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Importing...';
    }
    if (statsBox) {
      statsBox.classList.remove('hidden');
      statsBox.innerHTML =
        '<div class="text-slate-300">⬆️ Importing CSV (' +
        (mode === 'override' ? 'Override mode' : 'Append mode') +
        ')...</div>';
    }

    try {
      if (mode === 'override') {
        const cacheKey = this.getBackupKey();
        try {
          localStorage.removeItem(cacheKey);
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith(cacheKey + '_')) {
              localStorage.removeItem(k);
            }
          }
        } catch (_) { }
      }

      const res = await fetch('/api/import.csv?mode=' + encodeURIComponent(mode), {
        method: 'POST',
        headers: this.getHeaders({
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Import-Mode': mode,
        }),
        body: csvText,
      });
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (_) {
        throw new Error(
          'Server returned non-JSON response (HTTP ' +
            res.status +
            '). Please retry in a few seconds.'
        );
      }
      if (!res.ok || data.error) {
        throw new Error(data.error || 'HTTP ' + res.status);
      }
      await this.bootstrapState();

      const area = document.getElementById('csv-page-paste-area');
      if (area) area.value = '';

      if (statsBox) {
        let html = '';
        if (mode === 'override') {
          const delTot = data.deleted_total || 0;
          const addTot = data.added_total || 0;
          html +=
            '<div class="space-y-3">' +
            '<div class="p-2.5 rounded-xl bg-rose-950/30 border border-rose-500/30 space-y-1.5">' +
            '<div class="font-bold text-rose-300">🗑️ Override — Deleted ' +
            delTot +
            ' Existing Places</div>' +
            this.formatCategoryBreakdownHtml(data.deleted_by_category, data.deleted_items) +
            '</div>' +
            '<div class="p-2.5 rounded-xl bg-emerald-950/30 border border-emerald-500/30 space-y-1.5">' +
            '<div class="font-bold text-emerald-300">✅ Added ' +
            addTot +
            ' Places from CSV</div>' +
            this.formatCategoryBreakdownHtml(data.added_by_category, data.added_items) +
            '</div>' +
            '</div>';
        } else {
          const addTot = data.added_total || 0;
          html +=
            '<div class="p-2.5 rounded-xl bg-emerald-950/30 border border-emerald-500/30 space-y-1.5">' +
            '<div class="font-bold text-emerald-300">✅ Appended ' +
            addTot +
            ' New / Updated Places</div>' +
            this.formatCategoryBreakdownHtml(data.added_by_category, data.added_items) +
            '</div>';
        }
        statsBox.innerHTML = html;
      }
    } catch (err) {
      if (statsBox) {
        statsBox.innerHTML =
          '<div class="text-rose-400 font-semibold">⚠️ CSV Import failed: ' +
          err.message +
          '</div>';
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⬆️ Import CSV';
      }
    }
  }

  renderRecentUpdatesList() {
    const listEls = [
      document.getElementById('csv-recent-updates-list'),
      document.getElementById('gemini-recent-updates-list'),
    ].filter(Boolean);
    const countPills = [
      document.getElementById('csv-recent-count-pill'),
      document.getElementById('gemini-recent-count-pill'),
    ].filter(Boolean);
    if (listEls.length === 0) return;

    const log = (this.activityLog || []).slice(0, 25);
    countPills.forEach((pill) => {
      pill.textContent = log.length + ' / 25';
    });

    if (log.length === 0) {
      const emptyHtml =
        '<div class="p-5 text-center text-xs text-slate-400">No manual place updates recorded yet. Mark places as Been or Want in Home or Gemini Logger to see them here!</div>';
      listEls.forEach((el) => {
        el.innerHTML = emptyHtml;
      });
      return;
    }

    const catLabels = {
      city: 'City',
      national_park: 'National Park',
      unesco: 'UNESCO Site',
      world_wonder: 'World Wonder',
      airport: 'Airport',
    };

    const rowsHtml = log
      .map((item) => {
        const lbl = item.action_label || 'Updated';
        let shortLbl = lbl;
        let badgeCls = 'bg-slate-800 text-slate-300 border-slate-700';
        if (lbl === 'Added as Been') {
          shortLbl = '+ Been';
          badgeCls = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
        } else if (lbl === 'Added as Want') {
          shortLbl = '+ Want';
          badgeCls = 'bg-amber-500/20 text-amber-300 border-amber-500/40';
        } else if (lbl === 'Converted from Want to Been') {
          shortLbl = 'Want → Been';
          badgeCls = 'bg-sky-500/20 text-sky-300 border-sky-500/40';
        } else if (lbl === 'Converted from Been to Want') {
          shortLbl = 'Been → Want';
          badgeCls = 'bg-amber-500/20 text-amber-300 border-amber-500/40';
        } else if (lbl.startsWith('Removed')) {
          shortLbl = 'Removed';
          badgeCls = 'bg-rose-500/15 text-rose-300 border-rose-500/30';
        }

        let timeStr = '';
        if (item.timestamp) {
          try {
            const d = new Date(item.timestamp);
            if (!isNaN(d.getTime())) {
              timeStr = d.toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              });
            }
          } catch (_) { }
        }

        return (
          '<div class="px-3.5 py-2.5 flex items-center justify-between gap-2 hover:bg-white/[0.02]">' +
          '<div class="min-w-0">' +
          '<div class="text-xs font-semibold text-white truncate">' +
          (item.flag_emoji || '📍') +
          ' ' +
          (item.name || item.id) +
          '</div>' +
          '<div class="text-[11px] text-slate-400 truncate">' +
          (catLabels[item.category] || item.category || 'Place') +
          (timeStr ? ' · ' + timeStr : '') +
          '</div>' +
          '</div>' +
          '<span class="text-[10px] sm:text-[11px] font-semibold px-2 py-1 rounded-lg border shrink-0 ' +
          badgeCls +
          '">' +
          '<span class="sm:hidden">' +
          shortLbl +
          '</span><span class="hidden sm:inline">' +
          lbl +
          '</span>' +
          '</span>' +
          '</div>'
        );
      })
      .join('');

    listEls.forEach((el) => {
      el.innerHTML = rowsHtml;
    });
  }

  async askGeminiFromCsvPage() {
    const input = document.getElementById('csv-gemini-input');
    const btn = document.getElementById('csv-gemini-btn');
    const resultsBox = document.getElementById('csv-gemini-results-box');
    const prompt = ((input && input.value) || '').trim();
    if (!prompt) {
      alert('Please enter the places you visited (cities, national parks, landmarks, etc.).');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>Analyzing & Marking Places...</span>';
    }
    if (resultsBox) {
      resultsBox.classList.remove('hidden');
      resultsBox.innerHTML =
        '<div class="text-purple-300 font-semibold flex items-center gap-2"><span>✨</span><span>Gemini is extracting places and marking them as Been...</span></div>';
    }

    try {
      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: this.getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Gemini request failed');
      }

      this.lastGeminiReply = data.reply || '';
      this.lastGeminiLoggedItems = (data.updated || [])
        .filter((u) => u.changed !== false)
        .map((u) => ({
          ...u,
          removed: false,
        }));
      this.lastGeminiAlreadyMarkedCount = Number(data.already_marked_count || 0);
      this.lastGeminiUnresolved = data.unresolved || [];

      if (Array.isArray(data.activity_log)) {
        this.activityLog = data.activity_log;
      }

      await this.bootstrapState();
      this.renderGeminiBatchResults();
    } catch (e) {
      if (resultsBox) {
        resultsBox.classList.remove('hidden');
        resultsBox.innerHTML =
          '<div class="text-rose-400 font-semibold">⚠️ Failed to log places: ' +
          (e.message || 'Unknown error') +
          '</div>';
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>✨</span><span>Log Places with Gemini</span>';
      }
    }
  }

  renderGeminiBatchResults() {
    const resultsBox = document.getElementById('csv-gemini-results-box');
    if (!resultsBox) return;

    const items = this.lastGeminiLoggedItems || [];
    const alreadyCount = this.lastGeminiAlreadyMarkedCount || 0;
    const unresolved = this.lastGeminiUnresolved || [];
    const activeCount = items.filter((i) => !i.removed).length;

    const catLabels = {
      city: 'City',
      national_park: 'National Park',
      unesco: 'UNESCO Site',
      world_wonder: 'World Wonder / Landmark',
      airport: 'Airport',
    };

    let html =
      '<div class="flex items-center justify-between gap-2 border-b border-white/10 pb-2">' +
      '<div class="font-bold text-purple-300 flex items-center gap-1.5">✨ Gemini Place Logger Results</div>' +
      '<span class="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[11px] font-bold">' +
      activeCount +
      ' Newly Updated</span>' +
      '</div>';

    if (this.lastGeminiReply) {
      html +=
        '<div class="text-slate-300 text-xs leading-relaxed bg-slate-900/80 rounded-lg p-2.5 border border-white/5">' +
        this.lastGeminiReply +
        '</div>';
    }

    if (items.length > 0) {
      html +=
        '<div class="space-y-1.5">' +
        '<div class="text-[11px] font-semibold text-slate-400 flex items-center justify-between">' +
        '<span>Places Changed (click Remove on any place you want to undo):</span>' +
        (alreadyCount > 0
          ? '<span class="text-slate-500">' + alreadyCount + ' already marked (hidden)</span>'
          : '') +
        '</div>' +
        '<div class="divide-y divide-white/5 rounded-xl border border-white/10 bg-slate-900/60 max-h-72 overflow-y-auto">';

      items.forEach((item, idx) => {
        const isRemoved = !!item.removed;
        const catName = catLabels[item.category] || item.category || 'Place';
        let changeText = 'Added as Been';
        if (item.prev_status === 'bucket_list' && item.status === 'visited') {
          changeText = 'Converted from Want to Been';
        } else if (item.status === 'bucket_list') {
          changeText = 'Added as Want';
        } else if (item.status === 'unvisited') {
          changeText = 'Removed';
        }
        html +=
          '<div class="px-3 py-2 flex items-center justify-between gap-2 hover:bg-white/[0.02]">' +
          '<div class="min-w-0">' +
          '<div class="text-xs font-semibold ' +
          (isRemoved ? 'line-through text-slate-500' : 'text-white') +
          ' truncate">' +
          (item.flag_emoji || '📍') +
          ' ' +
          (item.name || item.id) +
          '</div>' +
          '<div class="text-[11px] text-slate-400 truncate">' +
          catName +
          ' · ' +
          (isRemoved
            ? '<span class="text-rose-400">Reverted</span>'
            : '<span class="text-emerald-400">' + changeText + '</span>') +
          '</div>' +
          '</div>' +
          (isRemoved
            ? '<button type="button" onclick="app.toggleGeminiLoggedPlace(' +
              idx +
              ')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/30 text-[11px] font-semibold shrink-0">↩️ Restore</button>'
            : '<button type="button" onclick="app.toggleGeminiLoggedPlace(' +
              idx +
              ')" class="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 text-[11px] font-semibold shrink-0">✕ Remove</button>') +
          '</div>';
      });

      html += '</div></div>';
    } else if (alreadyCount > 0) {
      html +=
        '<div class="text-emerald-300 text-xs">✓ All ' +
        alreadyCount +
        ' matched place' +
        (alreadyCount === 1 ? ' was' : 's were') +
        ' already marked as Been — no new changes needed!</div>';
    } else {
      html +=
        '<div class="text-amber-300 text-xs">No matching catalog places were found in your message. Try mentioning specific city names, national parks, UNESCO sites, or landmarks!</div>';
    }

    if (unresolved.length > 0) {
      html +=
        '<div class="text-[11px] text-slate-400 pt-1">Could not match: <span class="text-slate-300">' +
        unresolved.join(', ') +
        '</span></div>';
    }

    resultsBox.classList.remove('hidden');
    resultsBox.innerHTML = html;
  }

  async toggleGeminiLoggedPlace(index) {
    if (!this.lastGeminiLoggedItems || !this.lastGeminiLoggedItems[index]) return;
    const item = this.lastGeminiLoggedItems[index];
    const nextRemoved = !item.removed;
    const targetStatus = nextRemoved
      ? item.prev_status || 'unvisited'
      : item.status || 'visited';

    item.removed = nextRemoved;
    this.renderGeminiBatchResults();

    await this.setPlaceStatusDirect(item.id, targetStatus);
    this.renderGeminiBatchResults();
  }

  startVoiceDictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert('Use the microphone icon on your Android keyboard to dictate!');
      return;
    }
    const rec = new SR();
    rec.lang = 'en-US';
    const micBtn = document.getElementById('mic-btn');
    micBtn.textContent = '🔴';
    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      document.getElementById('gemini-input').value = transcript;
      micBtn.textContent = '🎙️';
      this.askGemini();
    };
    rec.onerror = () => {
      micBtn.textContent = '🎙️';
    };
    rec.onend = () => {
      micBtn.textContent = '🎙️';
    };
    rec.start();
  }
}

const app = new PlacesTrackerClient(window.__NATURAL_EARTH_NAME_MAP__);
app.init();

