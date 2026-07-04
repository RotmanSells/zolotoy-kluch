// ==UserScript==
// @name         Yandex Maps: Full Contacts Scraper
// @namespace    https://tampermonkey.net/
// @version      3.1.0
// @description  Собирает ссылки организаций, парсит карточки и отправляет контакты в дашборд.
// @author       you
// @match        *://yandex.ru/maps/*
// @match        *://yandex.com/maps/*
// @match        *://yandex.com.tr/maps/*
// @match        *://yandex.kz/maps/*
// @match        *://yandex.by/maps/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Защита от повторного инжекта в SPA
  if (window.__ymcScraperLoaded) return;
  window.__ymcScraperLoaded = true;

  // ==================== КОНФИГУРАЦИЯ ====================
  const DEFAULT_API = 'http://127.0.0.1:3210/api/batch';
  const DEFAULT_TOKEN = 'dev_token_2026';

  const savedApi = typeof GM_getValue === 'function' ? GM_getValue('api_endpoint', '') : '';
  const savedToken = typeof GM_getValue === 'function' ? GM_getValue('api_token', '') : '';

  const API_ENDPOINT = savedApi || DEFAULT_API;
  const API_TOKEN = savedToken || DEFAULT_TOKEN;

  const CONFIG = {
    // Скролл
    WAIT_AFTER_SCROLL_BASE_MS: 180,
    MAX_WAIT_FOR_NEW_CARDS_MS: 2200,
    POLL_NEW_CARDS_MS: 110,
    SCROLL_STEP_RATIO: 0.92,
    MAX_STABLE_CYCLES: 30,
    MIN_SCROLL_HEIGHT: 500,
    OBSERVER_DEBOUNCE_MS: 60,
    MAX_RETRIES: 3,
    DEBUG_HIGHLIGHT: false,
    COLLECT_THROTTLE_MS: 20,
    DEDUPE_WINDOW_SIZE: 50000,

    // Парсинг карточек
    PARSE_CONCURRENCY: 2,
    PARSE_DELAY_MS: 1200,
    PARSE_RANDOM_EXTRA_MS: 1300,
    PARSE_TIMEOUT_MS: 15000,
    CAPTCHA_PAUSE_MS: 60000,

    // Отправка
    SEND_BATCH_SIZE: 30,
    SEND_TIMEOUT_MS: 30000,
    SEND_MAX_RETRIES: 4,
    RETRY_BACKOFF: { min: 1000, max: 15000, multiplier: 2 },
  };

  const BLOCKED_WEBSITE_RE = /(?:^https?:\/\/)?(?:www\.)?vk\.com\/yandex\.maps(?:[/?#]|$)/i;

  // ==================== ГЛОБАЛЬНОЕ СОСТОЯНИЕ ====================
  const state = {
    running: false,
    stopRequested: false,
    captchaPause: false,
    totalCollected: 0,
    totalParsed: 0,
    totalUploaded: 0,
    totalFailed: 0,
    totalSkipped: 0,
    totalCaptcha: 0,
    recentOrgIds: new Set(),
    recentOrgQueue: [],
    parsedBatch: [],
    pendingOrgIds: new Set(),
    parseQueue: [],
    loops: 0,
    stableCycles: 0,
    parseWorkerActive: false,
    mutationObserver: null,
    scrollContainer: null,
    currentStatus: 'idle',
    currentDetail: '',
    ui: {},
    startTime: 0,
  };

  // ==================== УТИЛИТЫ ====================
  function ts() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  function log(...args) {
    console.log(`[YMC-${ts().slice(11, 19)}]`, ...args);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomDelay() {
    return CONFIG.PARSE_DELAY_MS + Math.random() * CONFIG.PARSE_RANDOM_EXTRA_MS;
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function safe(value, fallback = '-') {
    const text = normalize(value);
    return text || fallback;
  }

  function extractDescriptionFromState(html) {
    const m = html.match(/"review_text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
      try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
    }
    const m2 = html.match(/"previewData"\s*:\s*\{[^}]*"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m2) {
      try { return JSON.parse(`"${m2[1]}"`); } catch { return m2[1]; }
    }
    return '';
  }

  function extractLogoFromState(html) {
    const patterns = [
      /"logo"\s*:\s*\{[^}]*?"urlTemplate"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"logo"\s*:\s*\{[^}]*?"url"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"logo"\s*:\s*\{[^}]*?"src"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"logo"\s*:\s*\{[^}]*?"href"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"vendorLogo"\s*:\s*\{[^}]*?"urlTemplate"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) {
        let url;
        try { url = JSON.parse(`"${m[1]}"`); } catch { url = m[1]; }
        url = url.replace(/\/%s$/, '/orig');
        return url;
      }
    }
    return '';
  }

  function extractPhotosFromDoc(doc) {
    const photos = [];
    const selectors = [
      '.card-photos-carousel__item img.img-with-alt',
      '.card-header-media-view__media img',
      '.business-story-entry-view img',
      '.orgpage-header-view img[src*="avatars"]',
    ];
    for (const sel of selectors) {
      doc.querySelectorAll(sel).forEach(img => {
        if (photos.length >= 10) return;
        const src = img.getAttribute('src') || '';
        if (src && !photos.includes(src)) photos.push(src);
      });
      if (photos.length > 0) break;
    }
    if (photos.length === 0) {
      const ogImage = doc.querySelector('meta[property="og:image"]');
      if (ogImage) {
        const content = ogImage.getAttribute('content') || '';
        if (content) photos.push(content);
      }
    }
    return photos.length > 0 ? photos : null;
  }

  function extractPhotosFromState(html) {
    const photos = [];
    const seen = new Set();

    const photosBlock = html.match(/"photos"\s*:\s*\{"count"\s*:\d+,"items"\s*:\[((?:[^\[\]]|"urlTemplate"[^\[\]]*)*)\]/);
    if (photosBlock) {
      const items = photosBlock[1].matchAll(/"urlTemplate"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
      for (const m of items) {
        if (photos.length >= 10) break;
        let url;
        try { url = JSON.parse(`"${m[1]}"`); } catch { url = m[1]; }
        url = url.replace(/\/%s$/, '/orig');
        if (!seen.has(url)) { seen.add(url); photos.push(url); }
      }
    }

    if (photos.length === 0) {
      const mediaMatches = html.matchAll(/"media"\s*:\s*\[(.*?)\]/gs);
      for (const block of mediaMatches) {
        const urls = block[1].matchAll(/"urlTemplate"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
        for (const m of urls) {
          if (photos.length >= 10) break;
          let url;
          try { url = JSON.parse(`"${m[1]}"`); } catch { url = m[1]; }
          url = url.replace(/\/%s$/, '/orig');
          if (!seen.has(url)) { seen.add(url); photos.push(url); }
        }
        if (photos.length > 0) break;
      }
    }

    return photos.length > 0 ? photos : null;
  }

  function rememberRecentOrgId(orgId) {
    if (!orgId) return;
    if (!state.recentOrgIds.has(orgId)) {
      state.recentOrgIds.add(orgId);
      state.recentOrgQueue.push(orgId);
    }
    while (state.recentOrgQueue.length > CONFIG.DEDUPE_WINDOW_SIZE) {
      const oldest = state.recentOrgQueue.shift();
      if (oldest) state.recentOrgIds.delete(oldest);
    }
  }

  // ==================== ПАРСИНГ КАРТОЧКИ ====================
  function parseOrgPageHtml(html, orgUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const name = findText(doc, [
      '[itemprop="name"]',
      '.business-card-title-view__title',
      '.orgpage-header-view__header',
      'h1',
    ]);

    let description = findText(doc, [
      '.business-story-entry-view__description',
      '.business-story-text-view__text',
      '.orgpage-header-view__description',
      '.business-contacts-view__description',
    ]);
    if (!description) description = extractDescriptionFromState(html);

    const photos = extractPhotosFromDoc(doc) || extractPhotosFromState(html) || [];

    const address = findAttr(doc, ['meta[itemprop="address"]', 'meta[property="og:street-address"]'], 'content')
      || findText(doc, [
        '.business-contacts-view__address-link',
        '.orgpage-header-view__address',
        '[data-testid="address"]',
      ]);

    const website = findAttr(doc, [
      '.business-urls-view__link',
      'a[href*="http"][data-type="website"]',
    ], 'href');

    const phone = extractPhoneFromDoc(doc);
    const { telegram, whatsapp, vk, max } = extractSocialFromDoc(doc);

    let logo = extractLogoFromState(html);
    if (!logo) logo = findAttr(doc, [
      '.card-header-media-view__logo img',
      '.orgpage-header-view__logo img',
      'img[alt="Логотип"]',
    ], 'src');
    if (logo) logo = logo.replace(/\/[A-Z]+_height$/, '/orig');
    if (!logo) {
      const ogImage = doc.querySelector('meta[itemprop="image"]') || doc.querySelector('meta[property="og:image"]');
      if (ogImage) logo = (ogImage.getAttribute('content') || '').replace(/\/[A-Z]+_height$/, '/orig');
    }

    const orgIdMatch = (orgUrl || '').match(/\/org\/(?:[^/]+\/)?(\d+)/i);
    const orgId = orgIdMatch ? orgIdMatch[1] : '';

    return {
      id: safe(orgId),
      org_url: safe(orgUrl),
      name: safe(name),
      description: safe(description),
      address: safe(address),
      phone: safe(phone),
      website: safe(website),
      telegram: safe(telegram),
      whatsapp: safe(whatsapp),
      vk: safe(vk),
      max: safe(max),
      logo: safe(logo),
      photos: photos.length > 0 ? photos.join('|') : '-',
      saved_at: new Date().toISOString(),
      source: 'sbor-3.1',
    };
  }

  function findText(doc, selectors) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const text = normalize(el.textContent);
        if (text) return text;
      }
    }
    return '';
  }

  function findAttr(doc, selectors, attr) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const val = normalize(el.getAttribute(attr));
        if (val) return val;
      }
    }
    return '';
  }

  function extractPhoneFromDoc(doc) {
    const seen = new Set();
    const phoneSelectors = [
      '[itemprop="telephone"]',
      '[data-testid="phone-number"]',
      '.card-phones-view__phone-number',
      '.card-phones-view__number',
      '.orgpage-phones-view__phone-number',
      'a[href^="tel:"]',
    ];

    for (const sel of phoneSelectors) {
      const nodes = doc.querySelectorAll(sel);
      nodes.forEach(node => {
        let raw = node.getAttribute('href') || '';
        if (raw.startsWith('tel:')) raw = raw.slice(4);
        if (!raw) raw = node.textContent || '';
        const cleaned = normalize(raw).replace(/\D/g, '');
        if (cleaned.length >= 10) {
          let phone = normalize(raw);
          if (cleaned.length === 11 && cleaned.startsWith('8')) {
            phone = `+7${cleaned.slice(1)}`;
          } else if (cleaned.length >= 10) {
            phone = `+${cleaned}`;
          }
          const key = phone.replace(/\D/g, '');
          if (!seen.has(key)) seen.add(key);
        }
      });
    }

    const phones = [...seen];
    return phones.length > 0 ? phones[0] : '';
  }

  function extractSocialFromDoc(doc) {
    let telegram = '';
    let whatsapp = '';
    let vk = '';
    let max = '';
    const socialSelectors = [
      '.business-contacts-view__social-button a',
      '[data-testid="social-link"]',
      'a[href*="t.me/"]',
      'a[href*="telegram.me/"]',
      'a[href*="wa.me/"]',
      'a[href*="whatsapp"]',
      'a[href*="vk.com/"]',
      'a[href*="max.ru/"]',
    ];

    for (const sel of socialSelectors) {
      const nodes = doc.querySelectorAll(sel);
      nodes.forEach(node => {
        const href = normalize(node.getAttribute('href') || node.href || '');
        if (!href) return;
        const lower = href.toLowerCase();
        if (!telegram && (lower.includes('t.me/') || lower.includes('telegram.me/'))) {
          telegram = href;
        }
        if (!whatsapp && (lower.includes('wa.me/') || lower.includes('whatsapp'))) {
          whatsapp = href;
        }
        if (!vk && lower.includes('vk.com/')) {
          vk = href;
        }
        if (!max && lower.includes('max.ru/')) {
          max = href;
        }
      });
    }

    return {
      telegram: telegram || '-',
      whatsapp: whatsapp || '-',
      vk: vk || '-',
      max: max || '-',
    };
  }

  function hasRealWebsite(item) {
    const site = normalize(item?.website || '');
    if (!site || site === '-') return false;
    return !BLOCKED_WEBSITE_RE.test(site);
  }

  // ==================== СБОР ССЫЛОК ИЗ ВЫДАЧИ ====================
  function findScrollContainer() {
    const selectors = [
      '.search-list-view__list',
      '[data-testid="scroll-container"]',
      '.scroll__container',
      '.sidebar__scroll',
      '.sidebar-view',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight * 1.2) return el;
    }

    // Fallback: ищем div с overflow:auto и большим scrollHeight
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      if (div.scrollHeight > div.clientHeight * 1.5) {
        const style = getComputedStyle(div);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          return div;
        }
      }
    }

    return document.scrollingElement || document.documentElement;
  }

  function canonicalizeOrgUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      const match = url.pathname.match(/\/org\/(?:[^/]+\/)?(\d+)(?:\/|$)/i);
      if (!match) return null;
      const orgId = match[1];
      return {
        orgId,
        orgUrl: `https://yandex.ru/maps/org/${orgId}/`,
      };
    } catch (e) {
      return null;
    }
  }

  let lastCollectionTime = 0;
  function collectVisibleLinks() {
    const now = Date.now();
    if (now - lastCollectionTime < CONFIG.COLLECT_THROTTLE_MS) return 0;
    lastCollectionTime = now;

    const scope = state.scrollContainer || findScrollContainer() || document;
    let nodes = scope.querySelectorAll('a[href*="/org/"]:not([href*="review"])');
    if (!nodes || nodes.length === 0) {
      nodes = document.querySelectorAll('a[href*="/org/"]:not([href*="review"])');
    }
    let added = 0;

    for (const node of nodes) {
      const href = node.href || node.getAttribute('href') || '';
      const normalized = canonicalizeOrgUrl(href);
      if (!normalized) continue;
      if (state.pendingOrgIds.has(normalized.orgId)) continue;
      if (state.recentOrgIds.has(normalized.orgId)) continue;

      state.parseQueue.push({ orgId: normalized.orgId, orgUrl: normalized.orgUrl });
      state.pendingOrgIds.add(normalized.orgId);
      state.totalCollected += 1;
      rememberRecentOrgId(normalized.orgId);
      added++;
    }

    if (added > 0) {
      log(`+${added} ссылок (всего: ${state.totalCollected})`);
      state.stableCycles = 0;
    }
    return added;
  }

  async function collectAfterScrollWindow(scrolled) {
    const deadline = Date.now() + (scrolled ? CONFIG.MAX_WAIT_FOR_NEW_CARDS_MS : Math.floor(CONFIG.MAX_WAIT_FOR_NEW_CARDS_MS * 1.3));
    let idleTicks = 0;

    while (!state.stopRequested && Date.now() < deadline) {
      const added = collectVisibleLinks();
      idleTicks = added > 0 ? 0 : idleTicks + 1;
      if (idleTicks >= 3) break;
      await sleep(CONFIG.POLL_NEW_CARDS_MS);
    }
  }

  // ==================== HTTP-ЗАПРОСЫ ====================
  function gmFetch(url) {
    return new Promise((resolve) => {
      let completed = false;
      const timeout = setTimeout(() => {
        if (!completed) { completed = true; resolve({ ok: false, error: 'TIMEOUT' }); }
      }, CONFIG.PARSE_TIMEOUT_MS);

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        onload: (resp) => {
          if (completed) return;
          completed = true;
          clearTimeout(timeout);
          if (resp.status >= 200 && resp.status < 400) {
            resolve({ ok: true, html: resp.responseText });
          } else {
            resolve({ ok: false, error: `HTTP_${resp.status}` });
          }
        },
        onerror: () => {
          if (completed) return;
          completed = true;
          clearTimeout(timeout);
          resolve({ ok: false, error: 'NETWORK_ERROR' });
        },
        ontimeout: () => {
          if (completed) return;
          completed = true;
          clearTimeout(timeout);
          resolve({ ok: false, error: 'TIMEOUT' });
        },
      });
    });
  }

  function isCaptchaHtml(html) {
    if (!html) return false;
    const lower = html.toLowerCase();
    return lower.includes('showcaptcha')
      || lower.includes('smartcaptcha')
      || lower.includes('checkcaptcha')
      || (lower.includes('капча') && lower.includes('доступ ограничен'));
  }

  function gmPost(url, body) {
    return new Promise((resolve) => {
      let completed = false;
      const timeout = setTimeout(() => {
        if (!completed) { completed = true; resolve({ ok: false, error: 'TIMEOUT' }); }
      }, CONFIG.SEND_TIMEOUT_MS);

      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (API_TOKEN) {
        headers.Authorization = `Bearer ${API_TOKEN}`;
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers,
        data: JSON.stringify(body),
        onload: (resp) => {
          if (completed) return;
          completed = true;
          clearTimeout(timeout);
          let payload = {};
          try { payload = JSON.parse(resp.responseText || '{}'); } catch (_) {}
          if (resp.status >= 200 && resp.status < 300) {
            resolve({ ok: true, payload });
          } else {
            resolve({ ok: false, error: `HTTP_${resp.status}`, payload });
          }
        },
        onerror: () => {
          if (completed) return;
          completed = true;
          clearTimeout(timeout);
          resolve({ ok: false, error: 'NETWORK_ERROR' });
        },
        ontimeout: () => {
          if (completed) return;
          completed = true;
          clearTimeout(timeout);
          resolve({ ok: false, error: 'TIMEOUT' });
        },
      });
    });
  }

  // ==================== ПАРСЕР КАРТОЧЕК ====================
  async function parseOneOrg(task) {
    const { orgId, orgUrl } = task;

    // Если был стоп из-за капчи — ждём
    while (state.captchaPause && !state.stopRequested) {
      await sleep(5000);
    }
    if (state.stopRequested) return null;

    const result = await gmFetch(orgUrl);
    if (!result.ok) {
      state.totalFailed++;
      log(`❌ [${orgId}] ${result.error}`);
      return null;
    }

    // Проверка на капчу
    if (isCaptchaHtml(result.html)) {
      state.totalCaptcha++;
      state.captchaPause = true;
      log(`🛑 [${orgId}] КАПЧА! Пауза ${CONFIG.CAPTCHA_PAUSE_MS / 1000}с...`);
      updateUI('error', `КАПЧА! Пауза ${CONFIG.CAPTCHA_PAUSE_MS / 1000}с`);
      await sleep(CONFIG.CAPTCHA_PAUSE_MS);
      state.captchaPause = false;
      log('▶️ Возобновляем парсинг...');
      return null;
    }

    let item;
    try {
      item = parseOrgPageHtml(result.html, orgUrl);
    } catch (e) {
      state.totalFailed++;
      log(`❌ [${orgId}] ошибка парсинга: ${e.message}`);
      return null;
    }

    if (!item.name || item.name === '-') {
      state.totalFailed++;
      log(`❌ [${orgId}] нет данных (html ${result.html.length} bytes, name="${item.name}")`);
      return null;
    }

    if (hasRealWebsite(item)) {
      state.totalSkipped++;
      log(`⏭ [${orgId}] "${item.name}" — есть сайт, пропуск`);
      return null;
    }

    state.totalParsed++;
    log(`✅ [${orgId}] ${item.name} | ${item.phone !== '-' ? item.phone : 'нет тел.'}`);
    return item;
  }

  async function parseWorker() {
    if (state.parseWorkerActive) return;
    state.parseWorkerActive = true;

    try {
      log(`🔧 Парсер стартовал. В очереди: ${state.parseQueue.length}`);
      while (state.running && !state.stopRequested) {
        if (state.parseQueue.length === 0) {
          await sleep(200);
          continue;
        }

        const batch = state.parseQueue.splice(0, CONFIG.PARSE_CONCURRENCY);
        log(`⏳ Парсим ${batch.length} org (осталось: ${state.parseQueue.length})`);
        const results = await Promise.allSettled(batch.map(t => parseOneOrg(t)));

        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) state.parsedBatch.push(r.value);
        }

        if (state.parsedBatch.length >= CONFIG.SEND_BATCH_SIZE) {
          await sendContacts();
        }

        await sleep(randomDelay());
      }
      log(`🔧 Парсер завершён. Спарсено: ${state.totalParsed}, отправлено: ${state.totalUploaded}`);
    } catch (e) {
      log('❌ Ошибка парсера:', e.message);
    } finally {
      state.parseWorkerActive = false;
    }
  }

  // ==================== ОТПРАВКА КОНТАКТОВ ====================
  async function sendContacts() {
    if (state.parsedBatch.length === 0) return;

    const items = state.parsedBatch.splice(0, CONFIG.SEND_BATCH_SIZE);
    log(`📤 Отправляем ${items.length} контактов...`);
    for (let attempt = 1; attempt <= CONFIG.SEND_MAX_RETRIES; attempt++) {
      const result = await gmPost(API_ENDPOINT, {
        source: 'sbor-3.1',
        items,
      });

      if (result.ok) {
        state.totalUploaded += items.length;
        log(`📤 OK! Отправлено ${items.length} (всего: ${state.totalUploaded})`);
        return;
      }

      log(`⚠️ Попытка ${attempt}/${CONFIG.SEND_MAX_RETRIES}: ${result.error}`);
      if (attempt < CONFIG.SEND_MAX_RETRIES) {
        const delay = Math.min(
          CONFIG.RETRY_BACKOFF.max,
          CONFIG.RETRY_BACKOFF.min * Math.pow(CONFIG.RETRY_BACKOFF.multiplier, attempt - 1)
        );
        await sleep(delay);
      }
    }

    state.totalFailed += items.length;
    log(`❌ Не удалось отправить ${items.length} контактов`);
  }

  // ==================== SCROLL ====================
  async function scrollStep(retry = 0) {
    if (state.stopRequested) return false;
    const scroller = findScrollContainer();
    state.scrollContainer = scroller;

    if (!scroller) {
      window.scrollBy(0, Math.max(CONFIG.MIN_SCROLL_HEIGHT, window.innerHeight * CONFIG.SCROLL_STEP_RATIO));
      return true;
    }

    const prevTop = scroller.scrollTop;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight - 100;
    if (prevTop >= maxScroll) return false;

    const step = Math.max(CONFIG.MIN_SCROLL_HEIGHT, Math.floor(scroller.clientHeight * CONFIG.SCROLL_STEP_RATIO));
    scroller.scrollTop = prevTop + step;

    await sleep(100);
    if (Math.abs(scroller.scrollTop - prevTop) < 10) {
      if (retry < CONFIG.MAX_RETRIES) {
        await sleep(300);
        return scrollStep(retry + 1);
      }
      return false;
    }
    return true;
  }

  function setupMutationObserver() {
    if (state.mutationObserver) return;
    let debounceTimer = null;
    state.mutationObserver = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (state.running) collectVisibleLinks();
      }, CONFIG.OBSERVER_DEBOUNCE_MS);
    });
    const target = document.querySelector('.search-list-view') || document.querySelector('.sidebar-view') || document.body;
    state.mutationObserver.observe(target, { childList: true, subtree: true });
  }

  function destroyMutationObserver() {
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
      state.mutationObserver = null;
    }
  }

  // ==================== UI ====================
  function updateUI(status, detail = '') {
    if (!state.ui.statusEl) return;
    state.currentStatus = status;
    state.currentDetail = detail;

    state.ui.statusEl.textContent = detail || status;
    state.ui.statusEl.style.color = '#fff';
    state.ui.statusEl.style.background =
      status === 'running' ? 'rgba(35,134,54,0.8)' :
      status === 'error' ? 'rgba(218,54,51,0.8)' :
      status === 'stopping' ? 'rgba(210,153,34,0.8)' :
      'rgba(0,0,0,0.3)';

    if (state.ui.countEl) state.ui.countEl.textContent = state.totalCollected;
    if (state.ui.parsedEl) state.ui.parsedEl.textContent = state.totalParsed;
    if (state.ui.sentEl) state.ui.sentEl.textContent = state.totalUploaded;
    if (state.ui.skippedEl) state.ui.skippedEl.textContent = state.totalSkipped;
    if (state.ui.failedEl) state.ui.failedEl.textContent = state.totalFailed;
    if (state.ui.queueEl) state.ui.queueEl.textContent = state.parseQueue.length;
    state.ui.startBtn.disabled = state.running;
    state.ui.stopBtn.disabled = !state.running;
  }

  // ==================== ГЛАВНЫЙ ЦИКЛ ====================
  async function runCollection() {
    if (state.running) return;

    try {
      state.running = true;
      state.stopRequested = false;
      state.captchaPause = false;
      state.stableCycles = 0;
      state.loops = 0;
      state.totalCollected = 0;
      state.totalParsed = 0;
      state.totalUploaded = 0;
      state.totalFailed = 0;
      state.totalSkipped = 0;
      state.totalCaptcha = 0;
      state.parseQueue = [];
      state.parsedBatch = [];
      state.parseWorkerActive = false;
      state.startTime = Date.now();

      updateUI('running', 'инициализация...');
      collectVisibleLinks();
      await sleep(300);
      setupMutationObserver();

      void parseWorker();

      const startTime = Date.now();

      while (!state.stopRequested) {
        state.loops++;
        const scrolled = await scrollStep();
        const waitMs = scrolled ? CONFIG.WAIT_AFTER_SCROLL_BASE_MS : Math.floor(CONFIG.WAIT_AFTER_SCROLL_BASE_MS * 2);
        await sleep(waitMs);

        const baseline = state.totalCollected;
        await collectAfterScrollWindow(scrolled);
        const added = state.totalCollected - baseline;

        if (added === 0) {
          state.stableCycles++;
        } else {
          state.stableCycles = 0;
        }

        const nearBottom = state.scrollContainer?.scrollTop >=
          (state.scrollContainer.scrollHeight - state.scrollContainer.clientHeight - 100);

        updateUI('running',
          `скролл ${state.loops} | ссылок: ${state.totalCollected} | очередь: ${state.parseQueue.length} | контактов: ${state.totalUploaded}`);

        if (state.stopRequested) break;
        if (state.stableCycles >= CONFIG.MAX_STABLE_CYCLES) {
          log('✅ Достигнут конец выдачи');
          break;
        }
        if (Date.now() - startTime > 900000) break;
      }

      // Ждём пока парсер дойстрает
      updateUI('running', 'парсинг оставшихся карточек...');
      while (state.parseQueue.length > 0 && !state.stopRequested) {
        await sleep(500);
      }
      await sleep(1000);
      await sendContacts();

    } catch (e) {
      console.error('[YMC] ОШИБКА:', e);
      GM_notification?.({ title: '❌ Ошибка', text: e.message, timeout: 5000 });
    } finally {
      state.running = false;
      destroyMutationObserver();

      const duration = ((Date.now() - state.startTime) / 1000).toFixed(1);
      updateUI('idle',
        `Готово за ${duration}с | ссылок: ${state.totalCollected} | контактов: ${state.totalUploaded}`);

      if (state.totalUploaded > 0) {
        GM_notification?.({
          title: '✅ Готово',
          text: `Ссылок: ${state.totalCollected}, контактов: ${state.totalUploaded}, ошибок: ${state.totalFailed}, капча: ${state.totalCaptcha}`,
          timeout: 5000,
        });
      }
    }
  }

  function createControlPanel() {
    const panel = document.createElement('div');
    panel.id = 'ymc-control-panel';
    panel.style.cssText = `
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483647;
      width: 320px;
      background: linear-gradient(145deg, #0d1117, #161b22);
      color: #c9d1d9;
      border: 1px solid #30363d;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      overflow: hidden;
    `;

    panel.innerHTML = `
      <div style="background:linear-gradient(90deg,#238636,#2ea043);padding:12px 16px;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:700;font-size:15px;color:#fff;">🗺 gMaps Scraper</div>
        <div id="ymc-status" style="font-size:11px;background:rgba(0,0,0,0.3);padding:3px 8px;border-radius:12px;color:#fff;">idle</div>
      </div>
      <div style="padding:14px 16px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px;line-height:1.8;">
          <div style="color:#8b949e;">Ссылок</div><div style="text-align:right;color:#58a6ff;font-weight:600;" id="ymc-count">0</div>
          <div style="color:#8b949e;">Спарсено</div><div style="text-align:right;color:#3fb950;font-weight:600;" id="ymc-parsed">0</div>
          <div style="color:#8b949e;">Отправлено</div><div style="text-align:right;color:#3fb950;font-weight:600;" id="ymc-sent">0</div>
          <div style="color:#8b949e;">Пропущено</div><div style="text-align:right;color:#d29922;font-weight:600;" id="ymc-skipped">0</div>
          <div style="color:#8b949e;">Ошибок</div><div style="text-align:right;color:#f85149;font-weight:600;" id="ymc-failed">0</div>
          <div style="color:#8b949e;">Очередь</div><div style="text-align:right;color:#c9d1d9;font-weight:600;" id="ymc-queue">0</div>
        </div>
        <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <button id="ymc-start" style="padding:10px;background:#238636;color:#fff;border:none;border-radius:6px;font-weight:700;font-size:13px;cursor:pointer;transition:background .15s;">▶ СТАРТ</button>
          <button id="ymc-stop" style="padding:10px;background:#da3633;color:#fff;border:none;border-radius:6px;font-weight:700;font-size:13px;cursor:pointer;transition:background .15s;" disabled>⏹ СТОП</button>
        </div>
        <div style="margin-top:8px;font-size:11px;color:#484f58;text-align:center;">v3.1 • anti-captcha + random delay</div>
      </div>
    `;

    document.body.appendChild(panel);

    state.ui.statusEl = panel.querySelector('#ymc-status');
    state.ui.countEl = panel.querySelector('#ymc-count');
    state.ui.parsedEl = panel.querySelector('#ymc-parsed');
    state.ui.sentEl = panel.querySelector('#ymc-sent');
    state.ui.skippedEl = panel.querySelector('#ymc-skipped');
    state.ui.failedEl = panel.querySelector('#ymc-failed');
    state.ui.queueEl = panel.querySelector('#ymc-queue');
    state.ui.startBtn = panel.querySelector('#ymc-start');
    state.ui.stopBtn = panel.querySelector('#ymc-stop');

    state.ui.startBtn.addEventListener('click', () => {
      if (!state.running) runCollection().catch(console.error);
    });

    state.ui.stopBtn.addEventListener('click', () => {
      state.stopRequested = true;
      updateUI('stopping', 'завершение...');
    });

    updateUI('idle');
    log('✅ Панель создана');
  }

  // ==================== ИНИЦИАЛИЗАЦИЯ ====================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createControlPanel);
  } else {
    createControlPanel();
  }

  log('🚀 Скрипт v3.1 загружен. Откройте Яндекс.Карты и нажмите СТАРТ');
})();
